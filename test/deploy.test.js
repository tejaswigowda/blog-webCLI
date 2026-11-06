import test from 'node:test';
import assert from 'node:assert/strict';
import { STALLED_MS, deployState, fmtClock, parseBuild, pollDeploy } from '../lib/deploy.js';
import { SOFT_LIMIT, WARN_AT, WINDOW_MS, assessBuilds, describeBuilds, noteBuild, recentBuilds } from '../lib/buildrate.js';

const SHA = 'a'.repeat(40);
const T0 = Date.parse('2026-11-06T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('deploy state: committed until a build for this commit appears, then building, then live with its time', () => {
  const at = (s, build) => deployState({ build, sha: SHA, since: T0, now: T0 + s * 1000 });
  assert.deepEqual(at(5, null), { state: 'committed', seconds: 5, stalled: false });
  // the latest build is an older one: not ours
  assert.equal(at(5, { status: 'built', commit: 'b'.repeat(40), created_at: iso(T0 - 600000), updated_at: iso(T0 - 590000) }).state, 'committed');
  assert.deepEqual(at(12, { status: 'queued', commit: SHA, created_at: iso(T0 + 8000), updated_at: iso(T0 + 8000) }), { state: 'building', seconds: 12 });
  assert.equal(at(20, { status: 'building', commit: SHA, created_at: iso(T0 + 8000), updated_at: iso(T0 + 9000) }).state, 'building');
  const live = at(60, { status: 'built', commit: SHA, created_at: iso(T0 + 8000), updated_at: iso(T0 + 34000) });
  assert.deepEqual(live, { state: 'live', seconds: 34 });
  assert.equal(fmtClock(live.seconds), '0:34');
  assert.equal(fmtClock(125), '2:05');
});

test('deploy state: a failed build says why, in GitHub\'s words; a later build that finished also carries our commit', () => {
  const failed = deployState({ build: { status: 'errored', commit: SHA, created_at: iso(T0 + 5000), updated_at: iso(T0 + 9000), error: { message: 'Page build failed: unknown tag in index.html' } }, sha: SHA, since: T0, now: T0 + 30000 });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'Page build failed: unknown tag in index.html');
  assert.equal(deployState({ build: { status: 'errored', commit: SHA, created_at: iso(T0 + 5000) }, sha: SHA, since: T0, now: T0 + 30000 }).error, 'GitHub did not say why.');
  // someone pushed after us and that build finished: our commit is in it
  assert.equal(deployState({ build: { status: 'built', commit: 'c'.repeat(40), created_at: iso(T0 + 40000), updated_at: iso(T0 + 70000) }, sha: SHA, since: T0, now: T0 + 90000 }).state, 'live');
  assert.equal(parseBuild(null), null);
});

test('deploy state: no build for three minutes is called out, because that is what throttling looks like', () => {
  assert.equal(deployState({ build: null, sha: SHA, since: T0, now: T0 + STALLED_MS - 1000 }).stalled, false);
  assert.equal(deployState({ build: null, sha: SHA, since: T0, now: T0 + STALLED_MS + 1000 }).stalled, true);
});

test('polling: reports each tick, stops at live, treats "no build yet" as committed, and an unreadable token as unknown', async () => {
  let now = T0;
  const seen = [];
  const script = [null, { status: 'queued', commit: SHA, created_at: iso(T0 + 4000) }, { status: 'building', commit: SHA, created_at: iso(T0 + 4000) }, { status: 'built', commit: SHA, created_at: iso(T0 + 4000), updated_at: iso(T0 + 34000) }];
  let i = 0;
  const done = await pollDeploy({
    getBuild: async () => script[i++],
    sha: SHA,
    since: T0,
    onState: (s) => seen.push(s.state),
    sleep: async (ms) => { now += ms; },
    now: () => now,
  });
  assert.deepEqual(seen, ['committed', 'building', 'building', 'live']);
  assert.equal(done.state, 'live');
  assert.equal(i, 4, 'no more requests after live');

  const notFound = Object.assign(new Error('x'), { status: 404 });
  const states = [];
  let n = 0;
  await pollDeploy({ getBuild: async () => { if (n++ < 2) throw notFound; return { status: 'built', commit: SHA, created_at: iso(T0 + 1000), updated_at: iso(T0 + 9000) }; }, sha: SHA, since: T0, onState: (s) => states.push(s.state), sleep: async (ms) => { now += ms; }, now: () => now });
  assert.deepEqual(states, ['committed', 'committed', 'live']);

  const forbidden = await pollDeploy({ getBuild: async () => { throw Object.assign(new Error('no'), { status: 403 }); }, sha: SHA, since: T0, onState: () => {}, sleep: async () => {}, now: () => now });
  assert.equal(forbidden.state, 'unknown');
  assert.match(forbidden.reason, /Pages: Read-only/);
});

test('polling: gives up after fifteen minutes with "unknown", never loops forever', async () => {
  let now = T0;
  const out = await pollDeploy({ getBuild: async () => null, sha: SHA, since: T0, onState: () => {}, sleep: async (ms) => { now += ms; }, now: () => now });
  assert.equal(out.state, 'unknown');
  assert.match(out.reason, /15 minutes/);
});

// ---------- F: the build-rate limit ----------
const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
};

test('L10: the warning comes before the limit: from the publish that would be build 8, not after build 10', () => {
  assert.equal(WARN_AT, 8);
  assert.equal(SOFT_LIMIT, 10);
  const levels = Array.from({ length: 12 }, (_, made) => assessBuilds(made).level);
  assert.deepEqual(levels, ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'warn', 'warn', 'warn', 'limit', 'limit']);
  // the first warning is while two builds are still to spare
  assert.equal(levels.indexOf('warn'), 7);
  assert.ok(levels.indexOf('warn') < levels.indexOf('limit'));
  assert.equal(describeBuilds(assessBuilds(3)), '', 'nothing to say while there is room');
});

test('the warning says what the reader still gets: readers of a live-rendering blog lose nothing', () => {
  const warn = describeBuilds(assessBuilds(7), { readersSeeIt: true });
  assert.match(warn, /build 8 in the last hour/);
  assert.match(warn, /about 10 an hour/);
  assert.match(warn, /Readers still see what you publish/);
  assert.match(warn, /Link previews and search engines wait/);
  const plain = describeBuilds(assessBuilds(7), { readersSeeIt: false });
  assert.match(plain, /readers will not see changes/);
  const limit = describeBuilds(assessBuilds(10), { readersSeeIt: true });
  assert.match(limit, /10 builds in the last hour/);
  assert.match(limit, /probably stopped building/);
});

test('builds are counted per repository over a trailing hour, and a broken store is not an error', () => {
  const store = memory();
  const t = Date.parse('2026-11-06T10:00:00Z');
  for (let i = 0; i < 8; i++) noteBuild(store, 'me/blog', t + i * 60000);
  noteBuild(store, 'me/other', t);
  assert.equal(recentBuilds(store, 'me/blog', t + 8 * 60000).length, 8);
  assert.equal(recentBuilds(store, 'me/other', t + 8 * 60000).length, 1);
  // the oldest fall out of the window as the hour moves on
  assert.equal(recentBuilds(store, 'me/blog', t + WINDOW_MS + 30000).length, 7);
  assert.equal(recentBuilds(store, 'me/blog', t + WINDOW_MS * 3).length, 0);
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.deepEqual(recentBuilds(broken, 'me/blog'), []);
  assert.doesNotThrow(() => noteBuild(broken, 'me/blog'));
  assert.deepEqual(recentBuilds({ getItem: () => 'not json', setItem() {} }, 'x'), []);
});

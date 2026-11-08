// Scheduled publishing (gates N1–N8): `scheduled` is a draft with a time, invisible everywhere a draft is, with its extension runs
// recorded when it is scheduled, and a CLI step (run by a workflow) that publishes what is due, once, or refuses and says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildSite, parsePost, renderPost, validateBlog } from '../lib/blog.js';
import { buildSiteWith } from '../lib/build-async.js';
import { loadExtension, extensionFilePaths, parseOutputsFile, pinForExtension } from '../lib/extensions.js';
import { filesDigest } from '../lib/pin.js';
import { renderFromSite, loadSite } from '../lib/live-render.js';
import { daysUntil, dueOf, instantOf, publishText, SCHEDULE_WARN_DAYS } from '../lib/schedule.js';
import { splitFile, parseMeta } from '../lib/frontmatter.js';
import { DEFAULT_CONTENT_BASE } from '../lib/init.js';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { executePlan, planChange } from '../app/site.js';
import { fakeGitHub } from './fake-github.js';
import { Refusal } from '../lib/errors.js';
import { EX, localRunner, readDirFiles } from './helpers.js';

const run = promisify(execFile);
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const BLOG = { title: 'T', description: 'D', author: 'A', domain: 'https://example.test/blog', repo: 'me/blog', search: true };
const post = (slug, o = {}) => ({ path: `posts/${slug}.md`, text: `---\nslug: ${slug}\ntitle: Title of ${slug}\ndate: ${o.date || '2026-01-01'}\ntags: [t]\nstatus: ${o.status || 'published'}\n${o.publish_at ? `publish_at: ${o.publish_at}\n` : ''}${o.aliases ? `aliases: ${o.aliases}\n` : ''}---\n\nBody of ${slug} MARK-${slug}.\n` });
const code = (c) => (e) => e instanceof Refusal && e.code === c;

test('frontmatter: scheduled needs a real publish_at; publish_at belongs to scheduled only; a page cannot be scheduled', () => {
  assert.equal(parsePost(post('a', { status: 'scheduled', publish_at: '2026-11-08T09:00' })).status, 'scheduled');
  for (const bad of [undefined, '2026-11-08', '2026-11-08T25:00', '2026-02-30T09:00', 'tomorrow', '2026-11-08T09:00:00Z']) {
    assert.throws(() => parsePost(post('a', { status: 'scheduled', publish_at: bad })), code('bad-frontmatter'), String(bad));
  }
  assert.throws(() => parsePost(post('a', { status: 'published', publish_at: '2026-11-08T09:00' })), code('bad-frontmatter'));
  assert.throws(() => parsePost(post('a', { status: 'draft', publish_at: '2026-11-08T09:00' })), code('bad-frontmatter'));
  assert.throws(() => parsePost({ path: 'pages/p.md', text: '---\nslug: p\ntitle: P\nstatus: scheduled\npublish_at: 2026-11-08T09:00\n---\n\nx\n' }), code('bad-frontmatter'));
  assert.throws(() => parsePost(post('a', { status: 'soon' })), /draft", "scheduled" or "published/);
});

test('N4: publish_at is a wall clock in blog.json\'s timezone; with none it is UTC', () => {
  assert.equal(new Date(instantOf('2026-11-08T09:00', 'America/Phoenix')).toISOString(), '2026-11-08T16:00:00.000Z', 'Phoenix is UTC-7 all year');
  assert.equal(new Date(instantOf('2026-11-08T09:00')).toISOString(), '2026-11-08T09:00:00.000Z');
  assert.equal(new Date(instantOf('2026-07-01T09:00', 'Europe/Paris')).toISOString(), '2026-07-01T07:00:00.000Z', 'summer time');
  assert.equal(new Date(instantOf('2026-01-01T09:00', 'Europe/Paris')).toISOString(), '2026-01-01T08:00:00.000Z', 'winter time');
  const phoenix = { ...BLOG, timezone: 'America/Phoenix' };
  const files = [post('s', { status: 'scheduled', publish_at: '2026-11-08T09:00' })];
  assert.deepEqual(dueOf(files, phoenix, Date.parse('2026-11-08T15:59:00Z')), []);
  assert.deepEqual(dueOf(files, phoenix, Date.parse('2026-11-08T16:00:00Z')), ['posts/s.md']);
  assert.deepEqual(dueOf(files, BLOG, Date.parse('2026-11-08T09:00:00Z')), ['posts/s.md'], 'the same text is seven hours earlier in UTC');
  assert.throws(() => validateBlog({ ...BLOG, timezone: 'Mars/Olympus' }), code('bad-blog-json'));
  assert.throws(() => validateBlog({ ...BLOG, timezone: 5 }), code('bad-blog-json'));
  assert.doesNotThrow(() => validateBlog({ ...BLOG, timezone: 'America/Phoenix' }));
});

test('N5: publishing flips the status, drops publish_at and leaves date alone', () => {
  const f = post('s', { status: 'scheduled', publish_at: '2026-11-08T09:00', date: '2026-12-25' });
  const out = publishText(f.text, f.path);
  const meta = parseMeta(splitFile(out, f.path).front, f.path);
  assert.equal(meta.status, 'published');
  assert.equal(meta.publish_at, undefined);
  assert.equal(meta.date, '2026-12-25');
  assert.equal(parsePost({ path: f.path, text: out }).status, 'published');
  assert.ok(out.endsWith('MARK-s.\n'), 'the body is untouched');
});

test('N7: how far away a post is, against the 50-day warning', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  assert.equal(Math.round(daysUntil({ publish_at: '2026-11-17T00:00' }, BLOG, now)), 10);
  assert.ok(daysUntil({ publish_at: '2027-01-30T00:00' }, BLOG, now) > SCHEDULE_WARN_DAYS);
  assert.ok(daysUntil({ publish_at: '2026-12-20T00:00' }, BLOG, now) < SCHEDULE_WARN_DAYS);
});

test('N1: a scheduled post is invisible everywhere a draft is, and aliases wait for it', () => {
  const posts = [post('live'), post('soon', { status: 'scheduled', publish_at: '2026-11-08T09:00', aliases: '[old/soon]' }), post('d', { status: 'draft' })];
  const withScheduled = buildSite({ blog: BLOG, posts, lock: {} });
  const without = buildSite({ blog: BLOG, posts: [post('live'), post('d', { status: 'draft' })], lock: {} });
  assert.deepEqual(withScheduled.errors, []);
  assert.deepEqual(Object.keys(withScheduled.files).sort(), Object.keys(without.files).sort(), 'no page, redirect, shard or listing is made for it');
  assert.deepEqual(withScheduled.files, without.files, 'every byte equals the build without the post');
  for (const [name, content] of Object.entries(withScheduled.files)) assert.ok(!/MARK-soon|Title of soon|old\/soon/.test(content), `${name} does not mention it`);
  assert.deepEqual(withScheduled.index.map((e) => e.slug), ['live']);
});

test('N2: a scheduled post never renders, at its address or from the live copy', () => {
  const p = parsePost(post('soon', { status: 'scheduled', publish_at: '2026-11-08T09:00' }));
  assert.throws(() => renderPost(validateBlog(BLOG), p, {}), (e) => e.code === 'draft-in-publish' && /scheduled/.test(e.detail));
  const built = buildSite({ blog: { ...BLOG, content: { base: DEFAULT_CONTENT_BASE } }, posts: [post('live')], lock: {} });
  const files = { ...built.files, 'blog.json': JSON.stringify({ ...BLOG, content: { base: DEFAULT_CONTENT_BASE } }), 'assets.lock.json': '{}' };
  const read = (f) => (f in files ? new TextEncoder().encode(files[f]) : null);
  return loadSite(async (f) => read(f)).then((site) => {
    const r = renderFromSite(site, { slug: 'soon', text: post('soon', { status: 'scheduled', publish_at: '2026-11-08T09:00' }).text });
    assert.equal(r.published, false);
    assert.equal(r.html, null);
  });
});

async function pinnedExt() {
  const files = await readDirFiles(path.join(EX, 'ext-reading-time'));
  const manifest = JSON.parse(new TextDecoder().decode(files['extension.json']));
  const pin = pinForExtension('me/ext', 'v1.0.0', manifest, filesDigest(files, extensionFilePaths(manifest), (m) => new Error(m)));
  return { pin, ext: loadExtension(pin, files) };
}

test('N3: scheduling records the extension runs now, so publishing later needs none', async () => {
  const e = await pinnedExt();
  const blog = JSON.stringify({ ...BLOG, extensions: [e.pin] });
  const posts = [post('live'), post('soon', { status: 'scheduled', publish_at: '2026-11-08T09:00' })];
  const bare = buildSite({ blog, posts, lock: {}, extensions: [e.ext] });
  assert.ok(bare.errors.some(code('extension-output-missing')), 'without a recorded output the build says so');
  const scheduled = await buildSiteWith({ blog, posts, lock: {}, extensions: [e.ext] }, localRunner);
  assert.deepEqual(scheduled.errors, []);
  assert.ok(!('soon/index.html' in scheduled.files), 'still no page for it');
  const recorded = parseOutputsFile(scheduled.files['extension-outputs.json']);
  const withoutScheduled = parseOutputsFile((await buildSiteWith({ blog, posts: [posts[0]], lock: {}, extensions: [e.ext] }, localRunner)).files['extension-outputs.json']);
  assert.ok(Object.keys(recorded).length > Object.keys(withoutScheduled).length, "the scheduled post's runs are in the file");
  // go-live: flipped, built with the recorded outputs and no runner, as the workflow does
  const flipped = [posts[0], { ...posts[1], text: publishText(posts[1].text, posts[1].path) }];
  const live = buildSite({ blog, posts: flipped, lock: {}, extensions: [e.ext], outputs: recorded });
  assert.deepEqual(live.errors.map((x) => x.code), [], 'nothing is missing at go-live');
  assert.ok('soon/index.html' in live.files);
  // an output that was never recorded refuses at go-live (the CLI leaves the post scheduled and fails)
  const unrecorded = buildSite({ blog, posts: flipped, lock: {}, extensions: [e.ext], outputs: {} });
  assert.ok(unrecorded.errors.some(code('extension-output-missing')));
});

async function blogDir(extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sched-'));
  await fs.cp(path.join(EX, 'blog'), dir, { recursive: true });
  const bj = JSON.parse(await fs.readFile(path.join(dir, 'blog.json'), 'utf8'));
  await fs.writeFile(path.join(dir, 'blog.json'), JSON.stringify({ ...bj, timezone: 'America/Phoenix', ...extra }, null, 2));
  for (const [slug, at] of [['soon', '2026-11-08T09:00'], ['soon-too', '2026-11-08T10:00'], ['later', '2027-06-01T09:00']]) {
    await fs.writeFile(path.join(dir, 'posts', `${slug}.md`), `---\nslug: ${slug}\ntitle: ${slug}\ndate: 2026-11-09\ntags: [git]\nstatus: scheduled\npublish_at: ${at}\n---\n\nBody ${slug}\n`);
  }
  return dir;
}
const cli = (args) => run('node', [path.join(root, 'cli', 'blog.js'), ...args]).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

test('N6: the workflow step commits nothing when nothing is due, and flips every due post in one build', async () => {
  const dir = await blogDir();
  assert.equal((await cli(['build', dir])).code, 0);
  const before = await fs.readFile(path.join(dir, 'index/posts.json'), 'utf8');
  const early = await cli(['publish-due', dir, '--now', '2026-11-08T15:59:00Z']);
  assert.equal(early.code, 0);
  assert.match(early.stdout, /nothing is due/);
  assert.equal(await fs.readFile(path.join(dir, 'index/posts.json'), 'utf8'), before, 'no file changed');
  const due = await cli(['publish-due', dir, '--now', '2026-11-08T17:30:00Z']);
  assert.equal(due.code, 0, due.stderr);
  assert.match(due.stdout, /published posts\/soon\.md/);
  assert.match(due.stdout, /published posts\/soon-too\.md/);
  assert.equal(due.stdout.match(/^built /gm).length, 1, 'one build');
  for (const s of ['soon', 'soon-too']) {
    assert.match(await fs.readFile(path.join(dir, 'posts', `${s}.md`), 'utf8'), /status: published\n/);
    assert.ok(await fs.stat(path.join(dir, s, 'index.html')));
  }
  assert.match(await fs.readFile(path.join(dir, 'posts/later.md'), 'utf8'), /status: scheduled/, 'what is not due stays scheduled');
  assert.equal((await cli(['check', dir])).code, 0, 'the committed site is current');
  const again = await cli(['publish-due', dir, '--now', '2026-11-08T17:30:00Z']);
  assert.match(again.stdout, /nothing is due/, 'idempotent');
});

test('N3/N6: a refusal leaves the due post scheduled, writes nothing, and fails the run', async () => {
  const dir = await blogDir();
  await fs.writeFile(path.join(dir, 'posts/soon.md'), '---\nslug: soon\ntitle: soon\ndate: 2026-11-09\nstatus: scheduled\npublish_at: 2026-11-08T09:00\n---\n\n![x](asset:images/never-pinned.png)\n');
  assert.equal((await cli(['build', dir])).code, 0, 'a scheduled post may carry a reference that does not resolve yet');
  const r = await cli(['publish-due', dir, '--now', '2026-11-08T17:30:00Z']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /left scheduled/);
  assert.match(await fs.readFile(path.join(dir, 'posts/soon.md'), 'utf8'), /status: scheduled/);
  assert.match(await fs.readFile(path.join(dir, 'posts/soon-too.md'), 'utf8'), /status: scheduled/, 'nothing is half done');
});

test('N8: the README states the guarantee and that the source is public; the workflow is off the hour', async () => {
  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /not before `publish_at`, and normally within the hour/i);
  assert.match(readme, /source is public/i);
  assert.match(readme, /60 days/);
  const wf = await fs.readFile(path.join(root, 'templates/schedule.yml'), 'utf8');
  const cron = /cron: "(\d+) \* \* \* \*"/.exec(wf);
  assert.ok(cron && cron[1] !== '0', 'not at the top of the hour');
  assert.match(wf, /workflow_dispatch/);
  assert.match(wf, /diff --cached --quiet/, 'commits only what changed');
});

test('the editor plans a scheduled post: pins what it needs now, writes no page, and states what it promises', async () => {
  const base = await readDirFiles(path.join(EX, 'blog'));
  const server = fakeGitHub({ 'example/blog': base, 'example/images': { 'diagram.png': 'img' } });
  await server.ready;
  const gh = new GitHub(createNet(server.fetch), { token: 'github_pat_test' });
  const text = '---\nslug: soon\ntitle: Soon\ndate: 2026-12-01\ntags: [git]\nstatus: scheduled\npublish_at: 2026-12-02T09:00\n---\n\n![d](asset:images/new-one.png)\n';
  await assert.rejects(planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'soon', text, create: true }), code('unresolved-asset'), 'a scheduled post needs its references pinned now: nobody is there at go-live to do it');
  const ok = text.replace('new-one.png', 'diagram.png');
  const plan = await planChange(gh, { repo: 'example/blog', branch: 'main', slug: 'soon', text: ok, create: true });
  assert.equal(plan.status, 'scheduled');
  assert.equal(plan.schedule.at, '2026-12-02T09:00');
  assert.equal(plan.schedule.zone, null);
  assert.ok(plan.changes.some((c) => c.path === 'posts/soon.md' && c.action === 'add'));
  assert.ok(!plan.changes.some((c) => c.path === 'soon/index.html'), 'no page');
  assert.ok(!plan.changes.some((c) => c.path === 'feed.xml' || c.path === 'sitemap.xml' || c.path === 'index.html'), 'nothing a reader sees changes');
  await executePlan(gh, plan);
  const committed = await gh.readText('example/blog', 'posts/soon.md');
  assert.match(committed, /status: scheduled\npublish_at: 2026-12-02T09:00/);
});

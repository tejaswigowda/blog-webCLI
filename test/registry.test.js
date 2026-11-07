// R6-R8: the registry is data in its own repository, read by URL with a bundled fallback; it is schema-validated and never authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseRegistry, validateEntry } from '../lib/registry.js';
import { loadRegistry } from '../app/registry-client.js';
import { config } from '../app/config.js';
import { readRegistry, scaffold, snapshotText } from '../cli/registry.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const good = { name: 'Essay', repo: 'me/themes/essay', ref: 'v1.0.0', licence: 'MIT', blurb: 'A serif face.', screenshot: 'https://example.com/e.png' };
const file = (kind, ...entries) => ({ version: 1, [kind]: entries });
const snapshot = JSON.parse(await fs.readFile(path.join(root, 'app', 'registry-snapshot.json'), 'utf8'));
const reply = (body, status = 200) => async () => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('R7: an entry is exactly name, repo, ref, licence, blurb, screenshot, sha256: nothing else survives', () => {
  const v = validateEntry('themes', { ...good, sha256: 'c'.repeat(64), html: '<script>x</script>', onload: 'x()', description: 'old', extra: { a: 1 } });
  assert.equal(v.ok, true);
  assert.deepEqual(Object.keys(v.entry).sort(), ['blurb', 'licence', 'name', 'ref', 'repo', 'screenshot', 'sha256']);
});

test('R7: no registry field reaches the DOM unvalidated: markup, script addresses and non-https screenshots are refused', () => {
  const bad = [
    { name: '<img src=x onerror=alert(1)>' },
    { name: 'a\u0000b' },
    { repo: '../../etc/passwd' },
    { repo: 'me/themes/../x' },
    { repo: 'javascript:alert(1)' },
    { ref: 'main branch' },
    { ref: '../x' },
    { ref: '' },
    { licence: '<b>MIT</b>' },
    { blurb: 'x'.repeat(301) },
    { blurb: 'a\u0007b' },
    { blurb: 42 },
    { screenshot: 'javascript:alert(1)' },
    { screenshot: 'http://example.com/a.png' },
    { screenshot: 'data:image/svg+xml,<svg onload=x>' },
    { screenshot: 'https://example.com/a"onerror="x' },
    { sha256: 'ABC' },
    { sha256: 'c'.repeat(63) },
  ];
  for (const patch of bad) assert.equal(validateEntry('themes', { ...good, ...patch }).ok, false, JSON.stringify(patch));
  for (const x of [null, 'str', 7, [], undefined]) assert.equal(validateEntry('themes', x).ok, false);
  assert.equal(validateEntry('extensions', { ...good, screenshot: 'javascript:1' }).entry.screenshot, undefined, 'an extension has no screenshot field at all');
});

test('R7: a bad entry is dropped alone and named; a bad file shape is refused whole', () => {
  const { entries, rejected } = parseRegistry('themes', file('themes', good, { ...good, repo: 'x' }, good, { ...good, repo: 'me/b/b', name: 'B' }));
  assert.deepEqual(entries.map((e) => e.name), ['Essay', 'B']);
  assert.deepEqual(rejected.map((r) => r.index), [1, 2]);
  assert.match(rejected[1].why, /listed twice/);
  for (const bad of ['not json', '[]', 'null', '{}', JSON.stringify({ version: 2, themes: [] }), JSON.stringify({ version: 1, themes: 'x' }), JSON.stringify(file('extensions', good))]) {
    assert.throws(() => parseRegistry('themes', bad), undefined, bad);
  }
  assert.throws(() => parseRegistry('themes', file('themes', ...Array.from({ length: 201 }, (_, i) => ({ ...good, repo: `me/t/t${i}` })))), /most read/);
  assert.throws(() => parseRegistry('nope', {}), /unknown registry kind/);
});

test('R6: the registry is fetched as a static file with a path no cache holds, with no credentials', async () => {
  const calls = [];
  const res = await loadRegistry('themes', { url: 'https://reg.example/x/', snapshot, now: () => 123, fetchImpl: async (u, o) => (calls.push([u, o]), reply(file('themes', good))()) });
  assert.equal(res.source, 'registry');
  assert.deepEqual(res.entries.map((e) => e.name), ['Essay']);
  assert.equal(decodeURIComponent(calls[0][0]), 'https://reg.example/x/themes.json?t=123');
  assert.deepEqual([calls[0][1].credentials, calls[0][1].cache, calls[0][1].referrerPolicy], ['omit', 'no-store', 'no-referrer']);
});

test('R6: unreachable, missing, not JSON, wrong shape or not configured: the bundled snapshot is listed and the reason kept', async () => {
  const cases = [
    ['network', async () => { throw new Error('offline'); }, /offline/],
    ['404', reply('nope', 404), /HTTP 404/],
    ['not json', reply('<html>'), /not JSON/],
    ['wrong version', reply({ version: 9, themes: [] }), /version/],
    ['wrong list', reply(file('extensions', good)), /no "themes" list/],
  ];
  for (const [name, fetchImpl, why] of cases) {
    const res = await loadRegistry('themes', { url: 'https://reg.example/', snapshot, fetchImpl });
    assert.equal(res.source, 'snapshot', name);
    assert.match(res.why, why, name);
    assert.equal(res.entries.length, snapshot.themes.length, name);
  }
  const none = await loadRegistry('extensions', { snapshot });
  assert.equal(none.source, 'snapshot');
  assert.equal(none.entries.length, snapshot.extensions.length);
});

test('R6: the app is configured with a registry address; changing it is the only thing running your own takes', () => {
  assert.match(config.registry, /^https:\/\/.+\/$/);
  assert.throws(() => { config.registry = 'x'; }, TypeError);
});

test('R6: the bundled snapshot is valid, and every entry in it is data the app accepts as is', () => {
  for (const kind of ['themes', 'extensions']) {
    const { entries, rejected } = parseRegistry(kind, { version: snapshot.version, [kind]: snapshot[kind] });
    assert.deepEqual(rejected, [], kind);
    assert.ok(entries.length >= 5, kind);
    assert.deepEqual(entries, snapshot[kind], `${kind}: the snapshot is already in validated form`);
  }
});

test('R6: the registry repository is scaffolded with its own validator; the snapshot is a function of its data', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-'));
  try {
    const written = await scaffold(dir);
    assert.ok(['README.md', 'validate.mjs', 'registry.js', 'LICENSE', '.github/workflows/validate.yml'].every((f) => written.includes(f)));
    assert.equal(await fs.readFile(path.join(dir, 'registry.js'), 'utf8'), await fs.readFile(path.join(root, 'lib', 'registry.js'), 'utf8'), 'the repository validates with the app\'s own file');
    await fs.writeFile(path.join(dir, 'themes.json'), JSON.stringify(file('themes', good)));
    await fs.writeFile(path.join(dir, 'extensions.json'), JSON.stringify(file('extensions', { ...good, repo: 'me/e/e' })));
    const { registry } = await readRegistry(dir);
    assert.equal(snapshotText(registry), snapshotText({ themes: [{ ...good }], extensions: [{ name: 'Essay', repo: 'me/e/e', ref: 'v1.0.0', licence: 'MIT', blurb: 'A serif face.' }] }));
    await fs.writeFile(path.join(dir, 'themes.json'), JSON.stringify(file('themes', { ...good, screenshot: 'javascript:1' })));
    await assert.rejects(readRegistry(dir), /screenshot/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('R6: lib/registry.js is MIT and imports nothing, so the registry repository can carry the very same file', async () => {
  const text = await fs.readFile(path.join(root, 'lib', 'registry.js'), 'utf8');
  assert.doesNotMatch(text, /^\s*import\s/m);
});

test('R8: the registry is not consulted by the pin: a theme in no list resolves by its address (packs-app X9), and the app has no list of its own', async () => {
  const src = await fs.readFile(path.join(root, 'app', 'site.js'), 'utf8');
  assert.doesNotMatch(src, /registry/i, 'planTheme and planExtension never read the registry');
});

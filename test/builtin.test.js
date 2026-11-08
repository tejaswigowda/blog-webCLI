// The listed themes and extensions live in two sibling repositories
// (blog-webCLI-themes, blog-webCLI-extensions). This checks the real folders against this app:
// every one loads and pins under the app's own rules, builds a real blog, is listed in
// the bundled registry snapshot with the right licence and a tag that exists, and every
// extension does what its README says. Skipped when the siblings are not checked out
// (set BLOG_WEBCLI_THEMES / BLOG_WEBCLI_EXTENSIONS to point elsewhere).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../lib/blog.js';
import { buildSiteWith } from '../lib/build-async.js';
import { checkPublishedCss, loadTheme, pinFor, themeDigest, themeFilePaths } from '../lib/theme-pack.js';
import { extensionFilePaths, loadExtension, pinForExtension } from '../lib/extensions.js';
import { filesDigest, isPinnedRef } from '../lib/pin.js';
import { stripComments } from '../lib/css.js';
import { EX, localRunner, readDirFiles, stripData } from './helpers.js';

const run = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEMES = process.env.BLOG_WEBCLI_THEMES || path.join(root, '..', 'blog-webCLI-themes');
const EXTS = process.env.BLOG_WEBCLI_EXTENSIONS || path.join(root, '..', 'blog-webCLI-extensions');
const THEMES_REPO = 'tejaswigowda/blog-webCLI-themes';
const EXTS_REPO = 'tejaswigowda/blog-webCLI-extensions';
const skipThemes = existsSync(path.join(THEMES, 'essay')) ? false : 'blog-webCLI-themes is not checked out next to this repository';
const skipExts = existsSync(path.join(EXTS, 'heading-anchors')) ? false : 'blog-webCLI-extensions is not checked out next to this repository';
const dec = new TextDecoder();

async function folders(dir, file) {
  const out = [];
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (existsSync(path.join(p, file))) out.push(path.relative(dir, p).split(path.sep).join('/'));
      else await walk(p);
    }
  };
  await walk(dir);
  return out.sort();
}

async function pinTheme(folder, ref = 'v1.0.0') {
  const files = await readDirFiles(path.join(THEMES, folder));
  const manifest = JSON.parse(dec.decode(files['theme.json']));
  const pin = pinFor(`${THEMES_REPO}/${folder}`, ref, manifest, themeDigest(files, themeFilePaths(manifest)));
  return { files, manifest, pin, theme: loadTheme(pin, files) };
}
async function pinExt(folder, ref = 'v1.0.0') {
  const files = await readDirFiles(path.join(EXTS, folder));
  const manifest = JSON.parse(dec.decode(files['extension.json']));
  const pin = pinForExtension(`${EXTS_REPO}/${folder}`, ref, manifest, filesDigest(files, extensionFilePaths(manifest), (m) => new Error(m)));
  return { files, manifest, pin, ext: loadExtension(pin, files) };
}

const RICH_POST = `---
slug: rich-post
title: A rich post
date: 2025-12-24
tags: [writing]
status: published
---

"Quotes" -- and the end... It's 1990--2000.

## First

![A diagram of it](asset:images/diagram.png)

## Second

Some \`code with "quotes"\` here.

## First

### Nested

\`\`\`js
const s = "not smart";
\`\`\`
`;

async function input(patch = {}, { rich = true } = {}) {
  const blog = { ...JSON.parse(await fs.readFile(path.join(EX, 'blog', 'blog.json'), 'utf8')), ...patch };
  const lock = JSON.parse(await fs.readFile(path.join(EX, 'blog', 'assets.lock.json'), 'utf8'));
  const posts = await Promise.all(['static-hls-in-git', 'markdown-is-the-format'].map(async (s) => ({ path: `posts/${s}.md`, text: await fs.readFile(path.join(EX, 'blog', 'posts', `${s}.md`), 'utf8') })));
  if (rich) posts.push({ path: 'posts/rich-post.md', text: RICH_POST });
  return { blog: JSON.stringify(blog), lock, posts };
}

// ---------- the lists ----------
for (const [what, dir, file, listFile, key, repo, skip] of [
  ['themes', THEMES, 'theme.json', 'themes.json', 'themes', THEMES_REPO, skipThemes],
  ['extensions', EXTS, 'extension.json', 'extensions.json', 'extensions', EXTS_REPO, skipExts],
]) {
  test(`built in ${what}: every folder is listed, every entry matches its manifest and a tag that exists`, { skip }, async () => {
    // the bundled snapshot (what the app lists when the registry is unreachable), which is a copy of the registry repository's file
    const list = JSON.parse(await fs.readFile(path.join(root, 'app', 'registry-snapshot.json'), 'utf8'));
    const entries = list[key];
    const found = await folders(dir, file);
    assert.ok(found.length >= (what === 'themes' ? 5 : 6), `${found.length} ${what} found`);
    assert.deepEqual(entries.map((e) => e.repo).sort(), found.map((f) => `${repo}/${f}`).sort(), `every ${what.slice(0, -1)} folder is listed, and nothing else`);
    const tags = (await run('git', ['-C', dir, 'tag', '--list'])).stdout.split('\n').filter(Boolean);
    for (const e of entries) {
      const folder = e.repo.slice(repo.length + 1);
      const m = JSON.parse(await fs.readFile(path.join(dir, folder, file), 'utf8'));
      assert.equal(e.name, m.name, e.repo);
      assert.equal(e.licence, m.licence, `${e.repo}: the list states the manifest's licence`);
      assert.ok(e.blurb && e.blurb.length < 200, e.repo);
      assert.ok(isPinnedRef(e.ref), `${e.repo}@${e.ref} is a tag or commit`);
      assert.ok(tags.includes(e.ref), `${e.repo}: tag ${e.ref} exists in the repository (git tag; push it before the list is useful)`);
      assert.ok(existsSync(path.join(dir, folder, 'LICENSE')), `${e.repo} has a LICENSE`);
      if (what === 'themes') {
        // a screenshot is listed only where the folder has one (the imported WordPress themes are CSS and tokens only)
        if (existsSync(path.join(dir, folder, 'screenshot.png'))) {
          assert.equal(e.screenshot, `https://cdn.jsdelivr.net/gh/${repo}@${e.ref}/${folder}/screenshot.png`);
          const png = await fs.readFile(path.join(dir, folder, 'screenshot.png'));
          assert.equal(png.subarray(1, 4).toString(), 'PNG', `${e.repo} has a screenshot`);
        } else assert.equal(e.screenshot, undefined, `${e.repo}: no screenshot file, none listed`);
      }
    }
  });
}

// ---------- themes ----------
const CLASS_ALLOWED_EXTRA = new Set(['logo', 'unresolved']); // only with a logo / an unresolved asset

test('built in themes: each loads under the app rules, builds a real blog, and styles only markup that exists', { skip: skipThemes }, async () => {
  const found = await folders(THEMES, 'theme.json');
  for (const folder of found) {
    const { manifest, pin, theme } = await pinTheme(folder);
    const label = `${folder} (${manifest.name})`;
    assert.ok(['blog-webcli-v1', 'wordpress-classic'].includes(manifest.class_contract), label);
    assert.ok(/^(MIT|GPL-2\.0-or-later|GPL-3\.0-or-later|GPL-3\.0-only)$/.test(manifest.licence), label);
    if (folder.startsWith('wp/')) assert.match(manifest.licence, /^GPL-/, 'only the wp/ themes are GPL');
    else assert.equal(manifest.licence, 'MIT', label);

    const out = buildSite({ ...(await input({ theme: pin })), theme });
    assert.deepEqual(out.errors, [], label);
    assert.doesNotThrow(() => checkPublishedCss(out.files['theme.css']), label);
    const lic = JSON.parse(out.files['licences.json']);
    assert.deepEqual(lic.dependencies.map((d) => [d.kind, d.name, d.licence]), [['theme', manifest.name, manifest.licence]], label);
    assert.match(out.files['index.html'], new RegExp(`theme: ${manifest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${manifest.version} — ${manifest.licence}`));
    for (const f of Object.keys(out.files).filter((n) => n.endsWith('.html'))) assert.ok(!/<script\b/i.test(stripData(out.files[f])), `${label} ${f}: no script`);

    if (manifest.class_contract !== 'blog-webcli-v1') continue;
    // customization keeps working on top: the variables a blog's settings set are defined by the theme
    const css = stripComments(theme.css);
    for (const v of ['--fg', '--bg', '--link', '--muted', '--rule', '--code', '--font', '--heading-font', '--width', '--size']) assert.ok(css.includes(`${v}:`), `${label} defines ${v}`);
    // every class the theme styles is one the generator emits
    const cards = buildSite({ ...(await input({ theme: pin, customize: { ...JSON.parse((await input()).blog).customize, list: { layout: 'cards', excerpts: true, dates: true, tags: true } } })), theme });
    const emitted = new Set();
    for (const o of [out, cards]) for (const [f, html] of Object.entries(o.files)) if (f.endsWith('.html')) for (const m of html.matchAll(/class="([^"]*)"/g)) m[1].split(/\s+/).forEach((c) => emitted.add(c));
    const styled = new Set();
    for (const m of css.matchAll(/([^{}]+)\{/g)) for (const c of m[1].matchAll(/\.([A-Za-z_][\w-]*)/g)) styled.add(c[1]);
    for (const c of styled) assert.ok(emitted.has(c) || CLASS_ALLOWED_EXTRA.has(c), `${label} styles .${c}, which the generator never emits`);
  }
});

test('built in themes: the WordPress theme is the classic contract and styles the classic markup', { skip: skipThemes }, async () => {
  const { manifest, pin, theme } = await pinTheme('wp/twentytwentyone');
  assert.equal(manifest.class_contract, 'wordpress-classic');
  assert.equal(manifest.upstream.slug, 'twentytwentyone');
  assert.match(manifest.source, /^https:\/\/wordpress\.org\/themes\//);
  assert.ok(manifest.attribution && manifest.dropped.php.length > 10, 'attribution and what was dropped are recorded');
  const out = buildSite({ ...(await input({ theme: pin })), theme });
  assert.deepEqual(out.errors, []);
  const page = out.files['markdown-is-the-format/index.html'];
  for (const c of ['site-header', 'entry-title', 'entry-content', 'site-footer', 'hentry']) assert.match(page, new RegExp(`class="[^"]*\\b${c}\\b`), c);
});

// ---------- extensions ----------
test('built in extensions: each runs alone, is deterministic, and regenerates from its recorded output', { skip: skipExts }, async () => {
  for (const folder of await folders(EXTS, 'extension.json')) {
    const { manifest, pin, ext } = await pinExt(folder);
    const inp = await input({ extensions: [pin] });
    const done = await buildSiteWith({ ...inp, extensions: [ext] }, localRunner);
    assert.deepEqual(done.errors, [], `${manifest.name}: ${JSON.stringify(done.errors)}`);
    assert.notDeepEqual(done.files, buildSite(await input()).files, `${manifest.name} changes something`);
    const rec = JSON.parse(done.files['extension-outputs.json']);
    const again = buildSite({ ...inp, extensions: [ext], outputs: rec.outputs });
    assert.deepEqual(again.errors, [], manifest.name);
    assert.deepEqual(again.files, done.files, `${manifest.name}: regenerating from recorded outputs runs nothing and matches`);
    const lic = JSON.parse(done.files['licences.json']);
    assert.ok(lic.dependencies.some((d) => d.kind === 'extension' && d.name === manifest.name && d.licence === 'MIT'));
  }
});

test('built in extensions: all together, in the order a blog would list them', { skip: skipExts }, async () => {
  const order = ['smart-typography', 'heading-anchors', 'table-of-contents', 'image-captions', 'reading-time', 'archive-by-year'];
  const packs = await Promise.all(order.map((f) => pinExt(f)));
  const inp = await input({ extensions: packs.map((p) => p.pin) });
  const done = await buildSiteWith({ ...inp, extensions: packs.map((p) => p.ext) }, localRunner);
  assert.deepEqual(done.errors, [], JSON.stringify(done.errors));
  const page = done.files['rich-post/index.html'];

  assert.match(page, /\u201cQuotes\u201d \u2013 and the end\u2026 It\u2019s 1990\u20132000\./, 'smart-typography');
  assert.match(page, /<code>code with &quot;quotes&quot;<\/code>/, 'smart-typography leaves inline code alone');
  assert.match(page, /const s = &quot;not smart&quot;;/, 'and fenced code');
  assert.match(page, /<h2 id="first">First <a class="anchor" href="#first"/, 'heading-anchors');
  assert.match(page, /<h2 id="first-2">/, 'duplicate headings get distinct ids');
  assert.match(page, /<div class="toc" role="navigation" aria-label="Contents"><p class="toc-title">Contents<\/p><ul><li><a href="#first">First<\/a>/, 'table-of-contents');
  assert.ok(!/<div class="toc"[\s\S]*?<\/div>/.exec(page)[0].includes('class="anchor"'), 'the contents list carries no "#" anchor links');
  assert.match(page, /<figure class="image"><img [^>]*alt="A diagram of it"[^>]*><figcaption>A diagram of it<\/figcaption><\/figure>/, 'image-captions');
  assert.match(page, /<p class="reading-time">1 min read<\/p>/, 'reading-time');

  const index = done.files['index.html'];
  assert.equal([...index.matchAll(/<h2 class="year">(\d{4})<\/h2>/g)].map((m) => m[1]).join(), '2026,2025', 'archive-by-year');

  // every output was sanitized and recorded; nothing leaked into the post sources
  const rec = JSON.parse(done.files['extension-outputs.json']);
  assert.ok(Object.keys(rec.outputs).length >= 10);
  assert.ok(!/<script\b|\son\w+=/i.test(stripData(page + index)));
  const again = buildSite({ ...inp, extensions: packs.map((p) => p.ext), outputs: rec.outputs });
  assert.deepEqual(again.files, done.files, 'regenerates identically from the recorded outputs');
});

test('built in extensions: the wordpress-classic contract is left alone by the two that need the v1 markup', { skip: skipExts || skipThemes }, async () => {
  const t = await pinTheme('wp/twentytwentyone');
  const packs = await Promise.all(['archive-by-year', 'image-captions'].map((f) => pinExt(f)));
  const plain = buildSite({ ...(await input({ theme: t.pin })), theme: t.theme });
  const inp = await input({ theme: t.pin, extensions: packs.map((p) => p.pin) });
  const done = await buildSiteWith({ ...inp, theme: t.theme, extensions: packs.map((p) => p.ext) }, localRunner);
  assert.deepEqual(done.errors, []);
  const bare = (h) => h.replace(/<!--[\s\S]*?-->/, '').trim(); // the licence comment lists the extensions
  assert.equal(bare(done.files['index.html']), bare(plain.files['index.html']), 'the index is unchanged');
  assert.equal(bare(done.files['markdown-is-the-format/index.html']).includes('<figure class="image">'), false);
});

#!/usr/bin/env node
// blog-webcli — generate, verify and normalise a blog repo.
//   build [dir]   regenerate index, pages and feed (refuses on any error)
//   check [dir]   regenerate in memory and fail on any difference (CI, gate B8)
//   fmt   [dir]   rewrite posts into canonical markdown
//   publish-due [dir] [--now <ISO time>]   publish the scheduled posts whose time has come, then build (the schedule workflow runs this)
//   pin   [dir]   pin unpinned asset: references to commits, and verify video: release tags, via the GitHub API
//   theme pin <owner/repo[/folder]@ref> [dir]   pin a theme (a tag or commit; a branch is refused)
//   theme clear [dir]                           go back to the built-in theme
//   theme import <wordpress-slug> [outdir]      turn a wordpress.org directory theme into a theme repository
//   ext add <owner/repo[/folder]@ref> [dir]     pin an extension (fetched as data and hashed; never run here)
//   ext remove <owner/repo> [dir]
//   licences [dir]                              every licence the blog depends on
//   import wp <export.xml | https://site> [dir] --repo owner/name[/folder] [--add]   a WordPress blog's posts, pages and pictures, as files
//                                               (--add: into a blog that exists, leaving its settings and theme alone)
//
// This tool never executes extension code. Extension output is recorded data (extension-outputs.json),
// written when you publish from the editor, where extensions run in a sandbox.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Refusal } from '../lib/errors.js';
import { liftComments } from '../lib/comments-lift.js';
import { buildSite, GENERATED_MARK, GENERATED_TREES, OPTIONAL_GENERATED, validateBlog, parsePost } from '../lib/blog.js';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { loadPacks, readExtensionToPin, readThemeToPin } from '../app/packs.js';
import { parseOutputsFile } from '../lib/extensions.js';
import { blogJsonText } from '../lib/init.js';
import { licenceRecords } from '../lib/licences.js';
import { importWordPress } from './wp-content-import.js';
import { importWordPressTheme } from './wp-import.js';
import { splitFile, joinFile } from '../lib/frontmatter.js';
import { deltaToMd, mdToDelta } from '../lib/markdown.js';
import { collectAssetRefs, parseAssetRef } from '../lib/assets.js';
import { collectVideoRefs, parseVideoRef } from '../lib/video.js';
import { at, parseRepoRef } from '../lib/reporef.js';
import { blogAssetRefs } from '../lib/customize.js';
import { resolveOrder } from '../lib/order.js';
import { dueOf, publishText } from '../lib/schedule.js';

const exists = (p) => fs.access(p).then(() => true, () => false);

async function load(dir) {
  const bj = path.join(dir, 'blog.json');
  if (!(await exists(bj))) throw new Refusal('no-blog-json', `no blog.json in ${path.resolve(dir)}`);
  const blog = await fs.readFile(bj, 'utf8');
  const posts = [];
  for (const folder of ['posts', 'pages', 'comments']) {
    const pdir = path.join(dir, folder);
    if (!(await exists(pdir))) continue;
    for (const f of (await fs.readdir(pdir)).sort()) {
      if (f.endsWith(folder === 'comments' ? '.json' : '.md')) posts.push({ path: `${folder}/${f}`, text: await fs.readFile(path.join(pdir, f), 'utf8') });
    }
  }
  const lp = path.join(dir, 'assets.lock.json');
  const lock = (await exists(lp)) ? JSON.parse(await fs.readFile(lp, 'utf8')) : {};
  const op = path.join(dir, 'extension-outputs.json');
  const outputs = parseOutputsFile((await exists(op)) ? await fs.readFile(op, 'utf8') : null);
  // a manual order is an authored list beside blog.json (blog.json says which file)
  let orderList = null;
  try {
    const order = resolveOrder(validateBlog(blog));
    const listPath = order.by === 'manual' ? path.join(dir, order.list) : null;
    if (listPath && (await exists(listPath))) orderList = await fs.readFile(listPath, 'utf8');
  } catch {
    /* an invalid blog.json is refused, with its reason, where the site is generated */
  }
  return { blog, posts, lock, outputs, orderList };
}

// Anonymous GitHub reads, for fetching a pinned theme or extension as data.
const github = () => new GitHub(createNet((...a) => globalThis.fetch(...a)));

async function generate(dir, { instead } = {}) {
  const loaded = await load(dir);
  const { blog, lock, outputs, orderList } = loaded;
  const posts = instead || loaded.posts;
  const validated = validateBlog(blog);
  let packs = { theme: null, extensions: [] };
  if ((validated.theme && typeof validated.theme === 'object') || (validated.extensions || []).length) {
    console.log('fetching the pinned theme and extensions (as data) …');
    packs = await loadPacks(github(), validated);
  }
  return buildSite({ blog, posts, lock, ...packs, outputs, orderList });
}

// Generated files that exist only while a theme, extensions or a feature are in use.
const OPTIONAL = OPTIONAL_GENERATED;

// A page the generator wrote is a folder with an index.html that carries the generator's mark: a post's, a page's, and the
// redirect at an old address, which can be several folders down (2020/05/old-post/). The folders the generator owns outright
// (tags/, archive/, …) are swept by staleTrees instead.
async function staleDirs(dir, expected) {
  const out = [];
  const walk = async (rel) => {
    for (const ent of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      if (!rel && ['posts', 'pages', 'index', ...GENERATED_TREES].includes(ent.name)) continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      const f = path.join(dir, r, 'index.html');
      if (await exists(f)) {
        if (!expected.has(`${r}/index.html`) && (await fs.readFile(f, 'utf8')).includes(GENERATED_MARK)) out.push(`${r}/index.html`);
      }
      await walk(r);
    }
  };
  await walk('');
  return out;
}

// Every file under a folder the generator owns that the build did not produce.
async function staleTrees(dir, expected) {
  const out = [];
  const walk = async (rel) => {
    if (!(await exists(path.join(dir, rel)))) return;
    for (const ent of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = `${rel}/${ent.name}`;
      if (ent.isDirectory()) await walk(r);
      else if (!expected.has(r)) out.push(r);
    }
  };
  for (const t of GENERATED_TREES) await walk(t);
  return out;
}

// Removes a file and then any folder it leaves empty, up to the site's own folder.
async function removeWithEmptyParents(dir, rel) {
  await fs.rm(path.join(dir, rel));
  for (let d = path.dirname(rel); d && d !== '.'; d = path.dirname(d)) {
    if ((await fs.readdir(path.join(dir, d))).length) break;
    await fs.rmdir(path.join(dir, d));
  }
}

function report(result) {
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  for (const e of result.errors) console.error(`refused: ${e.message}`);
}

async function build(dir) {
  const r = await generate(dir);
  report(r);
  if (r.errors.length) return 1;
  const expected = new Set(Object.keys(r.files));
  for (const [rel, content] of Object.entries(r.files)) {
    const f = path.join(dir, rel);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, content);
  }
  for (const rel of await staleDirs(dir, expected)) {
    await fs.rm(path.dirname(path.join(dir, rel)), { recursive: true });
    // an old address is a few folders down: the ones it leaves empty go too
    for (let d = path.dirname(path.dirname(rel)); d && d !== '.'; d = path.dirname(d)) {
      if ((await fs.readdir(path.join(dir, d))).length) break;
      await fs.rmdir(path.join(dir, d));
    }
    console.log(`removed stale ${rel}`);
  }
  for (const rel of await staleTrees(dir, expected)) {
    await removeWithEmptyParents(dir, rel);
    console.log(`removed stale ${rel}`);
  }
  for (const f of OPTIONAL) if (!expected.has(f) && (await exists(path.join(dir, f)))) {
    await fs.rm(path.join(dir, f));
    console.log(`removed stale ${f}`);
  }
  console.log(`built ${r.index.length} published post(s), ${expected.size} file(s)`);
  return 0;
}

async function check(dir) {
  const r = await generate(dir);
  report(r);
  if (r.errors.length) return 1;
  const expected = new Set(Object.keys(r.files));
  const diffs = [];
  for (const [rel, content] of Object.entries(r.files)) {
    const f = path.join(dir, rel);
    const have = (await exists(f)) ? await fs.readFile(f, 'utf8') : null;
    if (have === null) diffs.push(`missing  ${rel}`);
    else if (have !== content) diffs.push(`differs  ${rel}`);
  }
  for (const rel of await staleDirs(dir, expected)) diffs.push(`stale    ${rel}`);
  for (const rel of await staleTrees(dir, expected)) diffs.push(`stale    ${rel}`);
  for (const f of OPTIONAL) if (!expected.has(f) && (await exists(path.join(dir, f)))) diffs.push(`stale    ${f}`);
  if (diffs.length) {
    console.error('generated output is out of date — run `blog-webcli build` and commit:\n  ' + diffs.join('\n  '));
    return 1;
  }
  console.log(`ok: ${expected.size} generated file(s) match their source`);
  return 0;
}

async function fmt(dir) {
  const { posts } = await load(dir);
  let changed = 0;
  for (const p of posts) {
    const { front, body } = splitFile(p.text.replace(/\r\n/g, '\n'), p.path);
    const out = joinFile(front, deltaToMd(mdToDelta(body)));
    if (out !== p.text) {
      await fs.writeFile(path.join(dir, p.path), out);
      console.log(`formatted ${p.path}`);
      changed++;
    }
  }
  console.log(changed ? `${changed} file(s) rewritten` : 'already canonical');
  return 0;
}

// Flip every due scheduled post to published, then build once. Nothing is written unless the whole site builds with them
// published: a missing extension output (or any other refusal) leaves the posts scheduled and fails the run, loudly.
async function publishDue(dir, args) {
  const i = args.indexOf('--now');
  const now = i >= 0 ? Date.parse(args[i + 1]) : Date.now();
  if (Number.isNaN(now)) throw new Refusal('bad-blog-json', '--now needs a time like 2026-11-08T16:00:00Z');
  const { blog, posts } = await load(dir);
  const due = dueOf(posts, validateBlog(blog), now);
  if (!due.length) {
    console.log('nothing is due');
    return 0;
  }
  const flipped = posts.map((p) => (due.includes(p.path) ? { ...p, text: publishText(p.text, p.path) } : p));
  const r = await generate(dir, { instead: flipped });
  report(r);
  if (r.errors.length) {
    console.error(`${due.length} post(s) are due and were left scheduled: ${due.join(', ')}`);
    return 1;
  }
  for (const p of flipped) if (due.includes(p.path)) await fs.writeFile(path.join(dir, p.path), p.text);
  for (const p of due) console.log(`published ${p}`);
  return build(dir);
}

async function pin(dir) {
  const { blog: raw, posts, lock } = await load(dir);
  const blog = validateBlog(raw);
  const token = process.env.GITHUB_TOKEN;
  const headers = { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const refs = new Set();
  const videos = new Set();
  for (const r of blogAssetRefs(blog)) refs.add(r);
  for (const p of posts) {
    const post = parsePost(p);
    if (post.status !== 'published') continue;
    collectAssetRefs(post.delta, post.meta).forEach((r) => refs.add(r));
    collectVideoRefs(post.delta).forEach((r) => videos.add(r));
  }
  for (const ref of [...videos].sort()) {
    const { key, tag } = parseVideoRef(ref);
    const repo = blog.video && blog.video.repos[key] && parseRepoRef(blog.video.repos[key]).repo;
    if (!repo) throw new Refusal('unresolved-asset', `${ref}: blog.json has no video repo "${key}"`);
    const res = await fetch(`https://api.github.com/repos/${repo}/git/ref/tags/${tag.split('/').map(encodeURIComponent).join('/')}`, { headers });
    if (!res.ok) throw new Refusal('unresolved-asset', `${ref}: ${repo} has no release tagged ${tag}`);
    console.log(`verified ${ref} (${repo} @ ${tag})`);
  }
  let added = 0;
  for (const ref of [...refs].sort()) {
    const { key, path: file } = parseAssetRef(ref);
    if (lock[`${key}/${file}`]) continue;
    const where = blog.assets && blog.assets.repos[key];
    if (!where) throw new Refusal('unresolved-asset', `${ref}: blog.json has no asset repo "${key}"`);
    const { repo, folder } = parseRepoRef(where);
    const url = `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(at(folder, file))}&per_page=1`;
    const res = await fetch(url, { headers });
    const list = res.ok ? await res.json() : [];
    if (!list.length) throw new Refusal('unresolved-asset', `${ref}: no file at ${repo}/${at(folder, file)}`);
    lock[`${key}/${file}`] = list[0].sha;
    console.log(`pinned ${ref} -> ${list[0].sha.slice(0, 10)}`);
    added++;
  }
  const sorted = Object.fromEntries(Object.entries(lock).sort(([a], [b]) => (a < b ? -1 : 1)));
  await fs.writeFile(path.join(dir, 'assets.lock.json'), JSON.stringify(sorted, null, 2) + '\n');
  console.log(added ? `${added} reference(s) pinned` : 'nothing to pin');
  return 0;
}

// "owner/repo[/folder]@ref" -> { where, ref }
function splitAt(spec) {
  const i = (spec || '').lastIndexOf('@');
  if (i < 1 || i === spec.length - 1) throw new Refusal('unpinned-ref', `write it as owner/repo@<tag or commit>, got "${spec}"; a pin always names a ref`);
  return { where: spec.slice(0, i), ref: spec.slice(i + 1) };
}

async function writeBlogJson(dir, mutate) {
  const file = path.join(dir, 'blog.json');
  if (!(await exists(file))) throw new Refusal('no-blog-json', `no blog.json in ${path.resolve(dir)}`);
  const blog = JSON.parse(await fs.readFile(file, 'utf8'));
  mutate(blog);
  validateBlog(blog);
  await fs.writeFile(file, blogJsonText(blog));
}

async function theme(args) {
  const [sub, a, b] = args;
  if (sub === 'pin') {
    const { where, ref } = splitAt(a);
    const { pin, manifest } = await readThemeToPin(github(), where, ref);
    await writeBlogJson(b || '.', (blog) => { blog.theme = pin; });
    console.log(`pinned theme ${manifest.name} ${manifest.version} (${manifest.licence}) — ${pin.repo}@${pin.ref}\nsha256 ${pin.sha256}\nnow run: blog-webcli build`);
    return 0;
  }
  if (sub === 'clear') {
    await writeBlogJson(a || '.', (blog) => { delete blog.theme; });
    console.log('theme cleared; run: blog-webcli build');
    return 0;
  }
  if (sub === 'import') {
    return importWordPressTheme(a, b || `theme-${a}`);
  }
  console.error('usage: blog-webcli theme <pin owner/repo@ref [dir] | clear [dir] | import slug [outdir]>');
  return 2;
}

async function ext(args) {
  const [sub, a, b] = args;
  if (sub === 'add') {
    const { where, ref } = splitAt(a);
    const { pin, manifest } = await readExtensionToPin(github(), where, ref, { fetchAsset: async (url) => { const r = await fetch(url); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; } });
    await writeBlogJson(b || '.', (blog) => {
      blog.extensions = [...(blog.extensions || []).filter((e) => e.repo !== pin.repo), pin];
    });
    console.log(`pinned extension ${manifest.name} ${manifest.version} (${manifest.licence}, ${manifest.kind}; hooks ${manifest.hooks.join(', ')}) — ${pin.repo}@${pin.ref}\nIt has not been run. Publish from the editor to run it in the sandbox and record its output.`);
    return 0;
  }
  if (sub === 'remove') {
    await writeBlogJson(b || '.', (blog) => {
      blog.extensions = (blog.extensions || []).filter((e) => e.repo !== a);
      if (!blog.extensions.length) delete blog.extensions;
    });
    console.log(`removed ${a}; run: blog-webcli build`);
    return 0;
  }
  console.error('usage: blog-webcli ext <add owner/repo@ref [dir] | remove owner/repo [dir]>');
  return 2;
}

async function commentsCmd(args) {
  const [sub, dir = '.'] = args;
  if (sub !== 'lift') {
    console.error('usage: blog-webcli comments lift [dir]   (moves "## Comments (N)" sections an old import left in posts into comments/<slug>.json)');
    return 2;
  }
  let moved = 0;
  for (const f of (await fs.readdir(path.join(dir, 'posts'))).filter((n) => n.endsWith('.md')).sort()) {
    const slug = f.slice(0, -3);
    const side = path.join(dir, 'comments', `${slug}.json`);
    if (await exists(side)) continue;
    const text = await fs.readFile(path.join(dir, 'posts', f), 'utf8');
    const r = liftComments(text);
    if (!r) continue;
    await fs.mkdir(path.join(dir, 'comments'), { recursive: true });
    await fs.writeFile(side, r.sidecar);
    await fs.writeFile(path.join(dir, 'posts', f), r.post);
    moved += r.count;
    console.log(`${slug}: ${r.count} comment${r.count === 1 ? '' : 's'} lifted${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`);
  }
  console.log(`${moved} comments lifted; run: blog-webcli build`);
  return 0;
}

async function licences(dir) {
  const { blog } = await load(dir);
  for (const r of licenceRecords(validateBlog(blog))) console.log(`${r.kind.padEnd(10)} ${String(r.name).padEnd(28)} ${String(r.version || '').padEnd(10)} ${r.licence}${r.repo ? `   ${r.repo}@${r.ref}` : '   (built in)'}`);
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = { comments: () => commentsCmd(rest), build: () => build(rest[0] || '.'), check: () => check(rest[0] || '.'), fmt: () => fmt(rest[0] || '.'), pin: () => pin(rest[0] || '.'), 'publish-due': () => publishDue(rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--now') || '.', rest), theme: () => theme(rest), ext: () => ext(rest), licences: () => licences(rest[0] || '.'), import: () => importWordPress(rest) };
if (!commands[cmd]) {
  console.error('usage: blog-webcli <build|check|fmt|publish-due|pin|theme|ext|licences|import> …');
  process.exit(2);
}
try {
  process.exitCode = await commands[cmd]();
} catch (e) {
  if (e instanceof Refusal) {
    console.error(`refused: ${e.message}`);
    process.exitCode = 1;
  } else throw e;
}

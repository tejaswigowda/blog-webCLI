#!/usr/bin/env node
// blog-webcli — generate, verify and normalise a blog repo.
//   build [dir]   regenerate index, pages and feed (refuses on any error)
//   check [dir]   regenerate in memory and fail on any difference (CI, gate B8)
//   fmt   [dir]   rewrite posts into canonical markdown
//   pin   [dir]   pin unpinned asset: references to commits, and verify video: release tags, via the GitHub API
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Refusal } from '../lib/errors.js';
import { buildSite, GENERATED_MARK, validateBlog, parsePost } from '../lib/blog.js';
import { splitFile, joinFile } from '../lib/frontmatter.js';
import { deltaToMd, mdToDelta } from '../lib/markdown.js';
import { collectAssetRefs, parseAssetRef } from '../lib/assets.js';
import { collectVideoRefs, parseVideoRef } from '../lib/video.js';
import { at, parseRepoRef } from '../lib/reporef.js';
import { blogAssetRefs } from '../lib/customize.js';

const exists = (p) => fs.access(p).then(() => true, () => false);

async function load(dir) {
  const bj = path.join(dir, 'blog.json');
  if (!(await exists(bj))) throw new Refusal('no-blog-json', `no blog.json in ${path.resolve(dir)}`);
  const blog = await fs.readFile(bj, 'utf8');
  const posts = [];
  const pdir = path.join(dir, 'posts');
  if (await exists(pdir)) {
    for (const f of (await fs.readdir(pdir)).sort()) {
      if (f.endsWith('.md')) posts.push({ path: `posts/${f}`, text: await fs.readFile(path.join(pdir, f), 'utf8') });
    }
  }
  const lp = path.join(dir, 'assets.lock.json');
  const lock = (await exists(lp)) ? JSON.parse(await fs.readFile(lp, 'utf8')) : {};
  return { blog, posts, lock };
}

async function generate(dir) {
  const { blog, posts, lock } = await load(dir);
  return buildSite({ blog, posts, lock });
}

async function staleDirs(dir, expected) {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name === 'posts' || ent.name === 'index') continue;
    const f = path.join(dir, ent.name, 'index.html');
    if (!(await exists(f))) continue;
    if (!expected.has(`${ent.name}/index.html`) && (await fs.readFile(f, 'utf8')).includes(GENERATED_MARK)) out.push(`${ent.name}/index.html`);
  }
  return out;
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
    console.log(`removed stale ${rel}`);
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

const [cmd, dirArg] = process.argv.slice(2);
const commands = { build, check, fmt, pin };
if (!commands[cmd]) {
  console.error('usage: blog-webcli <build|check|fmt|pin> [dir]');
  process.exit(2);
}
try {
  process.exitCode = await commands[cmd](dirArg || '.');
} catch (e) {
  if (e instanceof Refusal) {
    console.error(`refused: ${e.message}`);
    process.exitCode = 1;
  } else throw e;
}

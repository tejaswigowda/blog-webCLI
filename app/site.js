// Reader and publisher cores. No DOM: the UI calls these, and so do the tests.
import { Refusal } from '../lib/errors.js';
import { POST_PATH, buildSite, parsePost, validateBlog } from '../lib/blog.js';
import { SLUG_RE, parseMeta, splitFile } from '../lib/frontmatter.js';
import { collectAssetRefs, parseAssetRef, resolveAsset } from '../lib/assets.js';
import { deltaToHtml } from '../lib/html.js';
import { collectVideoRefs, parseVideoRef, videoEmbedUrl } from '../lib/video.js';
import { at, parseRepoRef } from '../lib/reporef.js';
import { blogAssetRefs } from '../lib/customize.js';
import { blogJsonText, makeBlogJson } from '../lib/init.js';
import { gitBlobSha } from './github.js';
import { fmtBytes } from './net.js';

const enc = new TextEncoder();
const json = (o) => JSON.stringify(o, null, 2) + '\n';
export const PLACEHOLDER_SHA = '0'.repeat(40);

export class NotFound extends Error {}

// `owner/name` or `owner/name/folder`; the folder is where the blog lives inside the repository.
export function parseRepo(s) {
  return parseRepoRef(s).ref;
}

// ---------- reading ----------

export async function loadBlog(gh, where, ref) {
  const { repo, folder } = parseRepoRef(where);
  const text = await gh.readText(repo, at(folder, 'blog.json'), ref);
  if (text === null) throw new Refusal('no-blog-json', `${repo} has no ${at(folder, 'blog.json')}`);
  const blog = validateBlog(text);
  const lockText = await gh.readText(repo, at(folder, 'assets.lock.json'), ref);
  return { blog, lock: lockText ? JSON.parse(lockText) : {} };
}

// The generated index when present; otherwise list posts/ and read frontmatter.
export async function loadIndex(gh, where, ref) {
  const { repo, folder } = parseRepoRef(where);
  const text = await gh.readText(repo, at(folder, 'index/posts.json'), ref);
  if (text !== null) return JSON.parse(text).posts;
  const names = (await listPostFiles(gh, where, ref));
  const entries = [];
  for (const n of names) {
    const raw = await gh.readText(repo, at(folder, `posts/${n}`), ref);
    try {
      const m = parseMeta(splitFile(raw, n).front, n);
      if (m.status === 'published') entries.push({ slug: m.slug, title: m.title, date: m.date, tags: m.tags || [], excerpt: '', cover: m.cover || null, status: 'published' });
    } catch {
      /* unreadable posts are simply not listed */
    }
  }
  return entries.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function listPostFiles(gh, where, ref) {
  const { repo, folder } = parseRepoRef(where);
  return (await gh.listDir(repo, at(folder, 'posts'), ref)).filter((n) => n.endsWith('.md'));
}

export async function loadPost(gh, where, slug, ref, { blog, lock }, { allowDraft = false } = {}) {
  if (!SLUG_RE.test(slug)) throw new NotFound('No such post.');
  const { repo, folder } = parseRepoRef(where);
  const text = await gh.readText(repo, at(folder, `posts/${slug}.md`), ref);
  if (text === null) throw new NotFound('No such post.');
  const post = parsePost({ path: `posts/${slug}.md`, text });
  if (post.lossy) throw post.lossy.at(post.path);
  if (post.status !== 'published' && !allowDraft) throw new NotFound('No such post.');
  const resolve = (r) => resolveAsset(r, blog, lock);
  return { post, text, html: deltaToHtml(post.delta, { resolve, resolveVideo: (r) => videoEmbedUrl(r, blog), strict: false }) };
}

// Releases published by hls.webcli.app into each configured video repository.
export async function listVideoReleases(gh, blog) {
  const out = [];
  for (const [key, repo] of Object.entries((blog.video && blog.video.repos) || {})) {
    for (const tag of await gh.tags(parseRepoRef(repo).repo)) {
      const m = /^(.+)\/v([1-9]\d*)$/.exec(tag);
      if (m) out.push({ key, repo, slug: m[1], version: Number(m[2]), ref: `video:${key}/${m[1]}@v${m[2]}` });
    }
  }
  return out.filter((r) => { try { parseVideoRef(r.ref); return true; } catch { return false; } })
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : b.version - a.version));
}

// ---------- publishing ----------

const sortLock = (lock) => Object.fromEntries(Object.entries(lock).sort(([a], [b]) => (a < b ? -1 : 1)));

// `tree` is relative to the blog's folder; `prefix` puts the changes back where they live in the repository.
async function computeChanges({ blogText, others, newPost, lock, lockChanged, tree, prevIndex, prefix = '' }) {
  const posts = [...others, { path: newPost.path, text: newPost.text }];
  const site = buildSite({ blog: blogText, posts, lock });
  if (site.errors.length) {
    const first = site.errors[0];
    const e = new Refusal(first.code, site.errors.map((x) => x.detail + (x.where ? ` (${x.where})` : '')).join('\n'));
    e.all = site.errors;
    throw e;
  }
  const out = { ...site.files, [newPost.path]: newPost.text };
  if (lockChanged) out['assets.lock.json'] = json(sortLock(lock));
  const changes = [];
  for (const [path, content] of Object.entries(out)) {
    const bytes = enc.encode(content);
    if (tree.get(path) !== (await gitBlobSha(bytes))) changes.push({ path: prefix + path, content, size: bytes.length, action: tree.has(path) ? 'update' : 'add' });
  }
  if (prevIndex) {
    const now = new Set(site.index.map((e) => e.slug));
    for (const e of prevIndex.posts || []) {
      const p = `${e.slug}/index.html`;
      if (!now.has(e.slug) && tree.has(p)) changes.push({ path: prefix + p, delete: true, size: 0, action: 'delete' });
    }
  }
  return { site, changes };
}

// staged: [{ key, path, bytes: Uint8Array }] images the author added and has not uploaded.
export async function planChange(gh, { repo: where, branch, slug, text, staged = [], mode = 'direct', create = false }) {
  const { repo, folder } = parseRepoRef(where);
  const prefix = folder ? `${folder}/` : '';
  const head = await gh.headCommit(repo, branch);
  const whole = await gh.tree(repo, head.treeSha);
  // The blog sees only its own folder; everything else in the repository is not its business.
  const tree = new Map([...whole].filter(([p]) => p.startsWith(prefix)).map(([p, sha]) => [p.slice(prefix.length), sha]));
  const blogText = await gh.readText(repo, prefix + 'blog.json', head.sha);
  if (blogText === null) throw new Refusal('no-blog-json', `${repo} has no ${prefix}blog.json`);
  const blog = validateBlog(blogText);
  const lock = tree.has('assets.lock.json') ? JSON.parse(await gh.readText(repo, prefix + 'assets.lock.json', head.sha)) : {};
  const target = `posts/${slug}.md`;
  if (create && tree.has(target)) throw new Refusal('slug-collision', `${target} already exists; a slug is set once and never reused`);
  const newPost = parsePost({ path: target, text });
  if (newPost.lossy) throw newPost.lossy.at(target);

  const otherPaths = [...tree.keys()].filter((p) => POST_PATH.test(p) && p !== target);
  const others = await Promise.all(otherPaths.map(async (path) => ({ path, text: await gh.readText(repo, prefix + path, head.sha) })));

  const stagedByKey = new Map(staged.map((s) => [`${s.key}/${s.path}`, s]));
  const pending = [];
  let lockChanged = false;
  const lockPlan = { ...lock };
  // Pin every reference the site needs. Staged images are pinned after upload; a draft
  // may still carry references that do not resolve yet, a published post may not.
  const refs = new Set(collectAssetRefs(newPost.delta, newPost.meta));
  for (const r of blogAssetRefs(blog)) refs.add(r);
  for (const ref of refs) {
    const { key, path } = parseAssetRef(ref);
    const lk = `${key}/${path}`;
    if (lockPlan[lk]) continue;
    if (stagedByKey.has(lk)) {
      lockPlan[lk] = PLACEHOLDER_SHA;
      pending.push(lk);
    } else if (newPost.status === 'published' || blogAssetRefs(blog).includes(ref)) {
      const assetWhere = blog.assets && blog.assets.repos[key];
      if (!assetWhere) throw new Refusal('unresolved-asset', `${ref}: blog.json has no asset repo "${key}"`, target);
      const a = parseRepoRef(assetWhere);
      const sha = await gh.pathSha(a.repo, at(a.folder, path));
      if (!sha) throw new Refusal('unresolved-asset', `${ref}: no file at ${a.repo}/${at(a.folder, path)}`, target);
      lockPlan[lk] = sha;
    } else continue;
    lockChanged = true;
  }

  // A published post may only embed a release that exists; a tag never moves, so that is the pin.
  if (newPost.status === 'published') {
    for (const ref of collectVideoRefs(newPost.delta)) {
      const { key, tag } = parseVideoRef(ref);
      const videoRepo = blog.video && blog.video.repos[key];
      if (!videoRepo) throw new Refusal('unresolved-asset', `${ref}: blog.json has no video repo "${key}"`, target);
      if (!(await gh.tagExists(parseRepoRef(videoRepo).repo, tag))) throw new Refusal('unresolved-asset', `${ref}: ${videoRepo} has no release tagged ${tag}`, target);
    }
  }

  const prevIndexText = tree.has('index/posts.json') ? await gh.readText(repo, prefix + 'index/posts.json', head.sha) : null;
  const prevIndex = prevIndexText ? JSON.parse(prevIndexText) : null;
  const ctx = { blogText, others, newPost: { path: target, text }, tree, prevIndex, prefix };
  const { changes } = await computeChanges({ ...ctx, lock: lockPlan, lockChanged });

  const assetGroups = [];
  for (const s of staged.filter((s) => pending.includes(`${s.key}/${s.path}`))) {
    const a = parseRepoRef(blog.assets.repos[s.key]);
    let g = assetGroups.find((x) => x.repo === a.repo);
    if (!g) {
      g = { repo: a.repo, branch: (await gh.repoInfo(a.repo)).default_branch, files: [] };
      assetGroups.push(g);
    }
    g.files.push({ path: at(a.folder, s.path), key: s.key, logical: s.path, content: s.bytes, size: s.bytes.length, action: 'add' });
  }
  if (mode === 'pr' && assetGroups.some((g) => g.repo === repo)) {
    throw new Error('A correction opens a pull request and leaves the default branch alone, but these images would be committed to this repository directly. Publish the images in a normal edit first.');
  }

  const summary = [];
  for (const g of assetGroups) summary.push({ repo: g.repo, branch: g.branch, files: g.files.length, bytes: g.files.reduce((n, f) => n + f.size, 0) });
  const sizeOf = (f) => f.size;
  summary.push({ repo, folder, branch: mode === 'pr' ? `new branch from ${branch}` : branch, files: changes.length, bytes: changes.reduce((n, f) => n + sizeOf(f), 0) });

  return { repo, folder, branch, mode, slug, status: newPost.status, title: newPost.meta.title, existed: tree.has(target), head, changes, assetGroups, summary, ctx, lockPlan, pending };
}

// Create a blog where there is none: blog.json, and the generated site for whatever posts
// are already there (none is fine), in one commit. Refuses to touch an existing blog.json.
export async function planInit(gh, { repo: where, branch, fields }) {
  const { repo, folder } = parseRepoRef(where);
  const prefix = folder ? `${folder}/` : '';
  const head = await gh.headCommit(repo, branch);
  const whole = await gh.tree(repo, head.treeSha);
  if (whole.has(prefix + 'blog.json')) throw new Error(`${repo} already has ${prefix}blog.json; open it instead of creating it.`);
  const tree = new Map([...whole].filter(([p]) => p.startsWith(prefix)).map(([p, sha]) => [p.slice(prefix.length), sha]));

  let blogText;
  try {
    blogText = blogJsonText(makeBlogJson(where, fields));
  } catch (e) {
    throw e instanceof Refusal ? e : new Refusal('bad-blog-json', e.message);
  }
  validateBlog(blogText);

  const postPaths = [...tree.keys()].filter((p) => POST_PATH.test(p));
  const posts = await Promise.all(postPaths.map(async (path) => ({ path, text: await gh.readText(repo, prefix + path, head.sha) })));
  const lock = tree.has('assets.lock.json') ? JSON.parse(await gh.readText(repo, prefix + 'assets.lock.json', head.sha)) : {};
  const site = buildSite({ blog: blogText, posts, lock });
  if (site.errors.length) {
    const e = new Refusal(site.errors[0].code, site.errors.map((x) => x.detail + (x.where ? ` (${x.where})` : '')).join('\n'));
    e.all = site.errors;
    throw e;
  }

  const changes = [];
  for (const [path, content] of Object.entries({ 'blog.json': blogText, ...site.files })) {
    const bytes = enc.encode(content);
    if (tree.get(path) !== (await gitBlobSha(bytes))) changes.push({ path: prefix + path, content, size: bytes.length, action: tree.has(path) ? 'update' : 'add' });
  }
  const summary = [{ repo, folder, branch, files: changes.length, bytes: changes.reduce((n, f) => n + f.size, 0) }];
  return { repo, folder, branch, mode: 'direct', slug: '', status: 'published', title: fields.title, message: `Create blog: ${fields.title.trim()}`, existed: false, head, changes, assetGroups: [], summary, ctx: null, lockPlan: {}, pending: [] };
}

export function describePlan(plan) {
  return plan.summary.map((s) => `${s.files} file${s.files === 1 ? '' : 's'}, ${fmtBytes(s.bytes)}, to github.com/${s.repo} (${s.branch})${s.folder ? ` in ${s.folder}/` : ''}`);
}

// Upload staged assets first (their commit shas become the pins), regenerate with the
// real pins, then commit the blog in one commit. Returns a receipt.
export async function executePlan(gh, plan, { pullBody = '' } = {}) {
  const receipt = { commits: [], pull: null };
  const finalLock = { ...plan.lockPlan };

  let parent = plan.head.sha;
  let baseTree = plan.head.treeSha;

  for (const g of plan.assetGroups) {
    // Sharing the blog's repository and branch: build on the planned head, so work pushed
    // since planning still makes the final fast-forward fail instead of being overwritten.
    const shared = g.repo === plan.repo && g.branch === plan.branch;
    const h = shared ? plan.head : await gh.headCommit(g.repo, g.branch);
    const c = await gh.commit(g.repo, {
      branch: g.branch,
      parent: h.sha,
      baseTree: h.treeSha,
      files: g.files.map((f) => ({ path: f.path, content: f.content })),
      message: `Add ${g.files.length} asset${g.files.length === 1 ? '' : 's'} for "${plan.title}"`,
    });
    receipt.commits.push({ repo: g.repo, branch: g.branch, ...c, files: g.files.length });
    if (shared) {
      parent = c.sha;
      baseTree = c.treeSha;
    }
    for (const f of g.files) finalLock[`${f.key}/${f.logical}`] = c.sha; // the upload commit is the pin
  }

  // Page content embeds the pin, so regenerate now that real shas exist.
  let changes = plan.changes;
  if (plan.pending.length) ({ changes } = await computeChanges({ ...plan.ctx, lock: finalLock, lockChanged: true }));
  if (!changes.length) return receipt;

  const verb = plan.mode === 'pr' ? 'Correct' : plan.status === 'draft' ? 'Draft' : plan.existed ? 'Update' : 'Publish';
  const message = plan.message || `${verb}: ${plan.title}`;
  const newBranch = plan.mode === 'pr' ? `correction/${plan.slug}-${Date.now().toString(36)}` : null;
  const c = await gh.commit(plan.repo, {
    branch: newBranch || plan.branch,
    parent,
    baseTree,
    files: changes.map((f) => (f.delete ? { path: f.path, delete: true } : { path: f.path, content: f.content })),
    message,
    newBranch: !!newBranch,
  });
  receipt.commits.push({ repo: plan.repo, branch: newBranch || plan.branch, ...c, files: changes.length });
  if (newBranch) {
    const pr = await gh.createPull(plan.repo, { title: message, head: newBranch, base: plan.branch, body: pullBody || `Proposed correction to \`${at(plan.folder, `posts/${plan.slug}.md`)}\`.` });
    receipt.pull = { url: pr.html_url, number: pr.number };
  }
  return receipt;
}

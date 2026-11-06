// Reader and publisher cores. No DOM: the UI calls these, and so do the tests.
import { Refusal } from '../lib/errors.js';
import { POST_PATH, parsePost, validateBlog } from '../lib/blog.js';
import { buildSiteWith } from '../lib/build-async.js';
import { parseOutputsFile } from '../lib/extensions.js';
import { loadPacks, readExtensionToPin, readThemeToPin } from './packs.js';
import { licenceRecords } from '../lib/licences.js';
import { collectAssetRefs, parseAssetRef } from '../lib/assets.js';
import { collectVideoRefs, parseVideoRef } from '../lib/video.js';
import { at, parseRepoRef } from '../lib/reporef.js';
import { blogAssetRefs } from '../lib/customize.js';
import { blogJsonText, makeBlogJson } from '../lib/init.js';
import { formToBlog } from '../lib/settings.js';
import { gitBlobSha } from './github.js';
import { fmtBytes } from './net.js';
import { addressFrom } from '../lib/init.js';

const enc = new TextEncoder();
const json = (o) => JSON.stringify(o, null, 2) + '\n';
export const PLACEHOLDER_SHA = '0'.repeat(40);

export { NotFound, listPostFiles, loadBlog, loadIndex, loadPost, parseRepo } from './read.js';

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

// The site for a blog.json and its posts: the pinned theme and extensions are fetched and verified,
// recorded extension outputs are read from the repository, and any output still missing is
// produced by `runner` (the sandbox) — or refused when there is none.
async function generate(gh, { repo, prefix, head, tree, blogText, posts, lock, runner }) {
  const blog = validateBlog(blogText);
  const packs = await loadPacks(gh, blog);
  const recorded = tree.has('extension-outputs.json') ? await gh.readText(repo, prefix + 'extension-outputs.json', head.sha) : null;
  const site = await buildSiteWith({ blog: blogText, posts, lock, ...packs, outputs: parseOutputsFile(recorded) }, runner);
  if (site.errors.length) {
    const e = new Refusal(site.errors[0].code, site.errors.map((x) => x.detail + (x.where ? ` (${x.where})` : '')).join('\n'));
    e.all = site.errors;
    throw e;
  }
  return site;
}

// Generated files that disappear when the feature that made them is switched off.
const OPTIONAL_GENERATED = ['theme.css', 'extension-outputs.json'];
const staleOptional = (site, tree, prefix) => OPTIONAL_GENERATED.filter((f) => tree.has(f) && !(f in site.files)).map((f) => ({ path: prefix + f, delete: true, size: 0, action: 'delete' }));

// `tree` is relative to the blog's folder; `prefix` puts the changes back where they live in the repository.
async function computeChanges(gh, { blogText, others, newPost, lock, lockChanged, tree, prevIndex, prefix = '', repo, head, runner }) {
  const posts = [...others, { path: newPost.path, text: newPost.text }];
  const site = await generate(gh, { repo, prefix, head, tree, blogText, posts, lock, runner });
  const out = { ...site.files, [newPost.path]: newPost.text };
  if (lockChanged) out['assets.lock.json'] = json(sortLock(lock));
  const changes = [];
  for (const [path, content] of Object.entries(out)) {
    const bytes = enc.encode(content);
    if (tree.get(path) !== (await gitBlobSha(bytes))) changes.push({ path: prefix + path, content, size: bytes.length, action: tree.has(path) ? 'update' : 'add' });
  }
  changes.push(...staleOptional(site, tree, prefix));
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
export async function planChange(gh, { repo: where, branch, slug, text, staged = [], mode = 'direct', create = false, runner }) {
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
  const ctx = { blogText, others, newPost: { path: target, text }, tree, prevIndex, prefix, repo, head, runner };
  const { changes } = await computeChanges(gh, { ...ctx, lock: lockPlan, lockChanged });

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

// Commit a (new or changed) blog.json together with the site regenerated from it: every page
// embeds the blog's styles, header and footer, so a settings change touches them all. Blog-level
// assets (the header logo) are pinned here; a post that cannot be published as it is refuses the change.
async function planBlogJson(gh, { where, branch, head, whole, blogText, message, title, existed, runner }) {
  const { repo, folder } = parseRepoRef(where);
  const prefix = folder ? `${folder}/` : '';
  const tree = new Map([...whole].filter(([p]) => p.startsWith(prefix)).map(([p, sha]) => [p.slice(prefix.length), sha]));
  const blog = validateBlog(blogText);

  const postPaths = [...tree.keys()].filter((p) => POST_PATH.test(p));
  const posts = await Promise.all(postPaths.map(async (path) => ({ path, text: await gh.readText(repo, prefix + path, head.sha) })));
  const lock = tree.has('assets.lock.json') ? JSON.parse(await gh.readText(repo, prefix + 'assets.lock.json', head.sha)) : {};
  let lockChanged = false;
  for (const ref of blogAssetRefs(blog)) {
    const { key, path } = parseAssetRef(ref);
    if (lock[`${key}/${path}`]) continue;
    const assetWhere = blog.assets && blog.assets.repos[key];
    if (!assetWhere) throw new Refusal('unresolved-asset', `${ref}: blog.json has no asset repo "${key}"`);
    const a = parseRepoRef(assetWhere);
    const sha = await gh.pathSha(a.repo, at(a.folder, path));
    if (!sha) throw new Refusal('unresolved-asset', `${ref}: no file at ${a.repo}/${at(a.folder, path)}`);
    lock[`${key}/${path}`] = sha;
    lockChanged = true;
  }

  const site = await generate(gh, { repo, prefix, head, tree, blogText, posts, lock, runner });
  const out = { 'blog.json': blogText, ...site.files };
  if (lockChanged) out['assets.lock.json'] = json(sortLock(lock));
  const changes = [];
  for (const [path, content] of Object.entries(out)) {
    const bytes = enc.encode(content);
    if (tree.get(path) !== (await gitBlobSha(bytes))) changes.push({ path: prefix + path, content, size: bytes.length, action: tree.has(path) ? 'update' : 'add' });
  }
  changes.push(...staleOptional(site, tree, prefix));
  const summary = [{ repo, folder, branch, files: changes.length, bytes: changes.reduce((n, f) => n + f.size, 0) }];
  return { repo, folder, branch, mode: 'direct', slug: '', status: 'published', title, message, existed, head, changes, assetGroups: [], summary, ctx: null, lockPlan: {}, pending: [] };
}

// Create a blog where there is none: blog.json, and the generated site for whatever posts
// are already there (none is fine), in one commit. Refuses to touch an existing blog.json.
// Where this blog is served, as GitHub says: never typed in. With Pages on and readable, its own
// address (a custom domain included); otherwise what is already in blog.json, or the convention.
//   live:     GitHub Pages is enabled for the repository
//   exact:    the address is GitHub's, not a guess
//   built:    GitHub has built the site (Pages answers 404 for a site that is on but not yet deployed)
//   readable: the token could read the Pages settings (it needs "Pages: Read-only")
export async function detectAddress(gh, where) {
  const { repo } = parseRepoRef(where);
  const info = await gh.repoInfo(repo);
  const live = !!info.has_pages;
  let url = null;
  let built = false;
  let readable = true;
  if (live) {
    try {
      const pages = await gh.api('GET', `/repos/${repo}/pages`);
      url = pages.html_url || null;
      built = pages.status === 'built';
    } catch {
      readable = false;
    }
  }
  return { address: addressFrom(where, url), live, exact: !!url, built, readable, settingsUrl: `https://github.com/${repo}/settings/pages` };
}

export async function planInit(gh, { repo: where, branch, fields, runner }) {
  const { repo, folder } = parseRepoRef(where);
  const prefix = folder ? `${folder}/` : '';
  const head = await gh.headCommit(repo, branch);
  const whole = await gh.tree(repo, head.treeSha);
  if (whole.has(prefix + 'blog.json')) throw new Error(`${repo} already has ${prefix}blog.json; open it instead of creating it.`);
  let blogText;
  try {
    const found = await detectAddress(gh, where);
    blogText = blogJsonText(makeBlogJson(where, { ...fields, domain: found.address }));
  } catch (e) {
    throw e instanceof Refusal ? e : new Refusal('bad-blog-json', e.message);
  }
  return planBlogJson(gh, { where, branch, head, whole, blogText, message: `Create blog: ${fields.title.trim()}`, title: fields.title, existed: false, runner });
}

// Change the blog's settings. The form is applied to the blog.json on the branch (unknown keys
// survive), validated, and every generated page is regenerated from it.
export async function planSettings(gh, { repo: where, branch, form, runner }) {
  const { repo, folder } = parseRepoRef(where);
  const prefix = folder ? `${folder}/` : '';
  const head = await gh.headCommit(repo, branch);
  const whole = await gh.tree(repo, head.treeSha);
  const current = await gh.readText(repo, prefix + 'blog.json', head.sha);
  if (current === null) throw new Refusal('no-blog-json', `${repo} has no ${prefix}blog.json`);
  let blogText;
  try {
    const saved = JSON.parse(current);
    // the address is not a setting: GitHub's own when it can be read, else what blog.json already says
    const found = await detectAddress(gh, where).catch(() => null);
    const domain = found && found.exact ? found.address : saved.domain;
    blogText = blogJsonText(formToBlog(saved, { ...form, domain }));
  } catch (e) {
    throw e instanceof Refusal || e.code ? e : new Refusal('bad-blog-json', e.message);
  }
  const plan = await planBlogJson(gh, { where, branch, head, whole, blogText, message: 'Update blog settings', title: form.title, existed: true, runner });
  plan.unchanged = plan.changes.length === 0;
  return plan;
}

// ---------- themes and extensions ----------

async function currentBlogJson(gh, where, branch) {
  const { repo, folder } = parseRepoRef(where);
  const head = await gh.headCommit(repo, branch);
  const whole = await gh.tree(repo, head.treeSha);
  const text = await gh.readText(repo, at(folder, 'blog.json'), head.sha);
  if (text === null) throw new Refusal('no-blog-json', `${repo} has no ${at(folder, 'blog.json')}`);
  return { head, whole, blog: JSON.parse(text) };
}

// Embeds' pinned assets are verified once, when the extension is pinned, from the two hosts the
// editor is allowed to read from.
const assetFetcher = (gh) => async (url) => {
  const host = new URL(url).hostname;
  if (!['cdn.jsdelivr.net', 'raw.githubusercontent.com'].includes(host)) throw new Refusal('bad-extension', `cannot verify a pinned asset on ${host} here; host it on jsDelivr (gh/…@<tag or commit>) or GitHub raw`);
  const res = await gh.net.request(url);
  return res.ok ? res.bytes : null;
};

// Use (or stop using) a theme. `use` is { where: owner/repo[/folder], ref, base? }: found by address, so
// a theme that is in no list works. Every page is regenerated; the plan lists the licences involved.
export async function planTheme(gh, { repo: where, branch, use, runner }) {
  const { head, whole, blog } = await currentBlogJson(gh, where, branch);
  let message;
  if (use) {
    const { pin, manifest } = await readThemeToPin(gh, use.where, use.ref, { base: use.base });
    blog.theme = pin;
    message = `Use theme: ${manifest.name} ${manifest.version} (${manifest.licence})`;
  } else {
    delete blog.theme;
    message = 'Use the default theme';
  }
  const plan = await planBlogJson(gh, { where, branch, head, whole, blogText: blogJsonText(blog), message, title: blog.title, existed: true, runner });
  plan.licences = licenceRecords(validateBlog(blog));
  plan.unchanged = plan.changes.length === 0;
  return plan;
}

// Add (or replace) an extension, or remove one: `add` is { where, ref }, `remove` an owner/repo. The
// plan includes the sandbox's recorded output (extension-outputs.json); nothing runs outside the sandbox.
export async function planExtension(gh, { repo: where, branch, add, remove, runner }) {
  const { head, whole, blog } = await currentBlogJson(gh, where, branch);
  let message;
  if (add) {
    const { pin, manifest } = await readExtensionToPin(gh, add.where, add.ref, { fetchAsset: assetFetcher(gh) });
    blog.extensions = [...(blog.extensions || []).filter((e) => e.repo !== pin.repo), pin];
    message = `Add extension: ${manifest.name} ${manifest.version} (${manifest.licence})`;
  } else {
    blog.extensions = (blog.extensions || []).filter((e) => e.repo !== remove);
    if (!blog.extensions.length) delete blog.extensions;
    message = `Remove extension: ${remove}`;
  }
  const plan = await planBlogJson(gh, { where, branch, head, whole, blogText: blogJsonText(blog), message, title: blog.title, existed: true, runner });
  plan.licences = licenceRecords(validateBlog(blog));
  plan.unchanged = plan.changes.length === 0;
  return plan;
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
  if (plan.pending.length) ({ changes } = await computeChanges(gh, { ...plan.ctx, lock: finalLock, lockChanged: true }));
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

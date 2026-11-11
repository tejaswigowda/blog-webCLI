// Reader and publisher cores. No DOM: the UI calls these, and so do the tests.
import { Refusal } from '../lib/errors.js';
import { parseAliases } from '../lib/aliases.js';
import { addrOf, isDated } from '../lib/permalink.js';
import { BULK_AT } from './github.js';
import { CannotRebuild, loadSite } from '../lib/live-render.js';
import { prepareIncremental } from '../lib/incremental.js';
import { readIndex } from '../lib/index-data.js';
import { joinFile, setMeta, splitFile } from '../lib/frontmatter.js';
import { PAGE_PATH, POST_PATH, GENERATED_TREES, OPTIONAL_GENERATED, parsePost, validateBlog } from '../lib/blog.js';
import { buildSiteWith } from '../lib/build-async.js';
import { COMMENT_PATH, parseComments } from '../lib/comments.js';
import { parseOutputsFile } from '../lib/extensions.js';
import { loadPacks, readExtensionToPin, readThemeToPin } from './packs.js';
import { licenceRecords } from '../lib/licences.js';
import { collectAssetRefs, parseAssetRef } from '../lib/assets.js';
import { collectVideoRefs, parseVideoRef } from '../lib/video.js';
import { at, parseRepoRef } from '../lib/reporef.js';
import { blogAssetRefs, hasLook, themeCss, withoutLook } from '../lib/customize.js';
import { assertMeasured } from '../lib/measure.js';
import { applyThemeFile, parseThemeFile } from '../lib/theme-export.js';
import { resolveOrder } from '../lib/order.js';
import { sizeEntry } from '../lib/image-size.js';
import { IMAGE_FILE, imagePaths, mediaItems, tileUrl } from '../lib/media.js';
import { daysUntil } from '../lib/schedule.js';
import { affectedBy, relatedCount } from '../lib/related.js';
import { blogJsonText, makeBlogJson } from '../lib/init.js';
import { formToBlog } from '../lib/settings.js';
import { gitBlobSha } from './github.js';
import { fmtBytes } from './net.js';
import { addressFrom } from '../lib/init.js';

const enc = new TextEncoder();
const json = (o) => JSON.stringify(o, null, 2) + '\n';
export const PLACEHOLDER_SHA = '0'.repeat(40);

export { NotFound, listPageFiles, listPostFiles, loadBlog, loadIndex, loadIndexFull, loadPost, parseRepo } from './read.js';

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

// The images in each of the blog's asset repositories, with the pinned address a page would load them from. Listing is reading
// (the ledger counts it): nothing is uploaded. A repository that cannot be read is reported, not fatal.
export async function listMedia(gh, { blog, lock, index }) {
  const items = [];
  const problems = [];
  for (const [key, where] of Object.entries((blog.assets && blog.assets.repos) || {})) {
    try {
      const { repo } = parseRepoRef(where);
      const head = await gh.headCommit(repo, (await gh.repoInfo(repo)).default_branch);
      const tree = await gh.tree(repo, head.treeSha);
      for (const it of mediaItems({ key, paths: imagePaths(tree, where), lock, index })) items.push({ ...it, url: tileUrl(blog, key, it.path, lock[`${key}/${it.path}`] || head.sha) });
    } catch (e) {
      problems.push(`${key} (${where}): ${e.message || e}`);
    }
  }
  return { items, problems };
}

// ---------- publishing ----------

const sortLock = (lock) => Object.fromEntries(Object.entries(lock).sort(([a], [b]) => (a < b ? -1 : 1)));

// The site for a blog.json and its posts: the pinned theme and extensions are fetched and verified,
// recorded extension outputs are read from the repository, and any output still missing is
// produced by `runner` (the sandbox) — or refused when there is none.
async function generate(gh, { repo, prefix, head, tree, blogText, posts, lock, runner, orderText }) {
  const blog = validateBlog(blogText);
  const packs = await loadPacks(gh, blog);
  const recorded = tree.has('extension-outputs.json') ? await gh.readText(repo, prefix + 'extension-outputs.json', head.sha) : null;
  // a manual order is an authored file (order.json) beside blog.json; the generator reads it, never writes it
  const order = resolveOrder(blog);
  const orderList = orderText !== undefined ? orderText : order.by === 'manual' && tree.has(order.list) ? await gh.readText(repo, prefix + order.list, head.sha) : null;
  const site = await buildSiteWith({ blog: blogText, posts, lock, ...packs, outputs: parseOutputsFile(recorded), orderList }, runner);
  if (site.errors.length) {
    const e = new Refusal(site.errors[0].code, site.errors.map((x) => x.detail + (x.where ? ` (${x.where})` : '')).join('\n'));
    e.all = site.errors;
    throw e;
  }
  return site;
}

export { generate as generateSite };

// Generated files that disappear when the feature that made them is switched off, and anything left in a folder the
// generator owns (tags/, archive/, page/, …) that the build no longer writes.
const isContent = (p) => POST_PATH.test(p) || PAGE_PATH.test(p) || COMMENT_PATH.test(p); // a comments/<slug>.json travels with the posts
const staleOptional = (site, tree, prefix) =>
  [...tree.keys()]
    .filter((f) => !(f in site.files) && (OPTIONAL_GENERATED.includes(f) || GENERATED_TREES.some((t) => f.startsWith(`${t}/`))))
    .sort()
    .map((f) => ({ path: prefix + f, delete: true, size: 0, action: 'delete' }));

// Every post and page of the blog, as { path, text }. A big blog is read a hundred files to a request, patiently, with progress,
// and a file already read in this session (by its blob id) is not read again: see GitHub.readMany.
async function readPosts(gh, { repo, prefix, head, tree, paths }) {
  const texts = await gh.readMany(repo, paths.map((path) => ({ path: prefix + path, sha: tree.get(path) })), { ref: head.sha });
  return paths.map((path) => {
    const text = texts.get(prefix + path);
    if (text === undefined) throw new Refusal('missing-source', `${prefix + path} is in the repository's file list but could not be read (it may have been deleted or changed since; try again)`);
    return { path, text };
  });
}

// `tree` is relative to the blog's folder; `prefix` puts the changes back where they live in the repository.
// A change to one post of a big blog is made from the committed index and the few posts it touches (lib/incremental.js); anything that
// cannot be made that way, and a small blog, is made from every post, as it always was.
async function incrementalChanges(gh, ctx) {
  const { newPost, lock, lockChanged, tree, prevIndex, prefix = '', repo, head } = ctx;
  if (!prevIndex || !POST_PATH.test(newPost.path) || !tree.has('licences.json') || ctx.noIncremental) return null;
  const get = async (p) => {
    const t = await gh.readText(repo, prefix + p, head.sha);
    return t === null ? null : enc.encode(t);
  };
  try {
    ctx.site ||= await loadSite(get, { index: prevIndex, anyBlog: true });
  } catch (e) {
    if (e instanceof CannotRebuild) return null;
    throw e;
  }
  const slugs = new Set([...tree.keys()].map((p) => (POST_PATH.exec(p) || PAGE_PATH.exec(p) || [])[1]).filter(Boolean));
  const slug = POST_PATH.exec(newPost.path)[1];
  slugs.add(slug);
  const prep = prepareIncremental({ site: ctx.site, change: { path: newPost.path, text: newPost.text, ...(ctx.newComments !== undefined ? { comments: ctx.newComments } : {}) }, lock, slugs, existing: new Set(tree.keys()) });
  if (prep.reason) {
    ctx.noIncremental = true;
    return null;
  }
  const shas = prep.need.slugs.map((s) => ({ path: prefix + `posts/${s}.md`, sha: tree.get(`posts/${s}.md`) }));
  const read = await gh.readMany(repo, shas, { ref: head.sha });
  const texts = new Map(prep.need.slugs.map((s) => [s, read.get(prefix + `posts/${s}.md`)]));
  if ([...texts.values()].some((t) => t === undefined)) throw new Refusal('missing-source', 'a post the blog lists could not be read; try again');
  const files = new Map();
  for (const f of prep.need.files) {
    const t = await gh.readText(repo, prefix + f, head.sha);
    if (t === null) {
      ctx.noIncremental = true;
      return null;
    }
    files.set(f, t);
  }
  let res;
  try {
    res = prep.run({ texts, files });
  } catch (e) {
    if (e instanceof Refusal) throw e;
    ctx.noIncremental = true; // the committed files are not what the index says they are: build all of it
    return null;
  }
  const out = { ...res.files, [newPost.path]: newPost.text };
  if (lockChanged) out['assets.lock.json'] = json(sortLock(lock));
  const changes = [];
  for (const [path, content] of Object.entries(out)) {
    const bytes = enc.encode(content);
    if (tree.get(path) !== (await gitBlobSha(bytes))) changes.push({ path: prefix + path, content, size: bytes.length, action: tree.has(path) ? 'update' : 'add' });
  }
  for (const path of res.remove) if (tree.has(path)) changes.push({ path: prefix + path, delete: true, size: 0, action: 'delete' });
  return { site: { files: out, index: null, unlisted: [], related: prep.related }, changes };
}

async function computeChanges(gh, ctx) {
  const inc = await incrementalChanges(gh, ctx);
  if (inc) return inc;
  const { blogText, newPost, lock, lockChanged, tree, prevIndex, prefix = '', repo, head, runner } = ctx;
  ctx.others ||= await readPosts(gh, { repo, prefix, head, tree, paths: ctx.otherPaths });
  const others = ctx.others;
  const sidecarPath = `comments/${POST_PATH.exec(newPost.path)?.[1]}.json`;
  const posts = [...(ctx.newComments !== undefined ? others.filter((o) => o.path !== sidecarPath) : others), { path: newPost.path, text: newPost.text }, ...(ctx.newComments ? [{ path: sidecarPath, text: ctx.newComments }] : [])];
  const site = await generate(gh, { repo, prefix, head, tree, blogText, posts, lock, runner, orderText: ctx.orderText });
  const out = { ...site.files, [newPost.path]: newPost.text };
  if (lockChanged) out['assets.lock.json'] = json(sortLock(lock));
  const changes = [];
  for (const [path, content] of Object.entries(out)) {
    const bytes = enc.encode(content);
    if (tree.get(path) !== (await gitBlobSha(bytes))) changes.push({ path: prefix + path, content, size: bytes.length, action: tree.has(path) ? 'update' : 'add' });
  }
  changes.push(...staleOptional(site, tree, prefix));
  if (prevIndex) {
    // a post or page that is gone, or back to a draft, loses its generated page
    const now = new Set([...site.index.map((e) => e.path || e.slug), ...(site.pages || []).map((p) => p.slug)]);
    for (const e of [...(prevIndex.posts || []), ...(prevIndex.pages || [])]) {
      const p = `${e.path || e.slug}/index.html`;
      if (!now.has(e.path || e.slug) && tree.has(p) && !(p in site.files)) changes.push({ path: prefix + p, delete: true, size: 0, action: 'delete' });
    }
    // an old address that is no longer listed, or whose page is gone, loses its redirect
    for (const r of prevIndex.redirects || []) {
      const p = `${r.from}/index.html`;
      if (!(p in site.files) && tree.has(p)) changes.push({ path: prefix + p, delete: true, size: 0, action: 'delete' });
    }
  }
  return { site, changes };
}

// staged: [{ key, path, bytes: Uint8Array }] images the author added and has not uploaded.
// kind: 'post' (posts/<slug>.md) or 'page' (pages/<slug>.md, a standalone page).
// remove: delete posts/<slug>.md (or pages/<slug>.md). It is planned as the post going back to a draft, which already takes a post out of the
// index, the listings, the feed, the sitemap and search, and removes its generated page and redirects; then the source file goes too.
// comments: the post's comments/<slug>.json as it will be (text), or null to remove it; undefined leaves them as committed.
export async function planChange(gh, { repo: where, branch, slug, text, staged = [], mode = 'direct', create = false, kind = 'post', remove = false, runner, lockPatch = {}, comments }) {
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
  const target = `${kind === 'page' ? 'pages' : 'posts'}/${slug}.md`;
  if (create && tree.has(target)) throw new Refusal('slug-collision', `${target} already exists; a slug is set once and never reused`);
  // a post and a page share one address space: the second to claim a slug is refused
  const other = `${kind === 'page' ? 'posts' : 'pages'}/${slug}.md`;
  if (create && tree.has(other)) throw new Refusal('slug-collision', `${other} already uses "${slug}"; posts and pages share one address space`);
  let orderText;
  if (remove) {
    if (!tree.has(target)) throw new Refusal('missing-source', `${target} does not exist, so there is nothing to delete`);
    const was = await gh.readText(repo, prefix + target, head.sha);
    if (was === null) throw new Refusal('missing-source', `${target} could not be read`);
    const { front, body } = splitFile(was, target);
    text = joinFile(setMeta(front, 'status', 'draft'), body);
    // a hand-kept order that names the post would refuse the build once the file is gone
    const order = resolveOrder(blog);
    if (kind === 'post' && order.by === 'manual' && tree.has(order.list)) {
      const list = await gh.readText(repo, prefix + order.list, head.sha);
      const o = JSON.parse(list);
      if (Array.isArray(o.order) && o.order.includes(slug)) orderText = json({ ...o, order: o.order.filter((s) => s !== slug) });
    }
  }
  const newPost = parsePost({ path: target, text });
  if (newPost.lossy) throw newPost.lossy.at(target);

  const otherPaths = [...tree.keys()].filter((p) => isContent(p) && p !== target);

  const stagedByKey = new Map(staged.map((s) => [`${s.key}/${s.path}`, s]));
  const pending = [];
  let lockChanged = false;
  const lockPlan = { ...lock };
  for (const [k, sha] of Object.entries(lockPatch)) if (lockPlan[k] !== sha) { lockPlan[k] = sha; lockChanged = true; } // images replaced since: their pins move
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
    } else if (newPost.status !== 'draft' || blogAssetRefs(blog).includes(ref)) {
      const assetWhere = blog.assets && blog.assets.repos[key];
      if (!assetWhere) throw new Refusal('unresolved-asset', `${ref}: blog.json has no asset repo "${key}"`, target);
      const a = parseRepoRef(assetWhere);
      const sha = await gh.pathSha(a.repo, at(a.folder, path));
      if (!sha) throw new Refusal('unresolved-asset', `${ref}: no file at ${a.repo}/${at(a.folder, path)}`, target);
      lockPlan[lk] = sha;
    } else continue;
    lockChanged = true;
  }

  // A published (or scheduled) post may only embed a release that exists; a tag never moves, so that is the pin.
  if (newPost.status !== 'draft') {
    for (const ref of collectVideoRefs(newPost.delta)) {
      const { key, tag } = parseVideoRef(ref);
      const videoRepo = blog.video && blog.video.repos[key];
      if (!videoRepo) throw new Refusal('unresolved-asset', `${ref}: blog.json has no video repo "${key}"`, target);
      if (!(await gh.tagExists(parseRepoRef(videoRepo).repo, tag))) throw new Refusal('unresolved-asset', `${ref}: ${videoRepo} has no release tagged ${tag}`, target);
    }
  }

  const prevIndex = tree.has('index/posts.json') ? await readIndex((p) => gh.readText(repo, prefix + p, head.sha)) : null;
  if (comments !== undefined && comments !== null) parseComments(comments, `comments/${slug}.json`); // judged before anything is built
  // a dated address depends on `date`: editing the date of a published post must not quietly move it
  if (prevIndex && isDated(blog) && newPost.status === 'published' && kind !== 'page' && !remove) {
    const was = (prevIndex.posts || []).find((e) => e.slug === slug && e.status === 'published');
    const to = addrOf(blog, { slug, date: newPost.meta.date });
    if (was && (was.path || was.slug) !== to && !parseAliases(newPost.meta, target).includes(was.path || was.slug)) {
      throw new Refusal('permalink-move', `changing the date moves this post from ${was.path || was.slug}/ to ${to}/; add "${was.path || was.slug}" to its aliases if the move is intended, or keep the date`, target);
    }
  }
  const ctx = { blogText, otherPaths, others: null, newPost: { path: target, text }, tree, prevIndex, prefix, repo, head, runner, orderText, newComments: comments };
  const { site, changes } = await computeChanges(gh, { ...ctx, lock: lockPlan, lockChanged });
  if (comments !== undefined) {
    const cp = `comments/${slug}.json`;
    if (comments === null) {
      if (tree.has(cp)) changes.push({ path: prefix + cp, delete: true, size: 0, action: 'delete' });
    } else if (tree.get(cp) !== (await gitBlobSha(enc.encode(comments)))) changes.push({ path: prefix + cp, content: comments, size: enc.encode(comments).length, action: tree.has(cp) ? 'update' : 'add' });
  }
  if (remove) {
    const gone = changes.findIndex((c) => c.path === prefix + target);
    if (gone >= 0) changes.splice(gone, 1);
    changes.push({ path: prefix + target, delete: true, size: 0, action: 'delete' });
    if (orderText !== undefined) changes.push({ path: prefix + resolveOrder(blog).list, content: orderText, size: enc.encode(orderText).length, action: 'update' });
  }

  // Related posts make a page depend on every post sharing a tag with it: say how many pages this one change rewrites.
  const rc = relatedCount(blog);
  let relatedPages = 0;
  if (rc && !remove) {
    if (site.related !== undefined) relatedPages = site.related;
    else if (prevIndex && Array.isArray(site.index)) relatedPages = affectedBy({ oldEntries: prevIndex.posts || [], oldSequence: prevIndex.sequence || (prevIndex.posts || []).map((e) => e.slug), newEntries: site.index, newSequence: site.index.map((e) => e.slug), slug, count: rc }).length;
  }

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

  return { repo, folder, branch, mode, slug, kind, path: target, removed: remove, status: newPost.status, schedule: newPost.status === 'scheduled' ? { at: newPost.meta.publish_at, zone: blog.timezone || null, days: daysUntil(newPost.meta, blog), extensionsRun: !!(blog.extensions && blog.extensions.length) } : null, related: rc ? relatedPages : null, title: newPost.meta.title, existed: tree.has(target), head, changes, assetGroups, summary, ctx, lockPlan, pending, unlisted: site.unlisted || [], orderFile: resolveOrder(blog).by === 'manual' ? resolveOrder(blog).list : null };
}

// Commit a (new or changed) blog.json together with the site regenerated from it: every page
// embeds the blog's styles, header and footer, so a settings change touches them all. Blog-level
// assets (the header logo) are pinned here; a post that cannot be published as it is refuses the change.
async function planBlogJson(gh, { where, branch, head, whole, blogText, message, title, existed, runner, extraPosts = [], lockPatch = {} }) {
  const { repo, folder } = parseRepoRef(where);
  const prefix = folder ? `${folder}/` : '';
  const tree = new Map([...whole].filter(([p]) => p.startsWith(prefix)).map(([p, sha]) => [p.slice(prefix.length), sha]));
  const blog = validateBlog(blogText);

  const postPaths = [...tree.keys()].filter(isContent);
  const posts = [...(await readPosts(gh, { repo, prefix, head, tree, paths: postPaths })), ...extraPosts.filter((x) => !tree.has(x.path))]; // a page the kit adds, never over one that is there
  const lock = tree.has('assets.lock.json') ? JSON.parse(await gh.readText(repo, prefix + 'assets.lock.json', head.sha)) : {};
  let lockChanged = false;
  for (const [k, sha] of Object.entries(lockPatch)) if (lock[k] !== sha) { lock[k] = sha; lockChanged = true; } // images replaced since: their pins move to the upload
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
  for (const x of extraPosts) if (!tree.has(x.path)) out[x.path] = x.text;
  if (lockChanged) out['assets.lock.json'] = json(sortLock(lock));
  const changes = [];
  for (const [path, content] of Object.entries(out)) {
    const bytes = enc.encode(content);
    if (tree.get(path) !== (await gitBlobSha(bytes))) changes.push({ path: prefix + path, content, size: bytes.length, action: tree.has(path) ? 'update' : 'add' });
  }
  changes.push(...staleOptional(site, tree, prefix));
  const summary = [{ repo, folder, branch, files: changes.length, bytes: changes.reduce((n, f) => n + f.size, 0) }];
  return { repo, folder, branch, mode: 'direct', slug: '', status: 'published', title, message, existed, head, changes, assetGroups: [], summary, ctx: null, lockPlan: {}, pending: [], unlisted: site.unlisted || [], orderFile: resolveOrder(blog).by === 'manual' ? resolveOrder(blog).list : null };
}

// A change that only touches the blog's CSS (colours, fonts, width, size, custom CSS) on a blog whose stylesheet is one shared file: the
// pages do not carry the CSS, so none of them changes. Only blog.json, style.css and, with a theme, theme.css (what the /blog/ reader
// applies) are written, and no post is read. Returns null when it is not that kind of change (inline CSS, an extension, a different theme,
// any other setting), and the caller regenerates the blog as it always did.
const CSS_KEYS = ['colors', 'font', 'headingFont', 'width', 'fontSize', 'css'];
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const withoutCss = (blog) => {
  const b = structuredClone(blog);
  if (b.customize) {
    for (const k of CSS_KEYS) delete b.customize[k];
    if (!Object.keys(b.customize).length) delete b.customize;
  }
  return JSON.stringify(canon(b));
};
async function styleOnlyPlan(gh, { where, branch, head, whole, oldBlog, blogText, message, title }) {
  const { repo, folder } = parseRepoRef(where);
  const prefix = folder ? `${folder}/` : '';
  let next;
  try { next = JSON.parse(blogText); } catch { return null; }
  if (oldBlog.stylesheet !== 'linked' || next.stylesheet !== 'linked') return null;
  if ((oldBlog.extensions && oldBlog.extensions.length) || (next.extensions && next.extensions.length)) return null;
  if (withoutCss(oldBlog) !== withoutCss(next)) return null;
  const blog = validateBlog(blogText);
  const packs = await loadPacks(gh, blog);
  const css = themeCss(blog, packs.theme || null) + '\n';
  const tree = new Map([...whole].filter(([p]) => p.startsWith(prefix)).map(([p, sha]) => [p.slice(prefix.length), sha]));
  if (!tree.has('style.css')) return null; // never written as a linked blog: build it all once
  const out = { 'blog.json': blogText, 'style.css': css };
  if (packs.theme) out['theme.css'] = css;
  const changes = [];
  for (const [path, content] of Object.entries(out)) {
    const bytes = enc.encode(content);
    if (tree.get(path) !== (await gitBlobSha(bytes))) changes.push({ path: prefix + path, content, size: bytes.length, action: tree.has(path) ? 'update' : 'add' });
  }
  const summary = [{ repo, folder, branch, files: changes.length, bytes: changes.reduce((n, f) => n + f.size, 0) }];
  return { repo, folder, branch, mode: 'direct', slug: '', status: 'published', title, message, existed: true, head, changes, assetGroups: [], summary, ctx: null, lockPlan: {}, pending: [], unlisted: [], orderFile: null, styleOnly: true, headline: ['Only the stylesheet changes: every page links the one shared style.css, so no page is rewritten and no post is read.'] };
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
  const plan = (await styleOnlyPlan(gh, { where, branch, head, whole, oldBlog: JSON.parse(current), blogText, message: 'Update blog settings', title: form.title })) || (await planBlogJson(gh, { where, branch, head, whole, blogText, message: 'Update blog settings', title: form.title, existed: true, runner }));
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
export async function planTheme(gh, { repo: where, branch, use, fresh = false, runner }) {
  const { head, whole, blog } = await currentBlogJson(gh, where, branch);
  let message;
  let kit = null;
  if (use) {
    const { pin, manifest } = await readThemeToPin(gh, use.where, use.ref, { base: use.base, expect: use.expect });
    blog.theme = pin;
    kit = manifest.kit || null;
    message = `Use theme: ${manifest.name} ${manifest.version} (${manifest.licence})`;
  } else {
    delete blog.theme;
    message = 'Use the default theme';
  }
  const extraPosts = [];
  if (fresh && kit) {
    // the theme's bootstrap kit replaces the blog's whole customize block; its home page is added only where the blog has none
    if (kit.customize) blog.customize = structuredClone(kit.customize);
    else delete blog.customize;
    const prefix = parseRepoRef(where).folder ? `${parseRepoRef(where).folder}/` : '';
    if (kit.home && !whole.has(`${prefix}pages/home.md`)) extraPosts.push({ path: 'pages/home.md', text: `---\nslug: home\ntitle: Home\nstatus: published\n---\n\n${kit.home.trim()}\n` });
    message += `, starting fresh with its kit (settings replaced${extraPosts.length ? ', a home page added' : ''}${kit.hero ? ', header picture by ' + kit.hero.credit.name : ''})`;
  } else if (fresh && hasLook(blog)) {
    const bare = withoutLook(blog);
    if (bare.customize) blog.customize = bare.customize;
    else delete blog.customize;
    message += ', starting fresh (colours, fonts, width, list layout and custom CSS cleared)';
  }
  const plan = await planBlogJson(gh, { where, branch, head, whole, blogText: blogJsonText(blog), message, title: blog.title, existed: true, runner, extraPosts });
  plan.licences = licenceRecords(validateBlog(blog));
  plan.unchanged = plan.changes.length === 0;
  return plan;
}

// ---------- media: add images, or replace one with the same filename ----------

export const MEDIA_MAX_BYTES = 20 * 1024 * 1024;
export const MEDIA_PAGES_MAX = 20; // more pages than this embed one image: regenerate in a single commit instead of one per page
// the name an uploaded file is kept under: lower case, only letters, digits, dot, dash; never a path
export const mediaName = (name) => String(name).split(/[\\/]/).pop().toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-+(?=\.)/g, '').replace(/^[-.]+|-+$/g, '');

// uploads: [{ key, bytes, name }] new images (kept under their own name, which must be free) and
//          [{ key, bytes, path, replace: true }] a new file for an existing image, under exactly its path.
// A replaced image keeps its filename, so every post that embeds it keeps working; its pin in assets.lock.json moves to the upload
// commit, and every page that embeds it is regenerated with the new address (a pinned address never changes under a page: the pin is the point).
export async function planMedia(gh, { repo: where, branch, uploads, runner }) {
  if (!uploads || !uploads.length) throw new Error('Choose at least one image.');
  const { repo, folder } = parseRepoRef(where);
  const prefix = folder ? `${folder}/` : '';
  const head = await gh.headCommit(repo, branch);
  const whole = await gh.tree(repo, head.treeSha);
  const blogText = await gh.readText(repo, prefix + 'blog.json', head.sha);
  if (blogText === null) throw new Refusal('no-blog-json', `${repo} has no ${prefix}blog.json`);
  const blog = validateBlog(blogText);
  const lock = whole.has(prefix + 'assets.lock.json') ? JSON.parse(await gh.readText(repo, prefix + 'assets.lock.json', head.sha)) : {};
  const groups = [];
  const trees = new Map();
  const seen = new Set();
  const replaced = [];
  for (const u of uploads) {
    const where2 = blog.assets && blog.assets.repos && blog.assets.repos[u.key];
    if (!where2) throw new Refusal('unresolved-asset', `blog.json has no images repository "${u.key}"`);
    const a = parseRepoRef(where2);
    const path = u.replace ? u.path : mediaName(u.name);
    if (!path || !IMAGE_FILE.test(path)) throw new Error(`${u.name || u.path}: only png, jpg, gif and webp images are kept here.`);
    if (!u.replace && path.includes('/')) throw new Error(`${u.name}: a name, not a path.`);
    if (u.bytes.length > MEDIA_MAX_BYTES) throw new Error(`${path} is over 20 MB; binaries should be reasonable.`);
    if (!u.bytes.length) throw new Error(`${path} is empty.`);
    if (seen.has(`${u.key}/${path}`)) throw new Error(`${path} was chosen twice.`);
    seen.add(`${u.key}/${path}`);
    let g = groups.find((x) => x.repo === a.repo);
    if (!g) {
      const info = await gh.repoInfo(a.repo);
      g = { repo: a.repo, branch: a.repo === repo ? branch : info.default_branch, files: [] };
      groups.push(g);
    }
    if (!trees.has(a.repo)) trees.set(a.repo, a.repo === repo ? whole : await gh.tree(a.repo, (await gh.headCommit(a.repo, g.branch)).treeSha));
    const full = at(a.folder, path);
    const existing = trees.get(a.repo).get(full);
    if (u.replace) {
      if (!existing) throw new Error(`${path} is not in the images repository, so there is nothing to replace.`);
      if (existing === (await gitBlobSha(u.bytes))) throw new Error(`${path}: that is the file already there.`);
    } else if (existing) throw new Error(`${path} already exists. To change it, use Replace on that image; to keep both, rename the new file.`);
    g.files.push({ path: full, key: u.key, logical: path, content: u.bytes, size: u.bytes.length, action: u.replace ? 'update' : 'add' });
    if (u.replace) replaced.push({ key: u.key, path, pinned: !!lock[`${u.key}/${path}`] });
  }
  const refreshed = replaced.filter((x) => x.pinned);
  // Which sources embed a replaced image: only those pages are regenerated, not the blog. (A blog.json setting that uses one, a logo,
  // is on every page, so that is the one case that regenerates all of them.)
  const ref = (x) => `asset:${x.key}/${x.path}`;
  const inBlogJson = refreshed.some((x) => blogAssetRefs(blog).includes(ref(x)));
  let affected = [];
  if (refreshed.length && !inBlogJson) {
    const tree = new Map([...whole].filter(([p]) => p.startsWith(prefix)).map(([p, sha]) => [p.slice(prefix.length), sha]));
    const paths = [...tree.keys()].filter((p) => POST_PATH.test(p) || PAGE_PATH.test(p));
    const mentions = refreshed.map((x) => new RegExp(`${ref(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-]|\\.\\w)`));
    for (const f of await readPosts(gh, { repo, prefix, head, tree, paths })) if (mentions.some((m) => m.test(f.text))) affected.push({ kind: POST_PATH.test(f.path) ? 'post' : 'page', slug: (POST_PATH.exec(f.path) || PAGE_PATH.exec(f.path))[1], text: f.text });
  }
  const full = inBlogJson || affected.length > MEDIA_PAGES_MAX;
  const summary = groups.map((g) => ({ repo: g.repo, branch: g.branch, files: g.files.length, bytes: g.files.reduce((n, f) => n + f.size, 0) }));
  const names = groups.flatMap((g) => g.files.map((f) => f.logical));
  const message = replaced.length && replaced.length === uploads.length ? `Replace image${replaced.length === 1 ? '' : 's'}: ${names.join(', ')}` : `Add ${uploads.length - replaced.length} image${uploads.length - replaced.length === 1 ? '' : 's'}${replaced.length ? `, replace ${replaced.length}` : ''}`;
  return { repo, folder, branch, mode: 'direct', slug: '', status: 'published', title: blog.title, message, existed: true, head, changes: [], assetGroups: groups, summary, ctx: null, lockPlan: {}, pending: [], unlisted: [], media: { replaced, refreshed, affected, full }, headline: refreshed.length ? [full ? `${refreshed.length === 1 ? 'This image is' : 'These images are'} used by ${inBlogJson ? 'a blog setting (the logo or a header image), so every page' : `${affected.length} pages, so the whole blog`} is regenerated with the new file.` : affected.length ? `Embedded in ${affected.length} ${affected.length === 1 ? 'page' : 'pages'}: only ${affected.length === 1 ? 'that page is' : 'those pages are'} regenerated, with the new file.` : 'No page embeds it: only the pin in assets.lock.json moves.'] : null, where, runner, unchanged: false };
}

// Upload the images (one commit per images repository; the commit is the pin), then, if a replaced image is embedded anywhere,
// regenerate the pages with its pin moved to that commit. Returns a receipt like executePlan's.
export async function executeMedia(gh, plan) {
  const receipt = { commits: [], pull: null };
  const patch = {};
  let parent = plan.head;
  for (const g of plan.assetGroups) {
    const shared = g.repo === plan.repo && g.branch === plan.branch;
    const h = shared ? plan.head : await gh.headCommit(g.repo, g.branch);
    const c = await gh.commit(g.repo, { branch: g.branch, parent: h.sha, baseTree: h.treeSha, files: g.files.map((f) => ({ path: f.path, content: f.content })), message: plan.message });
    receipt.commits.push({ repo: g.repo, branch: g.branch, ...c, files: g.files.length });
    for (const f of g.files) if (plan.media.refreshed.some((x) => x.key === f.key && x.path === f.logical)) {
      patch[`${f.key}/${f.logical}`] = c.sha;
      Object.assign(patch, sizeEntry(f.key, f.logical, f.content));
    }
    if (shared) parent = { sha: c.sha, treeSha: c.treeSha };
  }
  if (!Object.keys(patch).length) return receipt;
  const prefix = plan.folder ? `${plan.folder}/` : '';
  const names = Object.keys(patch).map((k) => k.slice(k.indexOf('/') + 1)).join(', ');
  const { affected, full } = plan.media;
  if (full) {
    const whole = await gh.tree(plan.repo, parent.treeSha);
    const blogText = await gh.readText(plan.repo, prefix + 'blog.json', parent.sha);
    const p2 = await planBlogJson(gh, { where: plan.where, branch: plan.branch, head: parent, whole, blogText, message: `Use the replaced image${Object.keys(patch).length === 1 ? '' : 's'}: ${names}`, title: plan.title, existed: true, runner: plan.runner, lockPatch: patch });
    receipt.commits.push(...(await executePlan(gh, p2)).commits);
  } else if (!affected.length) {
    // nothing embeds it: the pin moves so that a later use shows the new file, and that is all that is written
    const lock = JSON.parse((await gh.readText(plan.repo, prefix + 'assets.lock.json', parent.sha)) || '{}');
    const c = await gh.commit(plan.repo, { branch: plan.branch, parent: parent.sha, baseTree: parent.treeSha, files: [{ path: prefix + 'assets.lock.json', content: json(sortLock({ ...lock, ...patch })) }], message: `Pin the replaced image${Object.keys(patch).length === 1 ? '' : 's'}: ${names}` });
    receipt.commits.push({ repo: plan.repo, branch: plan.branch, ...c, files: 1 });
  } else {
    // each page that embeds one is saved as it is, with the pin moved: what saving the post would write, and nothing else
    for (const a of affected) {
      const p2 = await planChange(gh, { repo: plan.where, branch: plan.branch, slug: a.slug, text: a.text, kind: a.kind, runner: plan.runner, lockPatch: patch });
      p2.message = `Use the replaced image${Object.keys(patch).length === 1 ? '' : 's'} (${names}) in ${p2.title}`;
      receipt.commits.push(...(await executePlan(gh, p2)).commits);
    }
  }
  return receipt;
}

// Make the blog look like a site that was measured (node cli/measure.mjs): the colours, fonts, width, size and list layout it measured
// replace the blog's own look; its header and footer links, logo and top bar are content and stay. `look` is judged here, not trusted:
// only the enumerable fields, never css (lib/measure.js).
export async function planLook(gh, { repo: where, branch, look, runner }) {
  const { head, whole, blog } = await currentBlogJson(gh, where, branch);
  const measured = assertMeasured(look);
  const oldBlog = structuredClone(blog);
  const bare = withoutLook(blog);
  blog.customize = { ...(bare.customize || {}), ...structuredClone(measured) };
  const message = `Match an existing site: its measured colours, ${measured.font ? measured.font + ' type, ' : ''}width and list layout`;
  const blogText = blogJsonText(blog);
  const plan = (await styleOnlyPlan(gh, { where, branch, head, whole, oldBlog, blogText, message, title: blog.title })) || (await planBlogJson(gh, { where, branch, head, whole, blogText, message, title: blog.title, existed: true, runner }));
  plan.unchanged = plan.changes.length === 0;
  return plan;
}

// Import a theme file (lib/theme-export.js): the file's pinned theme is read from its repository and must hash to what the file says, its
// customize block is judged by the same grammar as the blog's own, and the blog keeps its logo and everything else. A change of CSS alone
// on a linked-stylesheet blog is written as just the stylesheet (styleOnlyPlan).
export async function planThemeFile(gh, { repo: where, branch, text, runner }) {
  const file = parseThemeFile(text);
  const { head, whole, blog } = await currentBlogJson(gh, where, branch);
  const oldBlog = structuredClone(blog);
  let pin = file.theme;
  let message = 'Import theme from a file';
  if (pin && typeof pin === 'object') {
    const got = await readThemeToPin(gh, pin.repo, pin.ref, { base: pin.base, expect: { sha256: pin.sha256, licence: pin.licence } });
    pin = got.pin;
    message = `Import theme from a file: ${got.manifest.name} ${got.manifest.version} (${got.manifest.licence})`;
  }
  const next = applyThemeFile(blog, file, pin);
  const blogText = blogJsonText(next);
  const plan = (await styleOnlyPlan(gh, { where, branch, head, whole, oldBlog, blogText, message, title: next.title })) || (await planBlogJson(gh, { where, branch, head, whole, blogText, message, title: next.title, existed: true, runner }));
  plan.licences = licenceRecords(validateBlog(next));
  plan.unchanged = plan.changes.length === 0;
  return plan;
}

// Add (or replace) an extension, or remove one: `add` is { where, ref }, `remove` an owner/repo. The
// plan includes the sandbox's recorded output (extension-outputs.json); nothing runs outside the sandbox.
export async function planExtension(gh, { repo: where, branch, add, remove, runner }) {
  const { head, whole, blog } = await currentBlogJson(gh, where, branch);
  let message;
  if (add) {
    const { pin, manifest } = await readExtensionToPin(gh, add.where, add.ref, { fetchAsset: assetFetcher(gh), expect: add.expect });
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
    for (const f of g.files) {
      finalLock[`${f.key}/${f.logical}`] = c.sha; // the upload commit is the pin
      Object.assign(finalLock, sizeEntry(f.key, f.logical, f.content)); // and its pixel size, so the page can reserve the box
    }
  }

  // Page content embeds the pin, so regenerate now that real shas exist.
  let changes = plan.changes;
  if (plan.pending.length) ({ changes } = await computeChanges(gh, { ...plan.ctx, lock: finalLock, lockChanged: true }));
  if (!changes.length) return receipt;

  const verb = plan.removed ? 'Delete' : plan.mode === 'pr' ? 'Correct' : plan.status === 'draft' ? 'Draft' : plan.status === 'scheduled' ? 'Schedule' : plan.existed ? 'Update' : 'Publish';
  const message = plan.message || `${verb}: ${plan.title}`;
  const newBranch = plan.mode === 'pr' ? `correction/${plan.slug}-${Date.now().toString(36)}` : null;
  // thousands of files are a long send: wait out GitHub's limits rather than fail halfway
  const wasPatient = gh.patient;
  if (changes.length > BULK_AT) gh.patient = true;
  let c;
  try {
    c = await gh.commit(plan.repo, {
      branch: newBranch || plan.branch,
      parent,
      baseTree,
      files: changes.map((f) => (f.delete ? { path: f.path, delete: true } : { path: f.path, content: f.content })),
      message,
      newBranch: !!newBranch,
    });
  } finally {
    gh.patient = wasPatient;
  }
  // what was just written is what the next plan would read: keep it
  if (!newBranch) for (const f of changes) if (!f.delete && isContent(f.path.slice(plan.folder ? plan.folder.length + 1 : 0))) await gh.remember(plan.repo, f.content);
  receipt.commits.push({ repo: plan.repo, branch: newBranch || plan.branch, ...c, files: changes.length });
  if (newBranch) {
    const pr = await gh.createPull(plan.repo, { title: message, head: newBranch, base: plan.branch, body: pullBody || `Proposed correction to \`${at(plan.folder, plan.path || `posts/${plan.slug}.md`)}\`.` });
    receipt.pull = { url: pr.html_url, number: pr.number };
  }
  return receipt;
}

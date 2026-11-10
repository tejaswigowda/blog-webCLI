// The browser side of the WordPress import: reading a site's REST API, fetching its pictures, and turning what
// lib/wp-content.js produced into the pre-flight and the commits. No DOM here, so the tests drive it with a fake GitHub.
import { Refusal } from '../lib/errors.js';
import { POST_PATH, PAGE_PATH, buildSite, validateBlog } from '../lib/blog.js';
import { COMMENT_PATH } from '../lib/comments.js';
import { mergeImported } from '../lib/wp-merge.js';
import { blogJsonText, makeBlogJson } from '../lib/init.js';
import { at, parseRepoRef } from '../lib/reporef.js';
import { IMAGES_KEY, MAX_FILE_BYTES, acceptFile } from '../lib/wp-content.js';
import { PER_PAGE, RESOURCES, restBase, restModel } from '../lib/wp-rest.js';
import { parseWxr } from '../lib/wxr.js';
import { fmtBytes } from './net.js';
import { PLACEHOLDER_SHA, detectAddress, generateSite } from './site.js';
import { gitBlobSha } from './github.js';
import { sizeEntry } from '../lib/image-size.js';

const enc = new TextEncoder();
// one commit of pictures holds at most this many files, or about this many bytes (a single larger file is a commit of its own)
export const BATCH_FILES = 200;
export const BATCH_BYTES = 150 * 1024 * 1024;
const json = (o) => JSON.stringify(o, null, 2) + '\n';
export const todayIso = () => new Date().toISOString().slice(0, 10);

// ---------- reading ----------

export async function readExport(text) {
  return parseWxr(text, { today: todayIso() });
}

// A live site through its public REST API: only published posts and pages, and only if the site lets another web
// page read it (many do not; the message says so, and an export file always works).
export async function readSite(net, address, { onProgress = () => {} } = {}) {
  const b = restBase(address);
  let root;
  try {
    const res = await net.fetchRemote(b.root);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    root = res.json();
  } catch (e) {
    throw new Refusal('bad-wp-site', `${b.root} could not be read (${e.message}). The site may not be WordPress, may have its REST API switched off, or may not allow other web pages to read it; use an export file instead (Tools → Export → All content).`);
  }
  const data = { root };
  for (const name of RESOURCES) {
    data[name] = [];
    for (let page = 1; page <= 100; page++) {
      onProgress({ what: name, page, items: data[name].length });
      let res;
      try {
        res = await net.fetchRemote(b.api(name === 'posts' ? 'posts?status=publish' : name, page));
      } catch (e) {
        if (name === 'posts') throw new Refusal('bad-wp-site', `the posts of ${b.site} could not be read (${e.message}); use an export file instead`);
        break; // the rest are optional: tags, authors and the library only enrich what the posts say
      }
      if (!res.ok) {
        if (name === 'posts' && page === 1) throw new Refusal('bad-wp-site', `the posts of ${b.site} could not be read (HTTP ${res.status}); use an export file instead`);
        break;
      }
      const items = res.json();
      if (!Array.isArray(items)) break;
      data[name].push(...items);
      const total = Number(res.headers && res.headers.get && res.headers.get('x-wp-totalpages'));
      if (items.length < PER_PAGE || (Number.isFinite(total) && total > 0 && page >= total)) break;
    }
  }
  return restModel(data, { today: todayIso() });
}

// The path of a file below wp-content/uploads, which is how a folder of the old site's uploads names it: "2024/05/cat.jpg".
export const uploadsPath = (url) => {
  try {
    const p = decodeURIComponent(new URL(url).pathname);
    const at = p.indexOf('/wp-content/uploads/');
    return at >= 0 ? p.slice(at + '/wp-content/uploads/'.length) : null;
  } catch {
    return null;
  }
};

// A copy of the old site's uploads, found by what it holds and not by what it is called: the person may have picked the
// uploads folder, wp-content, one year, or a folder of another name; macOS spells accents differently from a URL; a disk may
// not care about case. `files` is [{ path: where the browser says it is, file }]. find(url) is the file, or null.
export function uploadsIndex(files) {
  // the way the importer itself names a file (spaces and odd characters become hyphens), so a folder written by an earlier
  // import is found as readily as the site's own
  const norm = (x) => x.normalize('NFC').toLowerCase().split('/').map((g) => g.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')).join('/');
  const tails = new Map(); // every tail of every path ("a/b/c.jpg", "b/c.jpg", "c.jpg") -> the file, or null when two share it
  const whole = new Map(); // a path as chosen ("05/cat.jpg" from a folder "05"), with at least a folder and a name
  for (const { path, file } of files) {
    const segs = norm(path).split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const k = segs.slice(i).join('/');
      tails.set(k, tails.has(k) ? null : file);
    }
    if (segs.length > 1) whole.set(segs.join('/'), whole.has(segs.join('/')) ? null : file);
  }
  const missed = [];
  const find = (url) => {
    const rel = uploadsPath(url);
    if (!rel) return null;
    const segs = norm(rel).split('/').filter(Boolean);
    // 1. the whole wanted path is the end of a file's path (the uploads folder, wp-content, or a folder of any name above it)
    const hit = tails.get(segs.join('/'));
    if (hit) return hit;
    // 2. a file's whole path is the end of the wanted path (one year or month was picked on its own). Never a file name alone:
    // 2019/05/cat.jpg is not 2024/05/cat.jpg
    for (let i = 1; segs.length - i > 1; i++) {
      const w = whole.get(segs.slice(i).join('/'));
      if (w) return w;
    }
    if (missed.length < 3) missed.push(rel);
    return null;
  };
  return { find, size: files.length, sample: () => files.slice(0, 3).map((f) => f.path), missed };
}

// Brings the pictures and files across: { fetched: Map(url -> bytes), failed: Map(url -> why) }. A few at a time; each one is
// read whole and checked by what it starts with (never by what the server said it is). `local(url)` may supply a file the person
// already has (a copy of the old site's uploads folder) and is tried first: that needs no permission from the old site.
export async function fetchImages(net, images, { onProgress = () => {}, concurrency = 4, isCancelled = () => false, local = null, probe = 30 } = {}) {
  const fetched = new Map();
  const failed = new Map();
  let next = 0;
  let bytes = 0;
  let blocked = false;
  let fromLocal = 0;
  let refused = 0; // times the old site was refused as a browser refuses a cross-origin read
  let answered = false; // the old site gave a file, or any answer at all, at least once
  // Refused that way many times and never answered: the site does not allow this page to read its files.
  const dead = () => !answered && probe && refused >= probe;
  const worker = async () => {
    while (next < images.length && !isCancelled() && !blocked) {
      const im = images[next++];
      let asking = false;
      try {
        let got = local ? await local(im.url) : null;
        let viaLocal = false;
        if (got && !acceptFile(im.path, got)) got = null;
        else if (got) viaLocal = true;
        if (!got) {
          // With a folder to go on, what it lacks is left linked to the old site and the old site is not asked again; without
          // one, the rest would only be thousands more of the same refusal, so stop (below) and say so.
          if (local && dead()) throw new Error('it is not in your uploads folder, and the old site does not let this page read it');
          asking = true;
          const res = await net.fetchRemote(im.url, { max: MAX_FILE_BYTES });
          answered = true;
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          got = res.bytes;
          if (!acceptFile(im.path, got)) throw new Error(/\.(?:png|jpe?g|gif|webp|avif)$/i.test(im.path) ? 'it is not a PNG, JPEG, GIF, WebP or AVIF picture' : 'it is a web page, not the file');
        }
        if (viaLocal) fromLocal++;
        fetched.set(im.url, got);
        bytes += got.length;
      } catch (e) {
        // a browser reports a refused cross-origin read as a bare network error: say what that means here
        if (e instanceof TypeError) refused++;
        else if (asking) answered = true;
        failed.set(im.url, e instanceof TypeError ? "the old site does not let other web pages read its files (or is not reachable)" : e.message);
        if (!local && dead()) blocked = true;
      }
      onProgress({ done: fetched.size + failed.size, total: images.length, bytes, failed: failed.size, fromLocal });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, images.length) }, worker));
  // a folder that held none of what was wanted, from a site that cannot be read: nothing came across, and the person should know why
  if (local && dead() && !fromLocal && !isCancelled()) blocked = true;
  return { fetched, failed, blocked, fromLocal };
}

// ---------- the pre-flight ----------

const folderPrefix = (folder) => (folder ? `${folder}/` : '');
const sortedLock = (lock) => Object.fromEntries(Object.entries(lock).sort(([a], [b]) => (a < b ? -1 : 1)));

// blogs: [{ folder, fields: { title, description, author }, files: [{ path, text }], assets: [{ path, bytes }] }]
// `where` is owner/repo (or owner/repo/folder, below which each blog takes its folder). Refuses to touch a blog that exists,
// unless `addToExisting`: then the posts, pages and pictures are added to it, and its settings, theme and every post it has are left alone.
export async function planImport(gh, { where, branch, blogs, limits = {}, addToExisting = false }) {
  const base = parseRepoRef(where);
  const { repo } = base;
  const head = await gh.headCommit(repo, branch);
  const whole = await gh.tree(repo, head.treeSha);
  const seen = new Set();
  const planned = [];
  const changes = [];
  const assetMap = new Map();
  const skippedAll = [];
  const notesAll = [];
  let imageRef = null;

  for (const b of blogs) {
    const folder = [base.folder, b.folder].filter(Boolean).join('/');
    const place = folder ? `${repo}/${folder}` : repo;
    if (seen.has(folder)) throw new Refusal('import-refused', `two of these blogs would go to ${folder ? `${folder}/` : 'the top of the repository'}: give each its own folder`);
    seen.add(folder);
    const prefix = folderPrefix(folder);
    if (whole.has(`${prefix}blog.json`)) {
      if (!addToExisting) throw new Refusal('import-refused', `${place} already has a blog.json; an import never replaces a blog. Choose another folder or repository, or choose to add these posts to the blog that is there (its settings and theme are kept)`);
      const added = await planAddition(gh, { place, prefix, head, whole, b, assetMap, changes });
      if (imageRef && (imageRef.repo !== added.imageRef.repo || imageRef.folder !== added.imageRef.folder)) throw new Refusal('import-refused', 'these blogs would keep their images in different places; import them one at a time');
      imageRef = added.imageRef;
      planned.push(added.planned);
      skippedAll.push(...added.skipped);
      notesAll.push(...added.notes);
      continue;
    }
    const found = await detectAddress(gh, place);
    const blogText = blogJsonText(makeBlogJson(place, { ...b.fields, domain: found.address }));
    const blog = validateBlog(blogText);
    const a = parseRepoRef(blog.assets.repos[IMAGES_KEY]);
    if (imageRef && (imageRef.repo !== a.repo || imageRef.folder !== a.folder)) throw new Refusal('import-refused', 'these blogs would keep their images in different places; import them one at a time');
    imageRef = a;
    const lock = {};
    for (const x of b.assets) {
      lock[`${IMAGES_KEY}/${x.path}`] = PLACEHOLDER_SHA;
      assetMap.set(x.path, x.bytes);
    }
    const built = buildSite({ blog: blogText, posts: b.files, lock });
    if (built.errors.length) {
      const e = new Refusal('import-refused', `${b.folder || place} cannot be published as it was imported:\n${built.errors.slice(0, 5).map((x) => `${x.detail}${x.where ? ` (${x.where})` : ''}`).join('\n')}`);
      e.all = built.errors;
      throw e;
    }
    const out = { ...built.files, 'blog.json': blogText };
    for (const f of b.files) out[f.path] = f.text;
    if (Object.keys(lock).length) out['assets.lock.json'] = json(sortedLock(lock));
    for (const [rel, content] of Object.entries(out)) changes.push({ path: prefix + rel, content, size: enc.encode(content).length, action: whole.has(prefix + rel) ? 'update' : 'add' });
    planned.push({ folder, prefix, blogText, files: b.files, lockKeys: Object.keys(lock), title: b.fields.title });
  }
  changes.sort((x, y) => (x.path < y.path ? -1 : 1));

  // The pictures and files go in commits of a bounded size, so a library of thousands (or of gigabytes) is never one commit
  // too big to make; each file is pinned to the commit it is in.
  const assetGroups = [];
  if (assetMap.size) {
    const all = [...assetMap].sort(([x], [y]) => (x < y ? -1 : 1)).map(([logical, content]) => ({ path: at(imageRef.folder, logical), key: IMAGES_KEY, logical, content, size: content.length, action: whole.has(at(imageRef.folder, logical)) ? 'update' : 'add' }));
    let batch = [];
    let bytes = 0;
    for (const f of all) {
      if (batch.length && (batch.length >= (limits.files || BATCH_FILES) || bytes + f.size > (limits.bytes || BATCH_BYTES))) {
        assetGroups.push({ repo: imageRef.repo, branch, files: batch });
        batch = [];
        bytes = 0;
      }
      batch.push(f);
      bytes += f.size;
    }
    if (batch.length) assetGroups.push({ repo: imageRef.repo, branch, files: batch });
  }
  const summary = [];
  if (assetGroups.length) summary.push({ repo: imageRef.repo, branch, files: assetMap.size, bytes: assetGroups.reduce((n, g) => n + g.files.reduce((m, f) => m + f.size, 0), 0) });
  summary.push({ repo, branch, files: changes.length, bytes: changes.reduce((n, f) => n + f.size, 0) });
  const posts = planned.reduce((n, b) => n + b.files.filter((f) => f.path.startsWith('posts/')).length, 0);
  const pages = planned.reduce((n, b) => n + b.files.filter((f) => f.path.startsWith('pages/')).length, 0);
  const titles = planned.map((b) => b.title).join(', ');
  const plan = {
    kind: 'import',
    repo,
    folder: base.folder,
    branch,
    mode: 'direct',
    slug: '',
    status: 'published',
    title: titles,
    message: `Import from WordPress: ${titles}`,
    existed: false,
    head,
    changes,
    assetGroups,
    // one per picture or file, a few per commit, and the text a tree request at a time (see GitHub.commit)
    requests: assetMap.size + 5 * (assetGroups.length + 1) + 8 + Math.ceil(Math.max(changes.reduce((n, c) => n + c.size, 0) / 1_500_000, changes.length / 300)),
    summary,
    blogs: planned,
    skipped: skippedAll, // imported posts the blog already has: left out
    notes: notesAll,
    pending: [],
    lockPlan: {},
    headline: [`${blogs.length} blog${blogs.length === 1 ? '' : 's'}: ${posts} post${posts === 1 ? '' : 's'}/drafts, ${pages} page${pages === 1 ? '' : 's'}, ${assetMap.size} image${assetMap.size === 1 ? '' : 's'} and file${assetMap.size === 1 ? '' : 's'} (${fmtBytes([...assetMap.values()].reduce((n, x) => n + x.length, 0))}${assetGroups.length > 1 ? `, in ${assetGroups.length} commits` : ''})`],
  };
  const added = planned.filter((b) => b.addition);
  if (added.length) {
    plan.headline.push(`Added to ${added.length === 1 ? 'the existing blog' : 'existing blogs'}: its settings, theme and customisation are not touched, and nothing it already has is replaced.`);
    const skippedPosts = skippedAll.filter((x) => !COMMENT_PATH.test(x.path)); // a post's comments go with it and are not counted twice
    if (skippedPosts.length) plan.headline.push(`${skippedPosts.length} imported ${skippedPosts.length === 1 ? 'post or page was' : 'posts and pages were'} left out because the blog already has one at that address.`);
    const reused = added.reduce((n, b) => n + b.addition.reusedAssets, 0);
    if (reused) plan.headline.push(`${reused} ${reused === 1 ? 'picture is' : 'pictures are'} already in the blog and will not be sent again.`);
  }
  return plan;
}

// Adding imported posts to a blog that exists: its blog.json is read and used as it is, so its settings, theme and customisation are
// untouched; only posts, pages and pictures it does not already have are added, and the whole site is regenerated with them
// (the listings, tags, feed and so on all change), sending only the files that differ.
async function planAddition(gh, { place, prefix, head, whole, b, assetMap, changes }) {
  const repo = parseRepoRef(place).repo;
  const blogText = await gh.readText(repo, `${prefix}blog.json`, head.sha);
  const blog = validateBlog(blogText);
  if (blog.extensions && blog.extensions.length) throw new Refusal('import-refused', `${place} uses extensions, which run only in the editor's sandbox when a post is published. Add the posts to a blog without extensions, or import into another folder`);
  const tree = new Map([...whole].filter(([p]) => p.startsWith(prefix)).map(([p, sha]) => [p.slice(prefix.length), sha]));
  const paths = [...tree.keys()].filter((p) => POST_PATH.test(p) || PAGE_PATH.test(p) || COMMENT_PATH.test(p));
  const texts = await gh.readMany(repo, paths.map((p) => ({ path: prefix + p, sha: tree.get(p) })), { ref: head.sha });
  const existing = paths.map((path) => {
    const text = texts.get(prefix + path);
    if (text === undefined) throw new Refusal('missing-source', `${prefix + path} is in the repository's file list but could not be read; try again`);
    return { path, text };
  });
  const lock = tree.has('assets.lock.json') ? JSON.parse(await gh.readText(repo, `${prefix}assets.lock.json`, head.sha)) : {};
  const merged = mergeImported({ existing, files: b.files, assets: b.assets, lock, imagesKey: IMAGES_KEY });
  const imageRef = parseRepoRef(blog.assets.repos[IMAGES_KEY]);
  const pins = { ...lock };
  const newKeys = [];
  for (const x of merged.assets) {
    pins[`${IMAGES_KEY}/${x.path}`] = PLACEHOLDER_SHA;
    newKeys.push(`${IMAGES_KEY}/${x.path}`);
    assetMap.set(x.path, x.bytes);
  }
  const site = await generateSite(gh, { repo, prefix, head, tree, blogText, posts: [...existing, ...merged.files], lock: pins });
  const out = { ...site.files };
  for (const f of merged.files) out[f.path] = f.text;
  if (newKeys.length) out['assets.lock.json'] = json(sortedLock(pins));
  for (const [rel, content] of Object.entries(out)) {
    const bytes = enc.encode(content);
    if (tree.get(rel) !== (await gitBlobSha(bytes))) changes.push({ path: prefix + rel, content, size: bytes.length, action: tree.has(rel) ? 'update' : 'add' });
  }
  const skipped = merged.skipped.map((x) => ({ ...x, path: prefix + x.path }));
  const notes = [...merged.notes.map((n) => ({ ...n, where: prefix + n.where })), ...skipped.map((x) => ({ where: x.path, text: `left out: ${x.why}` }))];
  return {
    imageRef,
    skipped,
    notes,
    planned: { folder: prefix.replace(/\/$/, ''), prefix, blogText, files: merged.files, lockKeys: newKeys, title: JSON.parse(blogText).title || place, addition: { existing, lock, tree, reusedAssets: merged.reusedAssets } },
  };
}

// Images first, in one commit (its sha is what every picture is pinned to), then every blog, regenerated with those pins,
// in a second. Returns the receipt the editor shows.
// Slow and resumable: GitHub's hourly limit is waited out (gh.patient), and a blob already sent is remembered (gh.ledger), so
// stopping, or a failure, and starting again carries on instead of beginning again.
export async function executeImport(gh, plan, { onProgress = () => {} } = {}) {
  const before = gh.patient;
  gh.patient = true;
  try {
    return await runImport(gh, plan, onProgress);
  } finally {
    gh.patient = before;
  }
}

async function runImport(gh, plan, onProgress) {
  const receipt = { commits: [], pull: null };
  const lock = {};
  let parent = plan.head.sha;
  let baseTree = plan.head.treeSha;
  for (const g of plan.assetGroups) {
    const shared = g.repo === plan.repo && g.branch === plan.branch;
    const h = shared ? plan.head : await gh.headCommit(g.repo, g.branch);
    const c = await gh.commit(g.repo, {
      branch: g.branch,
      parent: shared ? parent : h.sha,
      baseTree: shared ? baseTree : h.treeSha,
      files: g.files.map((f) => ({ path: f.path, content: f.content })),
      skipIfUnchanged: true,
      message: `Add ${g.files.length} image${g.files.length === 1 ? '' : 's/files'} from WordPress${plan.assetGroups.length > 1 ? ` (${plan.assetGroups.indexOf(g) + 1} of ${plan.assetGroups.length})` : ''}`,
      onProgress: (done, total) => onProgress({ phase: 'images', done, total }),
    });
    receipt.commits.push({ repo: g.repo, branch: g.branch, ...c, files: g.files.length });
    if (shared) {
      parent = c.sha;
      baseTree = c.treeSha;
    }
    for (const f of g.files) {
      lock[`${f.key}/${f.logical}`] = c.sha;
      Object.assign(lock, sizeEntry(f.key, f.logical, f.content));
    }
  }

  const files = [];
  for (const b of plan.blogs) {
    const mine = Object.fromEntries(b.lockKeys.flatMap((k) => [[k, lock[k]], ...(lock[`${k}#size`] ? [[`${k}#size`, lock[`${k}#size`]]] : [])]));
    if (b.addition) {
      // an existing blog: regenerate it with the new posts and the real pins, and send only what differs from what it has
      const pins = { ...b.addition.lock, ...mine };
      const site = await generateSite(gh, { repo: plan.repo, prefix: b.prefix, head: plan.head, tree: b.addition.tree, blogText: b.blogText, posts: [...b.addition.existing, ...b.files], lock: pins });
      const out = { ...site.files };
      for (const f of b.files) out[f.path] = f.text;
      if (b.lockKeys.length) out['assets.lock.json'] = json(sortedLock(pins));
      for (const [rel, content] of Object.entries(out)) if (b.addition.tree.get(rel) !== (await gitBlobSha(enc.encode(content)))) files.push({ path: b.prefix + rel, content });
      continue;
    }
    const built = buildSite({ blog: b.blogText, posts: b.files, lock: mine });
    if (built.errors.length) throw new Refusal('import-refused', built.errors.map((e) => e.detail).join('\n'));
    const out = { ...built.files, 'blog.json': b.blogText };
    for (const f of b.files) out[f.path] = f.text;
    if (Object.keys(mine).length) out['assets.lock.json'] = json(sortedLock(mine));
    for (const [rel, content] of Object.entries(out)) files.push({ path: b.prefix + rel, content });
  }
  const c = await gh.commit(plan.repo, {
    branch: plan.branch,
    parent,
    baseTree,
    files,
    message: plan.message,
    skipIfUnchanged: true,
    onProgress: (done, total) => onProgress({ phase: 'files', done, total }),
  });
  receipt.commits.push({ repo: plan.repo, branch: plan.branch, ...c, files: files.length });
  return receipt;
}

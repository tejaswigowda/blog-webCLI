// The browser side of the WordPress import: reading a site's REST API, fetching its pictures, and turning what
// lib/wp-content.js produced into the pre-flight and the commits. No DOM here, so the tests drive it with a fake GitHub.
import { Refusal } from '../lib/errors.js';
import { buildSite, validateBlog } from '../lib/blog.js';
import { blogJsonText, makeBlogJson } from '../lib/init.js';
import { at, parseRepoRef } from '../lib/reporef.js';
import { IMAGES_KEY, MAX_FILE_BYTES, acceptFile } from '../lib/wp-content.js';
import { PER_PAGE, RESOURCES, restBase, restModel } from '../lib/wp-rest.js';
import { parseWxr } from '../lib/wxr.js';
import { fmtBytes } from './net.js';
import { PLACEHOLDER_SHA, detectAddress } from './site.js';

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

// Brings the pictures and files across: { fetched: Map(url -> bytes), failed: Map(url -> why) }. A few at a time; each one is
// read whole and checked by what it starts with (never by what the server said it is). `local(url)` may supply a file the person
// already has (a copy of the old site's uploads folder) and is tried first: that needs no permission from the old site.
export async function fetchImages(net, images, { onProgress = () => {}, concurrency = 4, isCancelled = () => false, local = null, probe = 30 } = {}) {
  const fetched = new Map();
  const failed = new Map();
  let next = 0;
  let bytes = 0;
  let blocked = false;
  let network = 0; // refused as a browser refuses a cross-origin read
  const worker = async () => {
    while (next < images.length && !isCancelled() && !blocked) {
      const im = images[next++];
      try {
        let got = local ? await local(im.url) : null;
        if (got && !acceptFile(im.path, got)) got = null;
        if (!got) {
          const res = await net.fetchRemote(im.url, { max: MAX_FILE_BYTES });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          got = res.bytes;
          if (!acceptFile(im.path, got)) throw new Error(/\.(?:png|jpe?g|gif|webp|avif)$/i.test(im.path) ? 'it is not a PNG, JPEG, GIF, WebP or AVIF picture' : 'it is a web page, not the file');
        }
        fetched.set(im.url, got);
        bytes += got.length;
      } catch (e) {
        // a browser reports a refused cross-origin read as a bare network error: say what that means here
        if (e instanceof TypeError) network++;
        failed.set(im.url, e instanceof TypeError ? "the old site does not let other web pages read its files (or is not reachable)" : e.message);
        // the first few all refused that way, none read: the rest would only be thousands more of the same, so stop and say so
        if (probe && !fetched.size && failed.size >= probe && network === failed.size) blocked = true;
      }
      onProgress({ done: fetched.size + failed.size, total: images.length, bytes, failed: failed.size });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, images.length) }, worker));
  return { fetched, failed, blocked };
}

// ---------- the pre-flight ----------

const folderPrefix = (folder) => (folder ? `${folder}/` : '');
const sortedLock = (lock) => Object.fromEntries(Object.entries(lock).sort(([a], [b]) => (a < b ? -1 : 1)));

// blogs: [{ folder, fields: { title, description, author }, files: [{ path, text }], assets: [{ path, bytes }] }]
// `where` is owner/repo (or owner/repo/folder, below which each blog takes its folder). Refuses to touch a blog that exists.
export async function planImport(gh, { where, branch, blogs, limits = {} }) {
  const base = parseRepoRef(where);
  const { repo } = base;
  const head = await gh.headCommit(repo, branch);
  const whole = await gh.tree(repo, head.treeSha);
  const seen = new Set();
  const planned = [];
  const changes = [];
  const assetMap = new Map();
  let imageRef = null;

  for (const b of blogs) {
    const folder = [base.folder, b.folder].filter(Boolean).join('/');
    const place = folder ? `${repo}/${folder}` : repo;
    if (seen.has(folder)) throw new Refusal('import-refused', `two of these blogs would go to ${folder ? `${folder}/` : 'the top of the repository'}: give each its own folder`);
    seen.add(folder);
    const prefix = folderPrefix(folder);
    if (whole.has(`${prefix}blog.json`)) throw new Refusal('import-refused', `${place} already has a blog.json; an import never replaces a blog. Choose another folder or repository`);
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
  const posts = blogs.reduce((n, b) => n + b.files.filter((f) => f.path.startsWith('posts/')).length, 0);
  const pages = blogs.reduce((n, b) => n + b.files.filter((f) => f.path.startsWith('pages/')).length, 0);
  const titles = blogs.map((b) => b.fields.title).join(', ');
  return {
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
    requests: assetMap.size + 5 * (assetGroups.length + 1) + 8, // one per picture or file, a few per commit
    summary,
    blogs: planned,
    pending: [],
    lockPlan: {},
    headline: [`${blogs.length} blog${blogs.length === 1 ? '' : 's'}: ${posts} post${posts === 1 ? '' : 's'}/drafts, ${pages} page${pages === 1 ? '' : 's'}, ${assetMap.size} image${assetMap.size === 1 ? '' : 's'} and file${assetMap.size === 1 ? '' : 's'} (${fmtBytes([...assetMap.values()].reduce((n, x) => n + x.length, 0))}${assetGroups.length > 1 ? `, in ${assetGroups.length} commits` : ''})`],
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
    for (const f of g.files) lock[`${f.key}/${f.logical}`] = c.sha;
  }

  const files = [];
  for (const b of plan.blogs) {
    const mine = Object.fromEntries(b.lockKeys.map((k) => [k, lock[k]]));
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

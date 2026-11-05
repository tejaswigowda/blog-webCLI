// The generator core: pure functions from (blog.json, posts, lock) to files.
// No filesystem, no network — so the CLI, CI and the browser share one implementation.
import { Refusal } from './errors.js';
import { splitFile, joinFile, parseMeta, validateMeta, RESERVED_SLUGS } from './frontmatter.js';
import { mdToDelta, deltaToMd } from './markdown.js';
import { deltaToHtml, excerpt, wordCount } from './html.js';
import { collectAssetRefs, isAssetRef, lockKey, namesProvider, parseAssetRef, resolveAsset } from './assets.js';
import { collectVideoRefs, videoBase, videoEmbedUrl, validateVideoConfig } from './video.js';
import { isRepoRef, parseRepoRef, sameSpot } from './reporef.js';
import { DEFAULT_ASSET_BASE, DEFAULT_PLAYER, DEFAULT_VIDEO_BASE } from './init.js';
import { THEMES } from './theme.js';
import { resolveLogo, validateCustomize } from './customize.js';
import { GENERATOR, atomFeed, indexPage, postPage } from './page.js';

export const POST_PATH = /^posts\/([^/]+)\.md$/;

export function validateBlog(raw) {
  let b = raw;
  if (typeof raw === 'string') {
    try {
      b = JSON.parse(raw);
    } catch (e) {
      throw new Refusal('bad-blog-json', `blog.json is not valid JSON (${e.message})`);
    }
  }
  const bad = (m) => new Refusal('bad-blog-json', m);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('blog.json must be an object');
  for (const k of ['title', 'description', 'author', 'domain']) {
    if (typeof b[k] !== 'string' || !b[k].trim()) throw bad(`"${k}" is required`);
  }
  if (!/^https?:\/\/[^/\s]+(\/[^\s]*)?$/.test(b.domain)) throw bad('"domain" must be an absolute http(s) URL');
  if (b.repo !== undefined && !isRepoRef(b.repo)) throw bad('"repo" must look like owner/name or owner/name/folder');
  if (b.theme !== undefined && !(b.theme in THEMES)) throw bad(`unknown theme "${b.theme}"`);
  if (b.cover !== undefined) {
    try {
      if (!isAssetRef(b.cover)) throw 0;
      parseAssetRef(b.cover);
    } catch {
      throw bad('"cover" must be an asset: reference');
    }
  }
  if (b.assets !== undefined) {
    const a = b.assets;
    if (!a || typeof a !== 'object') throw bad('"assets" must be an object');
    if (typeof a.base !== 'string' || !/^https?:\/\//.test(a.base) || !a.base.includes('{sha}') || !a.base.includes('{path}')) {
      throw bad('"assets.base" must be an http(s) URL template containing {sha} and {path}');
    }
    if (!a.repos || typeof a.repos !== 'object') throw bad('"assets.repos" must map keys to owner/name');
    for (const [k, v] of Object.entries(a.repos)) {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(k) || !isRepoRef(v)) throw bad(`assets.repos.${k} must be a lowercase key mapped to owner/name or owner/name/folder`);
    }
  }
  if (b.video !== undefined) validateVideoConfig(b.video, bad);
  if (b.customize !== undefined) validateCustomize(b.customize);
  if (b.repo !== undefined) {
    for (const [kind, repos] of [['assets', b.assets && b.assets.repos], ['video', b.video && b.video.repos]]) {
      for (const [k, v] of Object.entries(repos || {})) {
        if (sameSpot(b.repo, v)) throw bad(`${kind}.repos.${k} is the blog's own location (${b.repo}); give the blog or the ${kind} a folder of its own`);
      }
    }
  }
  return { ...b, domain: b.domain.replace(/\/+$/, '') };
}

function firstDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return `line ${i + 1}: have ${JSON.stringify(x[i] ?? '')}, canonical form is ${JSON.stringify(y[i] ?? '')}`;
  }
  return '';
}

// The reader's URL hash may name media repositories; they override blog.json, which fills in
// whatever the hash leaves out. A repository named where blog.json has no section gets the
// default templates. The result is validated like any blog.json.
export function withRepoOverrides(blog, { images, video, audio } = {}) {
  const next = structuredClone(blog);
  const take = (v, name) => {
    if (!v) return null;
    if (!isRepoRef(v)) throw new Refusal('bad-blog-json', `"${name}" must be owner/name or owner/name/folder`);
    return parseRepoRef(v).ref;
  };
  const slot = (repos, name, only) => (name in repos ? name : only && Object.keys(repos).length === 1 ? Object.keys(repos)[0] : name);
  for (const [name, v] of [['images', images], ['audio', audio]]) {
    const ref = take(v, name);
    if (!ref) continue;
    next.assets = next.assets || { base: DEFAULT_ASSET_BASE, repos: {} };
    next.assets.repos[name] = ref;
  }
  const ref = take(video, 'video');
  if (ref) {
    next.video = next.video || { player: DEFAULT_PLAYER, base: DEFAULT_VIDEO_BASE, repos: {} };
    next.video.repos[slot(next.video.repos, 'videos', true)] = ref;
  }
  return validateBlog(next);
}

// First path segment, below the blog's own folder, of every asset/video folder that sits
// in the blog's own directory. A post slug there would make its page collide with it.
export function sharedTopLevel(blog) {
  const out = new Set();
  if (!blog.repo) return out;
  const me = parseRepoRef(blog.repo);
  for (const repos of [blog.assets && blog.assets.repos, blog.video && blog.video.repos]) {
    for (const v of Object.values(repos || {})) {
      const other = parseRepoRef(v);
      if (other.repo !== me.repo) continue;
      const rel = me.folder === '' ? other.folder : other.folder.startsWith(me.folder + '/') ? other.folder.slice(me.folder.length + 1) : null;
      if (rel) out.add(rel.split('/')[0]);
    }
  }
  return out;
}

export function parsePost({ path, text }) {
  const m = POST_PATH.exec(path);
  if (!m) throw new Refusal('bad-frontmatter', 'posts live at posts/<slug>.md', path);
  if (text.includes('\r')) throw new Refusal('lossy-round-trip', 'CRLF line endings — run `blog-webcli fmt`', path);
  const { front, body } = splitFile(text, path);
  const meta = parseMeta(front, path);
  validateMeta(meta, path);
  if (meta.slug !== m[1]) throw new Refusal('slug-mismatch', `file is ${path} but frontmatter says slug "${meta.slug}"`, path);
  const delta = mdToDelta(body);
  const canonical = joinFile(front, deltaToMd(delta));
  let lossy = null;
  if (canonical !== text) {
    lossy = new Refusal('lossy-round-trip', `not in canonical markdown — ${firstDiff(text, canonical)} (run \`blog-webcli fmt\`)`, path);
  }
  return { path, slug: meta.slug, meta, front, body, delta, status: meta.status, lossy };
}

const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug < b.slug ? -1 : 1);
const json = (o) => JSON.stringify(o, null, 2) + '\n';

// Render one post to a full HTML page. Refuses drafts.
export function renderPost(blog, post, lock) {
  if (post.status !== 'published') throw new Refusal('draft-in-publish', `"${post.slug}" is a draft`, post.path);
  const resolve = (ref) => resolveAsset(ref, blog, lock);
  const bodyHtml = deltaToHtml(post.delta, { resolve, resolveVideo: (ref) => videoEmbedUrl(ref, blog), strict: true });
  const cover = post.meta.cover || blog.cover;
  const image = cover ? resolve(cover) : null;
  const description = post.meta.description || excerpt(post.delta);
  return {
    html: postPage({
      blog,
      post: { ...post, description },
      bodyHtml,
      url: `${blog.domain}/${post.slug}/`,
      image,
      coverUrl: post.meta.cover ? resolve(post.meta.cover) : null,
      logoUrl: resolveLogo(blog, lock),
    }),
    bodyHtml,
    description,
    image,
  };
}

// buildSite({ blog, posts: [{path,text}], lock }) -> { files, index, errors, warnings }
// Refuses (errors non-empty, files empty) rather than emitting a partial site.
export function buildSite({ blog: blogRaw, posts: inputs, lock = {} }) {
  const blog = validateBlog(blogRaw);
  const errors = [];
  const warnings = [];
  const parsed = [];

  // The header logo is part of every page: refuse once, up front, rather than once per page.
  let logoUrl = null;
  try {
    logoUrl = resolveLogo(blog, lock);
  } catch (e) {
    return { files: {}, index: null, errors: [e], warnings };
  }

  for (const input of inputs) {
    try {
      parsed.push(parsePost(input));
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      errors.push(e.at(input.path));
    }
  }

  // Collisions are judged on the slugs files *declare*, so a file that is also
  // mismatched or malformed cannot hide one.
  const seen = new Map();
  for (const input of inputs) {
    let slug;
    try {
      slug = parseMeta(splitFile(input.text, input.path).front, input.path).slug;
    } catch {
      continue;
    }
    if (typeof slug !== 'string') continue;
    if (RESERVED_SLUGS.has(slug) || sharedTopLevel(blog).has(slug)) errors.push(new Refusal('slug-collision', `"${slug}" is a reserved path`, input.path));
    if (seen.has(slug)) errors.push(new Refusal('slug-collision', `"${slug}" is used by both ${seen.get(slug)} and ${input.path}`, input.path));
    else seen.set(slug, input.path);
  }

  const published = [];
  for (const p of parsed) {
    if (p.status === 'draft') {
      if (p.lossy) warnings.push(`${p.path}: draft is not canonical markdown — ${p.lossy.detail}`);
      continue; // drafts appear in no index, page or feed
    }
    if (p.lossy) {
      errors.push(p.lossy);
      continue;
    }
    published.push(p);
  }

  const entries = [];
  const pages = new Map();
  for (const p of published) {
    try {
      for (const op of p.delta.ops) {
        for (const u of [op.insert && op.insert.image, op.attributes && op.attributes.link]) {
          if (typeof u === 'string' && !isAssetRef(u) && namesProvider(u, blog)) {
            throw new Refusal('provider-url', `"${u}" names an asset provider; use an asset: reference`, p.path);
          }
        }
      }
      for (const v of collectVideoRefs(p.delta)) videoBase(v, blog); // refuses an unknown repo key
      const refs = collectAssetRefs(p.delta, p.meta);
      for (const r of refs) {
        const { key, path } = parseAssetRef(r);
        if (!lock[`${key}/${path}`]) throw new Refusal('unresolved-asset', `${r} is not pinned in assets.lock.json`, p.path);
      }
      if (!p.meta.cover && !blog.cover) warnings.push(`${p.path}: no cover and no blog.json cover — page has no og:image`);
      const r = renderPost(blog, p, lock);
      pages.set(p.slug, r.html);
      entries.push({
        slug: p.slug,
        title: p.meta.title,
        date: p.meta.date,
        tags: p.meta.tags || [],
        excerpt: r.description,
        cover: p.meta.cover || null,
        words: wordCount(p.delta),
        status: 'published',
        author: p.meta.author || blog.author,
        html: r.bodyHtml,
      });
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      errors.push(e.at(p.path));
    }
  }
  entries.sort(byDateDesc);

  if (errors.length) return { files: {}, index: null, errors, warnings };

  const publicEntries = entries.map(({ author, html, ...e }) => e);
  const files = {
    '.nojekyll': '',
    'index/posts.json': json({ version: 1, generator: GENERATOR, posts: publicEntries }),
    'feed.xml': atomFeed({ blog, entries, base: blog.domain }),
  };
  let indexImage = null;
  if (blog.cover) {
    try {
      indexImage = resolveAsset(blog.cover, blog, lock);
    } catch (e) {
      return { files: {}, index: null, errors: [e], warnings };
    }
  }
  files['index.html'] = indexPage({ blog, entries: publicEntries, url: `${blog.domain}/`, image: indexImage, logoUrl });
  for (const [slug, html] of pages) files[`${slug}/index.html`] = html;
  return { files, index: publicEntries, errors, warnings };
}

// Generated page directories are recognised by their generator meta tag; used to
// find stale pages (a post unpublished or deleted).
export const GENERATED_MARK = `<meta name="generator" content="${GENERATOR}">`;
export { lockKey };

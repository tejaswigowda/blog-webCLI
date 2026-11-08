// The generator core: pure functions from (blog.json, posts, lock) to files.
// No filesystem, no network — so the CLI, CI and the browser share one implementation.
import { Refusal } from './errors.js';
import { checkAliases, parseAliases } from './aliases.js';
import { splitFile, joinFile, parseMeta, validateMeta, RESERVED_SLUGS } from './frontmatter.js';
import { mdToDelta, deltaToMd } from './markdown.js';
import { deltaToHtml, excerpt, plainLines, wordCount } from './html.js';
import { collectAssetRefs, isAssetRef, lockKey, namesProvider, parseAssetRef, resolveAsset } from './assets.js';
import { embedUrls } from './blockrefs.js';
import { collectVideoRefs, videoBase, videoEmbedUrl, validateVideoConfig } from './video.js';
import { AUTO_COVER, autoCover, firstImage } from './cover.js';
import { isRepoRef, parseRepoRef, sameSpot } from './reporef.js';
import { DEFAULT_ASSET_BASE, DEFAULT_PLAYER, DEFAULT_VIDEO_BASE } from './init.js';
import { THEMES } from './theme.js';
import { resolveLogo, themeCss, validateCustomize, withAssetUrls } from './customize.js';
import { validatePin } from './pin.js';
import { checkLicence } from './licence.js';
import { validateContent } from './content.js';
import { validateEmbeds, subscribeHtml } from './embeds.js';
import { STYLE_FILE, paginationSize, paginationStable, robotsEnabled, stylesheetLinked, searchEnabled, sitemapEnabled, robotsTxt, validateSeo } from './seo.js';
import { siteModel, viewFrom, PAGE_DIR } from './site-model.js';
import { buildListings, pageName, pageOf, pagerHtml, pagesOf, sitemapFiles } from './listings.js';
import { relatedCount, relatedFor, validateRelated } from './related.js';
import { validateTimezone } from './schedule.js';
import { neighbours, parseOrderList, resolveOrder, sequenceOf, validateOrder } from './order.js';
import { makeHooks, outputsFile } from './extensions.js';
import { licenceComment, licencesJson } from './licences.js';
import { DEFAULT_CONTRACT, contractName, indexList } from './contracts.js';
import { CONTRACTS, DEFAULT_THEME_BASE } from './theme-pack.js';
import { GENERATOR, GENERATOR_ID, LIVE_FILE, SEARCH_FILE, atomFeed, indexPage, listingPage, notFoundPage, postPage, redirectPage } from './page.js';
import { sha256 } from './sha256.js';
import { contentBase, domainPath, liveEnabled, ownsNotFoundPage } from './content.js';
import { LIVE_SOURCE } from './live-source.js';
import { SEARCH_SOURCE } from './search-source.js';

export const POST_PATH = /^posts\/([^/]+)\.md$/;
// How much of a post's text goes into search.json (a post longer than this is searchable by its first part).
const SEARCH_TEXT_MAX = 20000;
// The feed holds the newest posts, not all of them: a feed reader wants the latest, and a blog of thousands of posts would otherwise
// make a feed of tens of megabytes that every publish rewrites.
export const FEED_LIMIT = 50;
// A blog with more posts than this keeps its search index in shards (search/data-N.json, listed by search.json), by a hash of the
// slug, so a new post changes one small file and not the whole index. The search page reads them all.
export const SEARCH_SHARD_OVER = 500;
export const SEARCH_SHARDS = 16;
export const shardOf = (slug) => {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) h = Math.imul(h ^ slug.charCodeAt(i), 16777619) >>> 0;
  return h % SEARCH_SHARDS;
};
export const PAGE_PATH = /^pages\/([^/]+)\.md$/;
// Folders the generator owns wholesale: whatever is in them and is not in its output is stale.
export const GENERATED_TREES = ['tags', 'authors', 'archive', 'page', 'search', 'index', 'sitemaps'];
// Root files that exist only while the feature that makes them is on. (sitemap.xml and robots.txt are never
// deleted for being absent from the output: a blog that switches them off may have written one by hand.)
export const SKELETON_FILE = 'theme-skeleton.json';
export const OPTIONAL_GENERATED = ['theme.css', SKELETON_FILE, 'style.css', 'extension-outputs.json', '404.html', 'webcli-live.js', 'webcli-search.js', 'search.json'];

// { repo, ref, sha256 } plus what the blog records about the pack (name, version, licence), so
// the licences it depends on are visible without fetching anything.
function validatePackPin(pin, what, extra) {
  const allowed = ['repo', 'ref', 'sha256', 'name', 'version', 'licence', ...extra];
  validatePin(pin, what);
  for (const k of Object.keys(pin)) if (!allowed.includes(k)) throw new Refusal('bad-blog-json', `${what}: "${k}" is not a field (${allowed.join(', ')})`);
  for (const k of ['name', 'version']) if (typeof pin[k] !== 'string' || !pin[k].trim()) throw new Refusal('bad-blog-json', `${what}: "${k}" is required (it is recorded here so licences are visible)`);
  checkLicence(pin.licence, `${what} "${pin.name}"`);
  if (pin.base !== undefined && !(typeof pin.base === 'string' && /^https:\/\//.test(pin.base) && pin.base.includes('{ref}') && pin.base.includes('{path}'))) {
    throw new Refusal('bad-blog-json', `${what}: "base" must be an https URL template containing {ref} and {path} (default ${DEFAULT_THEME_BASE})`);
  }
}

// Where media goes when blog.json names no repository for it: folders of the blog's own repository
// (the "repo" in blog.json).
export const DEFAULT_MEDIA_FOLDERS = { images: 'images', videos: 'videos' };

// A default is not part of the file. It is attached as a non-enumerable property, so it is readable
// (`blog.assets`) but is never spread, cloned or serialised back into blog.json: an author who enters
// nothing keeps a blog.json that says nothing, and changing the default later changes every such blog.
const attachDefault = (blog, key, value) => Object.defineProperty(blog, key, { value, enumerable: false, writable: true, configurable: true });

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
  if (b.theme !== undefined) {
    if (typeof b.theme === 'string') {
      if (!(b.theme in THEMES)) throw bad(`unknown theme "${b.theme}"`);
    } else {
      validatePackPin(b.theme, 'theme', ['base', 'contract']);
      if (b.theme.contract !== undefined && !CONTRACTS.includes(b.theme.contract)) throw bad(`theme.contract must be one of ${CONTRACTS.join(', ')}`);
    }
  }
  if (b.extensions !== undefined) {
    if (!Array.isArray(b.extensions) || b.extensions.length > 8) throw bad('"extensions" must be a list of at most 8 pinned extensions');
    const seen = new Set();
    b.extensions.forEach((e, i) => {
      validatePackPin(e, `extensions[${i}]`, ['kind', 'hooks']);
      if (seen.has(e.repo)) throw bad(`extensions[${i}]: ${e.repo} is listed twice`);
      seen.add(e.repo);
    });
  }
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
  if (b.content !== undefined) validateContent(b.content, b.repo);
  if (b.order !== undefined) validateOrder(b.order);
  validateSeo(b);
  validateTimezone(b);
  validateRelated(b);
  validateEmbeds(b);
  if (b.customize !== undefined) validateCustomize(b.customize);
  if (b.repo !== undefined) {
    for (const [kind, repos] of [['assets', b.assets && b.assets.repos], ['video', b.video && b.video.repos]]) {
      for (const [k, v] of Object.entries(repos || {})) {
        if (sameSpot(b.repo, v)) throw bad(`${kind}.repos.${k} is the blog's own location (${b.repo}); give the blog or the ${kind} a folder of its own`);
      }
    }
  }
  const out = { ...b, domain: b.domain.replace(/\/+$/, '') };
  const home = b.repo;
  if (home) {
    const { repo } = parseRepoRef(home);
    const folderOf = (name) => `${repo}/${DEFAULT_MEDIA_FOLDERS[name]}`;
    // never the blog's own location, and only where the author wrote no section at all
    if (authored(b, 'assets') === undefined && !sameSpot(home, folderOf('images'))) attachDefault(out, 'assets', { base: DEFAULT_ASSET_BASE, repos: { images: folderOf('images') } });
    if (authored(b, 'video') === undefined && !sameSpot(home, folderOf('videos'))) attachDefault(out, 'video', { player: DEFAULT_PLAYER, base: DEFAULT_VIDEO_BASE, repos: { videos: folderOf('videos') } });
  }
  return out;
}

// What the author wrote, as opposed to what a default supplies.
export const authored = (blog, key) => (Object.prototype.propertyIsEnumerable.call(blog, key) ? blog[key] : undefined);

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
  for (const k of ['assets', 'video']) if (next[k] === undefined && blog[k] !== undefined) next[k] = structuredClone(blog[k]); // a default the hash may add to
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
  for (const repos of [authored(blog, 'assets') && blog.assets.repos, authored(blog, 'video') && blog.video.repos]) {
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
  const post = POST_PATH.exec(path);
  const m = post || PAGE_PATH.exec(path);
  if (!m) throw new Refusal('bad-frontmatter', 'posts live at posts/<slug>.md and pages at pages/<slug>.md', path);
  const kind = post ? 'post' : 'page';
  if (text.includes('\r')) throw new Refusal('lossy-round-trip', 'CRLF line endings — run `blog-webcli fmt`', path);
  const { front, body } = splitFile(text, path);
  const meta = parseMeta(front, path);
  validateMeta(meta, path, kind);
  if (meta.slug !== m[1]) throw new Refusal('slug-mismatch', `file is ${path} but frontmatter says slug "${meta.slug}"`, path);
  const delta = mdToDelta(body);
  const canonical = joinFile(front, deltaToMd(delta));
  let lossy = null;
  if (canonical !== text) {
    lossy = new Refusal('lossy-round-trip', `not in canonical markdown — ${firstDiff(text, canonical)} (run \`blog-webcli fmt\`)`, path);
  }
  return { path, kind, slug: meta.slug, meta, front, body, delta, status: meta.status, lossy, text };
}

// Whatever a post or page names must exist: no provider URLs, known video repositories, pinned assets.
export function checkPostReferences(p, blog, lock) {
  for (const op of p.delta.ops) {
    for (const u of [op.insert && op.insert.image, op.attributes && op.attributes.link]) {
      if (typeof u === 'string' && !isAssetRef(u) && namesProvider(u, blog)) {
        throw new Refusal('provider-url', `"${u}" names an asset provider; use an asset: reference`, p.path);
      }
    }
  }
  for (const { url } of embedUrls(p.delta)) {
    if (!isAssetRef(url) && namesProvider(url, blog)) throw new Refusal('provider-url', `"${url}" names an asset provider; use an asset: reference`, p.path);
  }
  for (const v of collectVideoRefs(p.delta)) videoBase(v, blog); // refuses an unknown repo key
  for (const r of collectAssetRefs(p.delta, p.meta)) {
    const { key, path } = parseAssetRef(r);
    if (!lock[`${key}/${path}`]) throw new Refusal('unresolved-asset', `${r} is not pinned in assets.lock.json`, p.path);
  }
}

// One post as the index records it (`html` is for the feed and is not recorded). `r` is what renderPost returned for it.
export function entryOf(blog, p, r, picked) {
  return {
    slug: p.slug,
    title: p.meta.title,
    date: p.meta.date,
    tags: p.meta.tags || [],
    excerpt: r.description,
    cover: p.meta.cover === AUTO_COVER ? (picked && picked.ref) || null : p.meta.cover || null,
    ...thumbOf(blog, p, picked),
    words: wordCount(p.delta),
    status: 'published',
    author: p.meta.author || blog.author,
    ...(p.meta.noindex === 'true' ? { noindex: true } : {}),
    ...(p.meta.canonical ? { canonical: p.meta.canonical } : {}),
    html: r.bodyHtml,
  };
}

// A standalone page as the index records it.
export const pageEntryOf = (p) => ({
  slug: p.slug,
  title: p.meta.title,
  ...(p.meta.menu !== undefined ? { menu: Number(p.meta.menu) } : {}),
  ...(p.meta.date ? { date: p.meta.date } : {}),
  ...(p.meta.noindex === 'true' ? { noindex: true } : {}),
  ...(p.meta.canonical ? { canonical: p.meta.canonical } : {}),
});

// What the sitemap needs to know of each address, read from the index's own records.
export const sitemapMetas = (entries, pages) => new Map([...entries, ...pages].map((e) => [e.slug, { ...(e.noindex ? { noindex: 'true' } : {}), ...(e.canonical ? { canonical: e.canonical } : {}), ...(e.date ? { date: e.date } : {}) }]));

// A blog with more posts than this keeps its index in shards (index/posts-N.json, by the same hash as the search shards), listed
// by a small index/posts.json that holds the sequence: a new post then changes that and one shard, not five megabytes.
export const INDEX_SHARD_OVER = 500;

// index/posts.json (and the shards): the resolved sequence is recorded, so nothing that reads the index has to sort (or can
// disagree). Read back with readIndex (lib/index-data.js), which gives the same shape either way.
export function indexData({ order, sequence, posts, pages, redirects, home, homeAfter }) {
  const head = { generator: GENERATOR, generatorId: GENERATOR_ID, order, sequence };
  const tail = { ...(pages.length ? { pages } : {}), ...(redirects.length ? { redirects } : {}), ...(home ? { home } : {}), ...(homeAfter ? { homeAfter } : {}) };
  if (posts.length <= INDEX_SHARD_OVER) return { 'index/posts.json': json({ version: 2, ...head, posts, ...tail }) };
  const shards = Array.from({ length: SEARCH_SHARDS }, () => []);
  for (const e of posts) shards[shardOf(e.slug)].push(e);
  const names = shards.map((_, i) => `index/posts-${i}.json`);
  return { 'index/posts.json': json({ version: 3, ...head, shards: names, ...tail }), ...Object.fromEntries(shards.map((list, i) => [names[i], json({ version: 3, posts: list })])) };
}

// search.json, or for a big blog a list of shards and the shards. texts: slug -> the post's plain text.
export const searchPost = (e, text) => ({ slug: e.slug, title: e.title, date: e.date, tags: e.tags, excerpt: e.excerpt, text: (text || '').slice(0, SEARCH_TEXT_MAX) });
export function searchFiles(entries, texts) {
  const one = (e) => searchPost(e, texts.get(e.slug));
  if (entries.length <= SEARCH_SHARD_OVER) return { 'search.json': json({ version: 1, posts: entries.map(one) }) };
  const shards = Array.from({ length: SEARCH_SHARDS }, () => []);
  for (const e of entries) shards[shardOf(e.slug)].push(one(e));
  const names = shards.map((_, i) => `search/data-${i}.json`);
  return { 'search.json': json({ version: 2, shards: names }), ...Object.fromEntries(shards.map((posts, i) => [names[i], json({ version: 1, posts })])) };
}

export const json = (o) => JSON.stringify(o, null, 2) + '\n';

// The video figures our renderer emits are not an extension's to touch: they are swapped for
// placeholders while the html hooks run, and put back after.
const VIDEO_FIGURE = /<figure class="[^"]*\bvideo\b[^"]*">[\s\S]*?<\/figure>/g;
function protectVideos(html) {
  const saved = [];
  const masked = html.replace(VIDEO_FIGURE, (m) => `<span data-slot="v${saved.push(m) - 1}"></span>`);
  return { masked, restore: (out) => out.replace(/<span data-slot="v(\d+)"><\/span>/g, (m, i) => saved[Number(i)] ?? '') };
}

// ctx: { contract, css, comment, hooks, logoUrl } — all optional; a plain blog needs none.
// Render one post to a full HTML page. Refuses drafts.
export function renderPost(blog, post, lock, ctx = {}) {
  if (post.status !== 'published') throw new Refusal('draft-in-publish', `"${post.slug}" is ${post.status === 'scheduled' ? 'scheduled, not published' : 'a draft'}`, post.path);
  const resolve = (ref) => resolveAsset(ref, blog, lock);
  const hookCtx = { slug: post.slug, title: post.meta.title, date: post.meta.date, tags: post.meta.tags || [] };
  const contract = ctx.contract || DEFAULT_CONTRACT;
  let delta = post.delta;
  if (ctx.hooks) {
    const md = ctx.hooks.apply('post:markdown', post.body, hookCtx);
    if (md !== post.body) delta = mdToDelta(md);
  }
  let bodyHtml;
  try {
    bodyHtml = deltaToHtml(delta, { resolve, resolveVideo: (ref) => videoEmbedUrl(ref, blog), strict: true, contract: contractName(contract) });
  } catch (e) {
    if (delta !== post.delta && e instanceof Refusal) throw new Refusal('unsafe-extension-output', `an extension's markdown cannot be rendered: ${e.detail}`);
    throw e;
  }
  if (ctx.hooks) {
    const { masked, restore } = protectVideos(bodyHtml);
    bodyHtml = restore(ctx.hooks.apply('post:html', masked, hookCtx));
  }
  // `cover: auto` picks the post's own picture for the share preview and shows nothing on the page
  const auto = post.meta.cover === AUTO_COVER;
  const picked = auto ? autoCover(post.delta, blog) : null;
  const cover = auto ? (picked && picked.ref) || blog.cover : post.meta.cover || blog.cover;
  const image = post.meta.image ? resolve(post.meta.image) : picked && picked.url ? picked.url : cover ? resolve(cover) : null;
  const description = post.meta.description || excerpt(post.delta);
  const isPage = post.kind === 'page';
  return {
    html: postPage({
      blog,
      post: { ...post, description },
      bodyHtml,
      url: `${blog.domain}/${post.slug}/`,
      nav: ctx.nav || null,
      related: ctx.related || null,
      site: ctx.site || null,
      words: wordCount(post.delta),
      sourceSha: post.text ? sha256(post.text) : null,
      // a standalone page is not a post: the live script has no posts/<slug>.md to check it against
      live: ctx.live && !isPage ? { ...ctx.live, kind: 'post', slug: post.slug, src: `../${LIVE_FILE}` } : null,
      image,
      coverUrl: post.meta.cover && !auto ? resolve(post.meta.cover) : null,
      logoUrl: ctx.logoUrl !== undefined ? ctx.logoUrl : resolveLogo(blog, lock),
      contract,
      css: ctx.css || themeCss(blog),
      comment: ctx.comment || '',
    }),
    bodyHtml,
    description,
    image,
  };
}

// buildSite({ blog, posts: [{path,text}], lock }) -> { files, index, errors, warnings }
// Refuses (errors non-empty, files empty) rather than emitting a partial site.
//   theme / extensions: the verified packs for blog.theme / blog.extensions (lib/theme-pack.js,
//   lib/extensions.js); outputs: the recorded extension outputs. The generator runs no extension
//   code: a missing output is reported in `missing` (and as extension-output-missing).
// The index page and, when blog.json asks for pagination, the pages after it ("page/2/index.html"): a map of path -> html.
// buildSite writes these, and the /blog/ reader asks for the same ones (lib/preview.js), so the two cannot differ.
// `only`: make just that one file.
// A standalone page with this slug is the blog's front: its body is shown above the posts on the index, in place of the title.
export const HOME_SLUG = 'home';
export const HOME_AFTER_SLUG = 'home-after'; // the same, under the list of posts

const cardLayout = (blog) => !!(blog.customize && blog.customize.list && blog.customize.list.layout === 'cards');

// A card shows its post's cover; a post with none shows the first picture in its text instead. The index records that picture as
// `thumb` (only for a card layout, and only for a post with no cover, so other blogs' indexes are unchanged).
function thumbOf(blog, p, picked) {
  if (!cardLayout(blog) || (p.meta.cover && p.meta.cover !== AUTO_COVER) || (picked && picked.ref)) return {};
  const thumb = firstImage(p.delta);
  return thumb ? { thumb } : {};
}

// In a card layout each post shows its cover, or its first picture: the entry gains `coverUrl` (its pinned address). Other layouts need none.
export function withCoverUrls(entries, blog, lock) {
  if (!cardLayout(blog)) return entries;
  return entries.map((e) => {
    let coverUrl = null;
    try {
      if (e.cover) coverUrl = resolveAsset(e.cover, blog, lock);
      else if (e.thumb) coverUrl = isAssetRef(e.thumb) ? resolveAsset(e.thumb, blog, lock) : e.thumb;
    } catch {
      /* a cover that is not pinned shows no picture */
    }
    return coverUrl ? { ...e, coverUrl } : e;
  });
}

export function indexFiles({ blog, entries, size, contract, css, comment, logoUrl, site, hooks, live, indexImage, homeHtml = '', homeAfterHtml = '', only = null }) {
  const files = {};
  for (const p of pagesOf(entries, size, '', paginationStable(blog))) {
    const file = p.n === 1 ? 'index.html' : p.path;
    if (only && only !== file) continue;
    const view = viewFrom(site, p.home);
    const hrefFor = (slug) => (p.n === 1 ? `${slug}/` : `${p.home}${slug}/`);
    const indexHtml = hooks.apply('index:html', indexList(contract, { blog, entries: p.entries, hrefFor, tagHref: view.tagHref }), {}) + (p.of > 1 ? `\n${pagerHtml(p)}` : '');
    files[file] =
      p.n === 1
        ? indexPage({ blog, entries, url: `${blog.domain}/`, image: indexImage, logoUrl, contract, css, comment, indexHtml, live: live && { ...live, kind: 'index', src: `./${LIVE_FILE}` }, site, nav: p.nav, after: subscribeHtml(blog), homeHtml, homeAfterHtml })
        : listingPage({ blog, contract, css, comment, logoUrl, site, title: pageName(p), heading: blog.title, intro: pageOf(p), url: `${blog.domain}/${PAGE_DIR}/${p.at}/`, home: p.home, indexHtml, nav: p.nav, after: subscribeHtml(blog) });
  }
  return files;
}

export function buildSite({ blog: blogRaw, posts: inputs, lock = {}, theme = null, extensions = [], outputs = {}, orderList = null }) {
  let blog = validateBlog(blogRaw);
  const errors = [];
  const warnings = [];
  const parsed = [];

  const wrongPack = (what, pin, loaded) => (!loaded || loaded.pin.repo !== pin.repo || loaded.pin.ref !== pin.ref || loaded.pin.sha256 !== pin.sha256 ? new Refusal(what === 'theme' ? 'bad-theme' : 'bad-extension', `blog.json pins ${what} ${pin.repo}@${pin.ref} but it was not loaded and verified`) : null);
  if (blog.theme && typeof blog.theme === 'object') {
    const e = wrongPack('theme', blog.theme, theme);
    if (e) return { files: {}, index: null, errors: [e], warnings, missing: [] };
  }
  const pinned = blog.extensions || [];
  for (const [i, pin] of pinned.entries()) {
    const e = wrongPack('extension', pin, extensions[i]);
    if (e) return { files: {}, index: null, errors: [e], warnings, missing: [] };
  }
  const usedTheme = blog.theme && typeof blog.theme === 'object' ? theme : null;
  // blogs that name where their live copy is read from ship the script that uses it (lib/live.js)
  const live = liveEnabled(blog) ? { base: contentBase(blog) } : null;
  const contract = usedTheme ? usedTheme.contractSpec : DEFAULT_CONTRACT;
  const css = themeCss(blog, usedTheme);
  const loaded = { theme: usedTheme, extensions: pinned.map((_, i) => extensions[i]) };
  const comment = licenceComment(blog, loaded);
  const hooks = makeHooks({ extensions: loaded.extensions, outputs });

  // The header logo is part of every page: refuse once, up front, rather than once per page.
  let logoUrl = null;
  try {
    logoUrl = resolveLogo(blog, lock);
    blog = withAssetUrls(blog, lock); // link icons are as much a part of every page as the logo is
  } catch (e) {
    return { files: {}, index: null, errors: [e], warnings, missing: [] };
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
  const publishedPages = [];
  for (const p of parsed) {
    if (p.status !== 'published') {
      if (p.lossy) warnings.push(`${p.path}: ${p.status} is not canonical markdown — ${p.lossy.detail}`);
      continue; // drafts and scheduled posts appear in no index, page, feed, sitemap or search
    }
    if (p.lossy) {
      errors.push(p.lossy);
      continue;
    }
    (p.kind === 'page' ? publishedPages : published).push(p);
  }
  // A scheduled post is on no page of the site, but its extension runs are recorded now: the workflow that publishes it runs
  // no extension, so an output missing at go-live would leave the post silently unpublished (lib/schedule.js).
  if (pinned.length) {
    for (const p of parsed) {
      if (p.status !== 'scheduled' || p.lossy) continue;
      try {
        renderPost(blog, { ...p, status: 'published' }, lock, { contract, css, comment, hooks, logoUrl, site: null });
      } catch (e) {
        if (!(e instanceof Refusal)) throw e; // a reference that does not resolve yet is the editor's to refuse, not the build's
      }
    }
  }

  // The order of the blog (lib/order.js): decided once, here, and then only read: by the index, by each page's
  // previous/next, and by the feed. Drafts are not in it; a draft in order.json is skipped, never linked.
  const order = resolveOrder(blog);
  let list = null;
  if (order.by === 'manual') {
    try {
      list = parseOrderList(orderList, order.list);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      errors.push(e);
    }
  }
  const fileSlugs = new Set(inputs.map((i) => POST_PATH.exec(i.path)).filter(Boolean).map((m) => m[1]));
  const seq = order.by === 'manual' && !list ? { slugs: [], appended: [], errors: [] } : sequenceOf({ order, posts: published, files: fileSlugs, list });
  errors.push(...seq.errors);
  if (seq.appended.length) warnings.push(`order: ${seq.appended.length} published post(s) are not in ${order.list} and were appended by date: ${seq.appended.join(', ')}`);
  const titles = new Map(published.map((p) => [p.slug, p.meta.title]));

  // Old addresses: a page at each, sending the reader to the post. Judged on published items; a draft's aliases wait for it.
  const redirects = checkAliases([...published, ...publishedPages].map((p) => ({ path: p.path, slug: p.slug, aliases: parseAliases(p.meta, p.path) })), { slugs: new Set(seen.keys()), shared: sharedTopLevel(blog) });
  errors.push(...redirects.errors);
  const titleOf = new Map([...published, ...publishedPages].map((p) => [p.slug, p.meta.title]));

  // What every page needs to know of the rest of the site (the header menu, where tags and authors live). It depends
  // on the posts' tags and authors and on the pages' menu positions, all known before anything is rendered.
  const pageInfo = publishedPages.map(pageEntryOf).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const site = siteModel(blog, { entries: published.map((p) => ({ slug: p.slug, title: p.meta.title, date: p.meta.date, tags: p.meta.tags || [], author: p.meta.author || blog.author })), pages: pageInfo });

  const checkReferences = (p) => checkPostReferences(p, blog, lock);

  const relatedPool = relatedCount(blog) ? published.map((p) => ({ slug: p.slug, title: p.meta.title, tags: p.meta.tags || [] })) : [];
  const entries = [];
  const pages = new Map();
  const searchText = new Map();
  for (const p of published) {
    try {
      checkReferences(p);
      const picked = p.meta.cover === AUTO_COVER ? autoCover(p.delta, blog) : null;
      if (!p.meta.cover && !blog.cover) warnings.push(`${p.path}: no cover and no blog.json cover — page has no og:image`);
      else if (p.meta.cover === AUTO_COVER && !picked && !blog.cover) warnings.push(`${p.path}: cover is auto but the post has no image or video, and blog.json has no cover — page has no og:image`);
      const nav = neighbours(seq.slugs, p.slug, titles, (slug) => `../${slug}/`);
      const r = renderPost(blog, p, lock, { contract, css, comment, hooks, logoUrl, live, nav, site, related: relatedFor(relatedPool, seq.slugs, p.slug, relatedCount(blog)) });
      pages.set(p.slug, r.html);
      searchText.set(p.slug, plainLines(p.delta).map((l) => l.text).filter(Boolean).join('\n'));
      entries.push(entryOf(blog, p, r, picked));
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      errors.push(e.at(p.path));
    }
  }
  const staticPages = new Map();
  let homeHtml = '';
  let homeAfterHtml = '';
  for (const p of publishedPages) {
    try {
      checkReferences(p);
      if (!p.meta.cover && !blog.cover && !p.meta.image) warnings.push(`${p.path}: no cover and no blog.json cover — page has no og:image`);
      const r = renderPost(blog, p, lock, { contract, css, comment, hooks, logoUrl, site });
      staticPages.set(p.slug, r.html);
      if (p.slug === HOME_SLUG) homeHtml = r.bodyHtml;
      if (p.slug === HOME_AFTER_SLUG) homeAfterHtml = r.bodyHtml;
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      errors.push(e.at(p.path));
    }
  }
  const place = new Map(seq.slugs.map((s, i) => [s, i]));
  entries.sort((a, b) => place.get(a.slug) - place.get(b.slug));

  if (errors.length) return { files: {}, index: null, errors, warnings, missing: [] };

  // the public entries carry the author (a reader's own list needs it to link authors, as the pages do)
  const publicEntries = entries.map(({ html, ...e }) => e);
  const files = {
    '.nojekyll': '',
    // the resolved sequence is recorded, so nothing that reads the index has to sort (or can disagree)
    ...indexData({ order, sequence: seq.slugs, posts: publicEntries, pages: pageInfo, redirects: redirects.records, home: homeHtml, homeAfter: homeAfterHtml }),
    'feed.xml': atomFeed({ blog, entries: entries.slice(0, FEED_LIMIT), base: blog.domain }),
    'licences.json': licencesJson(blog, loaded),
  };
  if (usedTheme) files['theme.css'] = css + '\n'; // what the /blog/ reader applies; pages inline the same CSS
  if (usedTheme && usedTheme.skeleton) files[SKELETON_FILE] = json(usedTheme.skeleton); // and the page structure it pours the content into
  if (stylesheetLinked(blog)) files[STYLE_FILE] = css + '\n'; // or link it (blog.json "stylesheet": "linked")
  let indexImage = null;
  if (blog.cover) {
    try {
      indexImage = resolveAsset(blog.cover, blog, lock);
    } catch (e) {
      return { files: {}, index: null, errors: [e], warnings, missing: [] };
    }
  }
  // the index, a page at a time when blog.json asks for pagination (the first page is index.html)
  const listed = withCoverUrls(publicEntries, blog, lock);
  const indexed = indexFiles({ blog, entries: listed, size: paginationSize(blog), contract, css, comment, logoUrl, site, hooks, live, indexImage, homeHtml, homeAfterHtml });
  if (hooks.missing.length) {
    const what = [...new Set(hooks.missing.map((m) => `${m.extension} ${m.hook}`))].join(', ');
    return { files: {}, index: null, errors: [new Refusal('extension-output-missing', `no recorded output for ${hooks.missing.length} extension run(s) (${what}). Extensions run only when you publish from the editor, in its sandbox; publish there to record them.`)], warnings, missing: hooks.missing };
  }
  if (pinned.length) files['extension-outputs.json'] = outputsFile(hooks.used);
  Object.assign(files, indexed);
  // the pages made of the posts: tags, authors, the archive, search
  const finalSite = siteModel(blog, { entries: publicEntries, pages: pageInfo });
  Object.assign(files, buildListings({ blog, contract, css, comment, logoUrl, site: finalSite, entries: listed, size: paginationSize(blog), search: searchEnabled(blog) }));
  if (searchEnabled(blog)) {
    files[SEARCH_FILE] = SEARCH_SOURCE;
    Object.assign(files, searchFiles(publicEntries, searchText));
  }
  if (live) {
    files[LIVE_FILE] = LIVE_SOURCE;
    const root = domainPath(blog);
    if (ownsNotFoundPage(blog)) files['404.html'] = notFoundPage({ blog, base: root, logoUrl, contract, css, comment, site, live: { ...live, kind: '404', src: `${root}/${LIVE_FILE}`, root } });
  }
  for (const r of redirects.records) files[`${r.from}/index.html`] = redirectPage({ blog, from: r.from, slug: r.slug, title: titleOf.get(r.slug) });
  for (const [slug, html] of pages) files[`${slug}/index.html`] = html;
  for (const [slug, html] of staticPages) files[`${slug}/index.html`] = html;
  if (sitemapEnabled(blog)) {
    Object.assign(files, sitemapFiles({ blog, entries: publicEntries, pages: pageInfo, metas: sitemapMetas(publicEntries, pageInfo), site: finalSite }));
    if (robotsEnabled(blog) && domainPath(blog) === '') files['robots.txt'] = robotsTxt(blog);
  }
  return { files, index: publicEntries, pages: pageInfo, sequence: seq.slugs, unlisted: seq.appended, errors, warnings, missing: [] };
}

// Generated page directories are recognised by their generator meta tag; used to
// find stale pages (a post unpublished or deleted).
export const GENERATED_MARK = `<meta name="generator" content="${GENERATOR}">`;
export { lockKey };

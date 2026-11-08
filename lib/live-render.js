// Rebuilding one post page from the live copy of the blog's files, with the same code the generator uses.
// buildSite (lib/blog.js) and this module both end in renderPost; this one only has to gather what
// buildSite is handed: blog.json, the asset pins, the theme's CSS, the licence records and the recorded
// extension outputs are all files the generator committed, so they can be read back instead of
// re-derived. Pure: no DOM, no network (the caller supplies the bytes).
import { Refusal } from './errors.js';
import { parsePost, renderPost, validateBlog } from './blog.js';
import { DEFAULT_CONTRACT } from './contracts.js';
import { checkBodyClass, checkSkeleton } from './skeleton.js';
import { themeCss, resolveLogo, withAssetUrls } from './customize.js';
import { licenceComment } from './licences.js';
import { makeHooks, parseOutputsFile } from './extensions.js';
import { contentBase, liveEnabled } from './content.js';
import { neighbours } from './order.js';
import { relatedCount, relatedFor } from './related.js';
import { siteModel } from './site-model.js';
import { readIndex } from './index-data.js';

const dec = new TextDecoder('utf-8');

// Never rebuilt in a browser: say why, so the page is simply left as the build wrote it.
export class CannotRebuild extends Error {
  constructor(reason, detail = '') {
    super(`${reason}${detail ? `: ${detail}` : ''}`);
    this.reason = reason;
  }
}

// get(path) -> Promise<Uint8Array | null>   (null: there is no such file)
// `index`: the parsed live index/posts.json when the caller already has it (the 404 path has just read it).
// `anyBlog`: the /blog/ reader previews every blog, not only one that has switched its live copy on (lib/preview.js).
export async function loadSite(get, { index = null, anyBlog = false } = {}) {
  const text = async (p) => {
    const b = await get(p);
    return b ? dec.decode(b) : null;
  };
  const blogText = await text('blog.json');
  if (blogText === null) throw new CannotRebuild('no-blog-json');
  let blog;
  try {
    blog = validateBlog(blogText);
  } catch (e) {
    if (e instanceof Refusal) throw new CannotRebuild('bad-blog-json', e.detail);
    throw e;
  }
  if (!anyBlog && !liveEnabled(blog)) throw new CannotRebuild('not-live', 'blog.json does not enable the live copy');
  // the files are independent of each other: ask for them together, then judge them in the order a missing one is reported
  const usedTheme = !!(blog.theme && typeof blog.theme === 'object');
  const pinned = blog.extensions || [];
  const [lockText, themeText, licenceText, outputsText, read, skeletonText] = await Promise.all([
    text('assets.lock.json'),
    usedTheme ? text('theme.css') : null,
    text('licences.json'),
    pinned.length ? text('extension-outputs.json') : null,
    index ? { index } : readIndex(text).then((i) => ({ index: i }), (e) => ({ error: e })),
    usedTheme ? text('theme-skeleton.json') : null, // the page structure a theme brings, if it brings one
  ]);
  if (usedTheme && themeText === null) throw new CannotRebuild('no-theme-css');
  if (licenceText === null) throw new CannotRebuild('no-licences-json');
  if (read.error) throw new CannotRebuild('unreadable-site-file', read.error.message);
  try {
    return {
      blog,
      index: read.index,
      lock: lockText ? JSON.parse(lockText) : {},
      themeText,
      skeletonText,
      records: JSON.parse(licenceText).dependencies || [],
      outputs: parseOutputsFile(outputsText),
    };
  } catch (e) {
    throw new CannotRebuild('unreadable-site-file', e.message);
  }
}

// The packs buildSite would have loaded, as far as the generated output depends on them: the manifest
// fields that reach a page (its markup contract, the source and attribution stamped into a comment, the
// hooks an extension implements) are exactly what licences.json recorded.
export function packsFromRecords(blog, records) {
  const theme = records.find((r) => r.kind === 'theme' && !r.builtin);
  const exts = records.filter((r) => r.kind === 'extension');
  const pinned = blog.extensions || [];
  if (exts.length !== pinned.length) throw new CannotRebuild('stale-licences-json', 'licences.json does not match blog.json');
  return {
    theme: theme ? { manifest: { class_contract: theme.contract, source: theme.source, attribution: theme.attribution, dropped: theme.dropped } } : null,
    extensions: pinned.map((pin, i) => ({ pin, digest: pin.sha256, manifest: { kind: exts[i].extensionKind, hooks: exts[i].hooks || pin.hooks, source: exts[i].source, attribution: exts[i].attribution } })),
  };
}

// What every page of the site is made with, as the build had it (the markup contract, the CSS, the licence comment, the hooks
// of the pinned extensions, the logo, whether pages carry the live script, and the site model for the header and the tag and
// author links). Shared by the live renderer and the /blog/ reader's preview (lib/preview.js).
// The committed skeleton is data from the blog's repository: it is judged by the same rules as at import before it shapes a page.
function contractOf(name, skeletonText) {
  if (!skeletonText) return name;
  try {
    const sk = JSON.parse(skeletonText);
    return { name, skeleton: { html: checkSkeleton(sk.html), bodyClass: checkBodyClass(sk.bodyClass || undefined) } };
  } catch (e) {
    if (e instanceof Refusal) throw new CannotRebuild('bad-theme-skeleton', e.detail);
    throw new CannotRebuild('unreadable-site-file', 'theme-skeleton.json is not valid');
  }
}

export function renderContext(site) {
  const { blog, lock, themeText, skeletonText, records, outputs, index } = site;
  if (!index || !Array.isArray(index.posts)) throw new CannotRebuild('no-index', 'the live index is missing');
  const packs = packsFromRecords(blog, records);
  const usedTheme = !!(blog.theme && typeof blog.theme === 'object');
  const hooks = makeHooks({ extensions: packs.extensions, outputs });
  try {
    return {
      blog: withAssetUrls(blog, lock), // with its link icons' pinned addresses, as the build had it
      lock,
      index,
      home: typeof index.home === 'string' ? index.home : '',
      homeAfter: typeof index.homeAfter === 'string' ? index.homeAfter : '',
      hooks,
      contract: usedTheme ? contractOf(packs.theme.manifest.class_contract || (blog.theme && blog.theme.contract) || DEFAULT_CONTRACT, skeletonText) : DEFAULT_CONTRACT,
      css: usedTheme ? themeText.replace(/\n$/, '') : themeCss(blog),
      comment: licenceComment(blog, packs),
      logoUrl: resolveLogo(blog, lock),
      site: siteModel(blog, { entries: index.posts, pages: index.pages || [] }),
    };
  } catch (e) {
    if (e instanceof Refusal) throw new CannotRebuild(e.code, e.detail);
    throw e;
  }
}

// -> { html, slug, published }. Throws CannotRebuild when a page identical to the build's cannot be made.
export function renderFromSite(site, { slug, text }) {
  let post;
  try {
    post = parsePost({ path: `posts/${slug}.md`, text });
  } catch (e) {
    if (e instanceof Refusal) throw new CannotRebuild(e.code, e.detail);
    throw e;
  }
  if (post.status !== 'published') return { html: null, slug, published: false, post };
  if (post.lossy) throw new CannotRebuild(post.lossy.code, post.lossy.detail);
  const { blog, lock, index, hooks, ...rest } = renderContext(site);
  // Previous / next come from the sequence the build recorded in the index: this module never sorts (lib/order.js
  // decided the order once), so a page rebuilt here has the neighbours the next build will give it.
  const slugs = Array.isArray(index.sequence) ? index.sequence : index.posts.map((e) => e.slug);
  const nav = neighbours(slugs, slug, new Map(index.posts.map((e) => [e.slug, e.title])), (s) => `../${s}/`);
  if (!nav) throw new CannotRebuild('not-in-index', `"${slug}" is not in the live index`);
  let rendered;
  try {
    rendered = renderPost(blog, post, lock, { contract: rest.contract, css: rest.css, comment: rest.comment, hooks, logoUrl: rest.logoUrl, live: { base: contentBase(blog) }, nav, site: rest.site, related: relatedFor(index.posts, slugs, slug, relatedCount(blog)) });
  } catch (e) {
    if (e instanceof Refusal) throw new CannotRebuild(e.code, e.detail);
    throw e;
  }
  if (hooks.missing.length) throw new CannotRebuild('extension-output-missing', 'an extension has no recorded output for this post yet');
  return { html: rendered.html, slug, published: true, post };
}

// The 404 variant of a rebuilt page: the status is still 404, so a crawler must not index it; the page
// that settles after the build will be indexed instead.
export const withNoindex = (html) => html.replace('</head>', '<meta name="robots" content="noindex">\n</head>');

export { DEFAULT_CONTRACT };

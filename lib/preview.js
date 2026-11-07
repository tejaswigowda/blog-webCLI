// The /blog/ reader's pages are made here, by the code that makes the deployed ones. A page of the published site is a file
// ("index.html", "page/2/index.html", "tags/video/index.html", "<slug>/index.html"); this makes that file from the committed
// source, with the same functions buildSite calls (indexFiles, buildListings, renderPost, notFoundPage) and the same recorded
// inputs (blog.json, assets.lock.json, index/posts.json, theme.css, licences.json), so the preview and what GitHub Pages serves
// are one page, and a test holds that byte for byte (test/preview.test.js).
// Pure: the caller fetches the files. Never sorts and never re-reads a post's neighbours: the order is the index's.
import { Refusal } from './errors.js';
import { indexFiles, parsePost, renderPost } from './blog.js';
import { buildListings } from './listings.js';
import { CannotRebuild, renderContext } from './live-render.js';
import { contentBase, domainPath, liveEnabled } from './content.js';
import { LIVE_FILE, notFoundPage } from './page.js';
import { neighbours } from './order.js';
import { paginationSize, searchEnabled } from './seo.js';
import { resolveAsset } from './assets.js';

export { CannotRebuild };

// "tags/video/" and "tags/video" and "tags/video/index.html" are the same page; the index is "".
export function fileFor(path) {
  const p = String(path || '').replace(/^\/+/, '').replace(/index\.html$/, '').replace(/\/+$/, '');
  return p ? `${p}/index.html` : 'index.html';
}

// The source file the page is made from, or null when it is made from the index alone.
export function sourceOf(site, file) {
  const m = /^([^/]+)\/index\.html$/.exec(file);
  if (!m) return null;
  const { index } = site;
  if (index.posts.some((e) => e.slug === m[1])) return `posts/${m[1]}.md`;
  if ((index.pages || []).some((e) => e.slug === m[1])) return `pages/${m[1]}.md`;
  return null;
}

const LISTING = /^(tags|authors)\/.+\/index\.html$|^(tags|archive|search)\/index\.html$/;

// -> { html, status: 200 | 404 }. `text` is the markdown of sourceOf(site, file), when there is one.
export function previewHtml(site, file, { text = null, entries = null, size = null } = {}) {
  const ctx = renderContext(site);
  const { blog, lock, index, hooks } = ctx;
  const live = liveEnabled(blog) ? { base: contentBase(blog) } : null;
  const common = { blog, contract: ctx.contract, css: ctx.css, comment: ctx.comment, logoUrl: ctx.logoUrl, site: ctx.site };

  if (file === 'index.html' || /^page\/\d+\/index\.html$/.test(file)) {
    let indexImage = null;
    if (blog.cover) indexImage = resolveAsset(blog.cover, blog, lock);
    const html = indexFiles({ ...common, entries: entries || index.posts, size: size === null ? paginationSize(blog) : size, hooks, live, indexImage, only: file })[file];
    return html === undefined ? notFound(ctx, live) : { html, status: 200 };
  }
  if (LISTING.test(file)) {
    const html = buildListings({ ...common, entries: index.posts, size: paginationSize(blog), search: searchEnabled(blog), only: file })[file];
    return html === undefined ? notFound(ctx, live) : { html, status: 200 };
  }
  const slug = (/^([^/]+)\/index\.html$/.exec(file) || [])[1];
  const source = slug && sourceOf(site, file);
  if (!source) return notFound(ctx, live);
  if (text === null) return notFound(ctx, live);
  let post;
  try {
    post = parsePost({ path: source, text });
  } catch (e) {
    if (e instanceof Refusal) throw new CannotRebuild(e.code, e.detail);
    throw e;
  }
  if (post.status !== 'published') return notFound(ctx, live); // a draft is not on the site, so it is not here
  if (post.lossy) throw new CannotRebuild(post.lossy.code, post.lossy.detail);
  const isPage = post.kind === 'page';
  let nav = null;
  if (!isPage) {
    const slugs = Array.isArray(index.sequence) ? index.sequence : index.posts.map((e) => e.slug);
    nav = neighbours(slugs, slug, new Map(index.posts.map((e) => [e.slug, e.title])), (s) => `../${s}/`);
  }
  try {
    const r = renderPost(blog, post, lock, { ...common, hooks, ...(isPage ? {} : { live, nav }) });
    return { html: r.html, status: 200 };
  } catch (e) {
    if (e instanceof Refusal) throw new CannotRebuild(e.code, e.detail);
    throw e;
  }
}

// What the site serves for an address it has no page for: its own 404.html (a blog in a folder of a shared repository has none; it
// gets the same page, made the same way).
function notFound(ctx, live) {
  const { blog } = ctx;
  const root = domainPath(blog);
  const html = notFoundPage({ blog, base: root, logoUrl: ctx.logoUrl, contract: ctx.contract, css: ctx.css, comment: ctx.comment, site: ctx.site, live: live && { ...live, kind: '404', src: `${root}/${LIVE_FILE}`, root } });
  return { html, status: 404 };
}

// The /blog/ reader's pages are made here, by the code that makes the deployed ones. A page of the published site is a file
// ("index.html", "page/2/index.html", "tags/video/index.html", "<slug>/index.html"); this makes that file from the committed
// source, with the same functions buildSite calls (indexFiles, buildListings, renderPost, notFoundPage) and the same recorded
// inputs (blog.json, assets.lock.json, index/posts.json, theme.css, licences.json), so the preview and what GitHub Pages serves
// are one page, and a test holds that byte for byte (test/preview.test.js).
// Pure: the caller fetches the files. Never sorts and never re-reads a post's neighbours: the order is the index's.
import { Refusal } from './errors.js';
import { indexFiles, parsePost, renderPost, withCoverUrls } from './blog.js';
import { buildListings } from './listings.js';
import { CannotRebuild, commentsOf, renderContext } from './live-render.js';
import { contentBase, domainPath, liveEnabled } from './content.js';
import { addressFile, flatPage, upFrom } from './permalink.js';
import { LIVE_FILE, feedNoticePage, notFoundPage, redirectPage } from './page.js';
import { neighbours } from './order.js';
import { relatedCount, relatedFor } from './related.js';
import { paginationSize, searchEnabled } from './seo.js';
import { resolveAsset } from './assets.js';

export { CannotRebuild };

// "tags/video/" and "tags/video" and "tags/video/index.html" are the same page; the index is "".
export function fileFor(path) {
  const p = String(path || '').replace(/^\/+|\/+$/g, '');
  return p ? addressFile(p) : 'index.html';
}

// The source file the page is made from, or null when it is made from the index alone.
export function sourceOf(site, file) {
  const address = file.replace(/\/index\.html$/, '');
  const { index } = site;
  const post = index.posts.find((e) => (e.path || e.slug) === address);
  if (post) return `posts/${post.slug}.md`;
  const page = (index.pages || []).find((e) => (e.path || e.slug) === address);
  if (page) return `pages/${page.slug}.md`;
  return null;
}

const LISTING = /^(tags|authors)\/.+\/index\.html$|^(tags|archive|search)\/index\.html$|^archive\/\d{4}\/index\.html$/;

// -> { html, status: 200 | 404, redirect? }. `text` is the markdown of sourceOf(site, file), when there is one; `comments` the text of that post's comments/<slug>.json.
// `css` is the page's stylesheet, which the page links rather than carries when the blog says "stylesheet": "linked".
export function previewHtml(site, file, opts = {}) {
  const ctx = renderContext(site);
  return { ...previewPage(ctx, site, file, opts), css: ctx.css };
}

function previewPage(ctx, site, file, { text = null, comments = null, entries = null, size = null } = {}) {
  const { blog, lock, index } = ctx;
  const live = liveEnabled(blog) ? { base: contentBase(blog) } : null;
  const common = { blog, contract: ctx.contract, css: ctx.css, comment: ctx.comment, logoUrl: ctx.logoUrl, site: ctx.site };

  if (file === 'index.html' || /^page\/\d+\/index\.html$/.test(file)) {
    let indexImage = null;
    if (blog.cover) indexImage = resolveAsset(blog.cover, blog, lock);
    const html = indexFiles({ ...common, entries: withCoverUrls(entries || index.posts, blog, lock), size: size === null ? paginationSize(blog) : size, live, indexImage, homeHtml: ctx.home, homeAfterHtml: ctx.homeAfter, only: file })[file];
    return html === undefined ? notFound(ctx, live) : { html, status: 200 };
  }
  if (LISTING.test(file)) {
    const html = buildListings({ ...common, entries: withCoverUrls(index.posts, blog, lock), size: paginationSize(blog), search: searchEnabled(blog), only: file })[file];
    return html === undefined ? notFound(ctx, live) : { html, status: 200 };
  }
  if (file === 'feed/index.html' && index.posts.length) return { html: feedNoticePage({ blog }), status: 200 };
  // an old address: the page the build writes there, which sends the reader to the post (`redirect` names it, so a reader can follow at once)
  const flatAlias = (r) => flatPage(blog) && r.from.endsWith('.html') && (index.pages || []).some((p) => p.slug === r.slug);
  const moved = (index.redirects || []).find((r) => (flatAlias(r) ? addressFile(r.from) : `${r.from}/index.html`) === file);
  if (moved) {
    // an old listing address (blog.json archiveAliases) names the page that replaced it
    if (moved.to) return { html: redirectPage({ blog, from: moved.from, slug: moved.to, title: moved.title, addr: moved.to }), status: 200 };
    const to = [...index.posts, ...(index.pages || [])].find((e) => e.slug === moved.slug);
    if (to) return { html: redirectPage({ blog, from: moved.from, flat: flatAlias(moved), slug: moved.slug, title: to.title, addr: to.path || to.slug }), status: 200, redirect: moved.slug };
  }
  const source = sourceOf(site, file);
  if (!source) return notFound(ctx, live);
  const slug = source.replace(/^(?:posts|pages)\//, '').replace(/\.md$/, '');
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
  let related = null;
  if (!isPage) {
    const slugs = Array.isArray(index.sequence) ? index.sequence : index.posts.map((e) => e.slug);
    related = relatedFor(index.posts, slugs, slug, relatedCount(blog));
    const addrOfSlug = new Map(index.posts.map((e) => [e.slug, e.path || e.slug]));
    const up = upFrom(addrOfSlug.get(slug) || slug);
    nav = neighbours(slugs, slug, new Map(index.posts.map((e) => [e.slug, e.title])), (s) => `${up}${addrOfSlug.get(s)}/`);
  }
  try {
    const addrOfSlug = new Map([...index.posts, ...(index.pages || [])].map((e) => [e.slug, e.path || e.slug]));
    const r = renderPost(blog, post, lock, { ...common, pagePath: isPage ? addrOfSlug.get(slug) : undefined, hierarchical: (index.pages || []).some((p) => p.parent), addrOfSlug: (s) => addrOfSlug.get(s) || s, ...(isPage ? {} : { live, nav, related, comments: commentsOf(comments, slug) }) });
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

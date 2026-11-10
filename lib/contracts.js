// Markup contracts. A theme's CSS targets class names, so the generator emits the markup the theme
// expects. `blog-webcli-v1` is this app's own markup; `wordpress-classic` is the de facto contract
// of WordPress classic themes (.site-header, .entry-title, .entry-content, .hentry, …), so
// existing themes apply without conversion. Both the static pages and the /blog/ reader build
// their <body> from here, so a theme styles them identically.
import { escapeHtml as h } from './html.js';
import { sha256 } from './sha256.js';
import { dateLabel } from './datefmt.js';
import { applySkeleton } from './skeleton.js';

const custom = (blog) => blog.customize || {};
const links = (list) => (list || []).map((l) => ({ href: h(l.url), label: h(l.label), icon: l.iconUrl ? `<img class="icon" src="${h(l.iconUrl)}" alt="">` : '' }));
// a link, with its icon (when it has one) before its words; the words stay for those who cannot see the picture
const linkEl = (l, cls = '') => `<a href="${l.href}" rel="noopener noreferrer"${cls ? ` class="${cls}"` : ''}>${l.icon}${l.icon ? `<span>${l.label}</span>` : l.label}</a>`;
// The site's own pages in the header (lib/site-model.js), already resolved against the page's depth.
const menuLinks = (menu) => (menu || []).map((m) => ({ href: h(m.href), label: h(m.label) }));

// A tag, as a link to its page when the page knows where tag pages are (`tagHref`), else as plain text.
const tagEl = (t, tagHref, cls = 'tag') => (tagHref ? `<a class="${cls}" href="${h(tagHref(t))}">#${h(t)}</a>` : `<span class="${cls}">#${h(t)}</span>`);
const nameEl = (name, authorHref) => (authorHref ? `<a href="${h(authorHref(name))}">${h(name)}</a>` : h(name));
const listOpts = (blog) => ({ layout: 'list', excerpts: true, dates: true, tags: true, ...custom(blog).list });

// A stable number for WordPress-style post-N classes: derived from the slug, so adding a post
// never renumbers (and so never regenerates) the others.
export const postId = (slug) => (parseInt(sha256(slug).slice(0, 6), 16) % 90000) + 1000;

const footerParts = (blog, extra) => {
  const f = custom(blog).footer || {};
  const text = f.text ? `<span class="foot-text">${h(f.text)}</span>` : blog.author ? `<span class="foot-text">${h(blog.author)}</span>` : '';
  return [extra, text, ...links(f.links).map((l) => linkEl(l))].filter(Boolean).join(' · ');
};

// Previous / next, in the blog's own order (lib/order.js). `nav` is { prev, next } with { title, href } each, or
// null; an end of the sequence has no link at all, never a disabled one.
const hasNav = (nav) => !!(nav && (nav.prev || nav.next));

// ================= blog-webcli-v1 =================

// A bar above the header: a line of text and links (each with an icon, if it has one). Nothing at all unless blog.json has one.
function topbar(blog) {
  const t = custom(blog).topbar;
  if (!t || (!t.text && !(t.links || []).length)) return '';
  return `<div class="topbar"><div class="topbar-in">${links(t.links).map((l) => linkEl(l)).join('')}${t.text ? `<span class="topbar-text">${h(t.text)}</span>` : ''}</div></div>\n`;
}

function v1Header(blog, { home, feed, logoUrl, menu }) {
  const c = custom(blog).header || {};
  const titleHidden = c.showTitle === false && logoUrl;
  const logo = logoUrl ? `<img class="logo" src="${h(logoUrl)}" alt="${titleHidden ? h(blog.title) : ''}">` : '';
  const nav = links(c.links).map((l) => linkEl(l)).join('') + menuLinks(menu).map((l) => `<a href="${l.href}">${l.label}</a>`).join('');
  return `<header class="site"><a class="brand" href="${h(home)}">${logo}${titleHidden ? '' : h(blog.title)}</a><nav>${nav}<a href="${h(feed)}">Feed</a></nav></header>`;
}

const v1Footer = (blog, extra = '') => `<footer class="site">${footerParts(blog, extra)}</footer>`;

function v1List(entries, blog, hrefFor, tagHref) {
  const l = listOpts(blog);
  const items = entries
    .map((e) => {
      const count = e.comments ? `<a class="comments-link" href="${h(hrefFor(e.slug))}#comments">${e.comments} comment${e.comments === 1 ? '' : 's'}</a>` : '';
      const meta = [l.dates ? `<time datetime="${h(e.date)}">${h(dateLabel(blog, e.date))}</time>` : '', l.tags ? e.tags.map((t) => tagEl(t, tagHref)).join('') : '', count].join('');
      // a card shows the post's cover when it has one (the caller resolves it: entry.coverUrl)
      const thumb = l.layout === 'cards' && e.coverUrl ? `<a class="thumb" href="${h(hrefFor(e.slug))}" tabindex="-1" aria-hidden="true"><img src="${h(e.coverUrl)}" alt="" loading="lazy"></a>\n` : '';
      return `<li>
${thumb}${meta ? `<div class="meta">${meta}</div>\n` : ''}<h2><a href="${h(hrefFor(e.slug))}">${h(e.title)}</a></h2>
${l.excerpts && e.excerpt ? `<p>${h(e.excerpt)}</p>\n` : ''}</li>`;
    })
    .join('\n');
  return `<ul class="posts${l.layout === 'cards' ? ' cards' : ''}">\n${items}\n</ul>`;
}

function v1Article({ blog, meta: m, bodyHtml, coverUrl, page, tagHref, authorHref }) {
  const tags = (m.tags || []).map((t) => tagEl(t, tagHref)).join('');
  const author = m.author || blog.author;
  // a standalone page has no date, author or tags to show
  const meta = page ? '' : `<div class="meta"><time datetime="${h(m.date)}">${h(dateLabel(blog, m.date))}</time>${author ? ` · ${nameEl(author, authorHref)}` : ''}${tags}</div>\n`;
  return `<article>
<h1>${h(m.title)}</h1>
${meta}${coverUrl ? `<p class="cover"><img src="${h(coverUrl)}" alt=""></p>\n` : ''}${bodyHtml}
</article>`;
}

// What follows the content on a page: the subscribe form, comments, … (see lib/embeds.js). Nothing, normally.
const tail = (d) => (d.after ? `${d.after}\n` : '');

function v1Nav(nav) {
  if (!hasNav(nav)) return '';
  const link = (cls, rel, e, label) => `<a class="${cls}" rel="${rel}" href="${h(e.href)}">${label}</a>`;
  return `<nav class="post-nav" aria-label="Post navigation">${nav.prev ? link('prev', 'prev', nav.prev, `← ${h(nav.prev.title)}`) : ''}${nav.next ? link('next', 'next', nav.next, `${h(nav.next.title)} →`) : ''}</nav>`;
}

const v1 = {
  list: (d) => v1List(d.entries, d.blog, d.hrefFor, d.tagHref),
  index: (d) => ({
    bodyClass: '',
    html: `${topbar(d.blog)}<div class="wrap">
${v1Header(d.blog, d)}
${d.heading !== undefined ? `<h1>${h(d.heading)}</h1>\n${d.intro ? `<p class="meta">${h(d.intro)}</p>\n` : ''}` : d.homeHtml ? `<section class="home">\n${d.homeHtml}\n</section>\n` : `<h1>${h(d.blog.title)}</h1>\n<p class="meta">${h(d.blog.description)}</p>\n`}${d.indexHtml ?? v1List(d.entries, d.blog, d.hrefFor, d.tagHref)}
${d.homeAfterHtml ? `<section class="home-after">\n${d.homeAfterHtml}\n</section>\n` : ''}${tail(d)}${v1Footer(d.blog, d.footerExtra)}
</div>`,
  }),
  post: (d) => ({
    bodyClass: '',
    html: `${topbar(d.blog)}<div class="wrap">
${v1Header(d.blog, d)}
${v1Article(d)}
${v1Nav(d.nav)}${hasNav(d.nav) ? '\n' : ''}${tail(d)}${v1Footer(d.blog, d.footerExtra)}
</div>`,
  }),
};

// ================= wordpress-classic =================

// `x` is false for wordpress-classic and true for wordpress-classic-2, which adds only classes a blog can truthfully carry (see classicOf).
function classicHeader(blog, { home, feed, logoUrl, menu }, isHome, x = false) {
  const c = custom(blog).header || {};
  const titleHidden = c.showTitle === false && logoUrl;
  const logo = logoUrl ? `<div class="custom-logo-link${x ? ' site-logo' : ''}"><a href="${h(home)}" rel="home"><img class="custom-logo" src="${h(logoUrl)}" alt="${titleHidden ? h(blog.title) : ''}"></a></div>` : '';
  const title = titleHidden ? '' : isHome ? `<h1 class="site-title"><a href="${h(home)}" rel="home">${h(blog.title)}</a></h1>` : `<p class="site-title"><a href="${h(home)}" rel="home">${h(blog.title)}</a></p>`;
  const items = [...links(c.links).map((l) => `<li class="menu-item"><a href="${l.href}" rel="noopener noreferrer">${l.label}</a></li>`), ...menuLinks(menu).map((l) => `<li class="menu-item"><a href="${l.href}">${l.label}</a></li>`), `<li class="menu-item"><a href="${h(feed)}">Feed</a></li>`].join('');
  return `<a class="skip-link screen-reader-text" href="#content">Skip to content</a>
<header id="masthead" class="site-header has-title-and-tagline has-menu">
<div class="site-branding">${logo}${title}<p class="site-description">${h(blog.description)}</p></div>
<nav id="site-navigation" class="primary-navigation main-navigation" aria-label="Primary menu"><div class="primary-menu-container"><ul id="primary-menu-list" class="menu-wrapper menu${x ? ' nav-menu' : ''}">${items}</ul></div></nav>
</header>`;
}

const classicFooter = (blog, extra = '') => `<footer id="colophon" class="site-footer default-max-width"><div class="site-info">${footerParts(blog, extra)}</div></footer>`;

const tagClasses = (tags) => (tags || []).map((t) => ` tag-${String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`).join('');
const tagsLinks = (tags, tagHref) => (tags && tags.length ? `<footer class="entry-footer default-max-width"><span class="tags-links">Tagged ${tags.map((t) => (tagHref ? `<a class="tag-link" href="${h(tagHref(t))}" rel="tag">${h(t)}</a>` : `<span class="tag-link">${h(t)}</span>`)).join(', ')}</span></footer>` : '');

function classicEntry(blog, e, hrefFor, tagHref, x = false) {
  const l = listOpts(blog);
  const posted = l.dates ? `<span class="posted-on${x ? ' post-date' : ''}"><a href="${h(hrefFor(e.slug))}" rel="bookmark"><time class="entry-date published" datetime="${h(e.date)}">${h(dateLabel(blog, e.date))}</time></a></span>` : '';
  const count = e.comments ? `<span class="comments-link"><a href="${h(hrefFor(e.slug))}#comments">${e.comments} Comment${e.comments === 1 ? '' : 's'}</a></span>` : '';
  const date = posted || count ? `<div class="entry-meta default-max-width">${posted}${count}</div>` : '';
  return `<article id="post-${postId(e.slug)}" class="post-${postId(e.slug)} post type-post status-publish format-standard hentry${tagClasses(e.tags)}">
<header class="entry-header"><h2 class="entry-title default-max-width"><a href="${h(hrefFor(e.slug))}" rel="bookmark">${h(e.title)}</a></h2>${date}</header>
${l.excerpts && e.excerpt ? `<div class="entry-summary entry-content"><p>${h(e.excerpt)}</p></div>\n` : ''}${l.tags ? tagsLinks(e.tags, tagHref) : ''}
</article>`;
}

function classicNav(nav) {
  if (!hasNav(nav)) return '';
  const side = (cls, rel, e, word) => `<div class="${cls}"><a href="${h(e.href)}" rel="${rel}"><span class="meta-nav" aria-hidden="true">${word}</span> <span class="post-title">${h(e.title)}</span></a></div>`;
  return `<nav class="navigation post-navigation" aria-label="Posts"><h2 class="screen-reader-text">Post navigation</h2><div class="nav-links">${nav.prev ? side('nav-previous', 'prev', nav.prev, 'Previous') : ''}${nav.next ? side('nav-next', 'next', nav.next, 'Next') : ''}</div></nav>`;
}

const classicOf = (x) => ({
  list: (d) => d.entries.map((e) => classicEntry(d.blog, e, d.hrefFor, d.tagHref, x)).join('\n'),
  index: (d) => ({
    bodyClass: x && d.heading !== undefined ? 'archive' : 'home blog',
    html: `<div id="page" class="site">
${classicHeader(d.blog, d, d.heading === undefined, x)}
<div id="content" class="site-content"><div id="primary" class="content-area"><main id="main" class="site-main">
${d.heading !== undefined ? `<header class="page-header alignwide"><h1 class="page-title">${h(d.heading)}</h1>${d.intro ? `<div class="archive-description${x ? ' taxonomy-description' : ''}"><p>${h(d.intro)}</p></div>` : ''}</header>\n` : d.homeHtml ? `<div class="entry-content home">\n${d.homeHtml}\n</div>\n` : ''}${d.prose && d.indexHtml ? `<div class="entry-content">\n${d.indexHtml}\n</div>` : d.indexHtml ?? d.entries.map((e) => classicEntry(d.blog, e, d.hrefFor, d.tagHref, x)).join('\n')}
${d.homeAfterHtml && d.heading === undefined ? `<div class="entry-content home-after">\n${d.homeAfterHtml}\n</div>\n` : ''}${tail(d)}</main></div></div>
${classicFooter(d.blog, d.footerExtra)}
</div>`,
  }),
  post: (d) => {
    const m = d.meta;
    const id = postId(m.slug);
    const author = m.author || d.blog.author;
    const type = d.page ? 'page' : 'post';
    return {
      bodyClass: d.page ? `page-template-default page page-id-${id}` : `post-template-default single single-post postid-${id} single-format-standard`,
      html: `<div id="page" class="site">
${classicHeader(d.blog, d, false, x)}
<div id="content" class="site-content"><div id="primary" class="content-area"><main id="main" class="site-main">
<article id="post-${id}" class="post-${id} ${type} type-${type} status-publish ${d.page ? 'hentry' : `format-standard hentry${tagClasses(m.tags)}`}">
<header class="entry-header alignwide"><h1 class="entry-title">${h(m.title)}</h1>
${d.page ? '' : `<div class="entry-meta"><span class="posted-on${x ? ' post-date' : ''}"><time class="entry-date published" datetime="${h(m.date)}">${h(dateLabel(d.blog, m.date))}</time></span>${author ? `<span class="byline"> by <span class="author vcard"><span class="fn">${nameEl(author, d.authorHref)}</span></span></span>` : ''}</div>`}</header>
${d.coverUrl ? `<div class="post-thumbnail"><img class="attachment-post-thumbnail size-post-thumbnail wp-post-image" src="${h(d.coverUrl)}" alt=""></div>\n` : ''}<div class="entry-content${x && d.page ? ' page-content' : ''}">
${d.bodyHtml}
</div>
${d.page ? '' : tagsLinks(m.tags, d.tagHref)}
</article>
${classicNav(d.nav)}${hasNav(d.nav) ? '\n' : ''}${tail(d)}</main></div></div>
${classicFooter(d.blog, d.footerExtra)}
</div>`,
    };
  },
  // the pager of a paginated list: numbered-pager classes on the same links (the blog has previous and next, and the page it is on)
  pager: x ? ({ newer, older, here, prev, next }) => `<nav class="navigation pagination posts-navigation" aria-label="Pages"><div class="nav-links">${prev ? `<a class="prev page-numbers" rel="prev" href="${h(prev.href)}">${newer}</a>` : ''}<span class="page-numbers current page-of" aria-current="page">${here}</span>${next ? `<a class="next page-numbers" rel="next" href="${h(next.href)}">${older}</a>` : ''}</div></nav>` : undefined,
});
const classic = classicOf(false);
const classic2 = classicOf(true);



export const CONTRACT_BUILDERS = { 'blog-webcli-v1': v1, 'wordpress-classic': classic, 'wordpress-classic-2': classic2 };
export const DEFAULT_CONTRACT = 'blog-webcli-v1';

// A contract is its name, or { name, skeleton } when the theme brings its own page structure (lib/skeleton.js).
export const contractName = (c) => (c && typeof c === 'object' ? c.name : c);
const builderOf = (c) => CONTRACT_BUILDERS[contractName(c)] || v1;
const dressed = (c, built, d) => (c && typeof c === 'object' && c.skeleton ? applySkeleton(c.skeleton, built, d) : built);

// d: { blog, home, feed, logoUrl, footerExtra, hrefFor, entries, indexHtml? } for an index;
//    { blog, meta, bodyHtml, coverUrl, home, feed, logoUrl, footerExtra, nav } for a post.
// `indexHtml` replaces the post list (the index:html hook's output).
export const indexBody = (contract, d) => dressed(contract, builderOf(contract).index(d), d);
export const indexList = (contract, d) => builderOf(contract).list(d);
// The pager of a paginated list in this contract's own markup, or null when the contract has none (the caller's markup stands).
export const pagerBody = (contract, parts) => { const b = builderOf(contract); return b.pager ? b.pager(parts) : null; };
export const postBody = (contract, d) => dressed(contract, builderOf(contract).post(d), d);

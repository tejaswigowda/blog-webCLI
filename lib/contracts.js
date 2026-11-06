// Markup contracts. A theme's CSS targets class names, so the generator emits the markup the theme
// expects. `blog-webcli-v1` is this app's own markup; `wordpress-classic` is the de facto contract
// of WordPress classic themes (.site-header, .entry-title, .entry-content, .hentry, …), so
// existing themes apply without conversion. Both the static pages and the /blog/ reader build
// their <body> from here, so a theme styles them identically.
import { escapeHtml as h } from './html.js';
import { sha256 } from './sha256.js';

const custom = (blog) => blog.customize || {};
const links = (list) => (list || []).map((l) => ({ href: h(l.url), label: h(l.label) }));
const listOpts = (blog) => ({ layout: 'list', excerpts: true, dates: true, tags: true, ...custom(blog).list });

// A stable number for WordPress-style post-N classes: derived from the slug, so adding a post
// never renumbers (and so never regenerates) the others.
export const postId = (slug) => (parseInt(sha256(slug).slice(0, 6), 16) % 90000) + 1000;

const footerParts = (blog, extra) => {
  const f = custom(blog).footer || {};
  const text = f.text ? h(f.text) : blog.author ? h(blog.author) : '';
  return [extra, text, ...links(f.links).map((l) => `<a href="${l.href}" rel="noopener noreferrer">${l.label}</a>`)].filter(Boolean).join(' · ');
};

// ================= blog-webcli-v1 =================

function v1Header(blog, { home, feed, logoUrl }) {
  const c = custom(blog).header || {};
  const titleHidden = c.showTitle === false && logoUrl;
  const logo = logoUrl ? `<img class="logo" src="${h(logoUrl)}" alt="${titleHidden ? h(blog.title) : ''}">` : '';
  const nav = links(c.links).map((l) => `<a href="${l.href}" rel="noopener noreferrer">${l.label}</a>`).join('');
  return `<header class="site"><a class="brand" href="${h(home)}">${logo}${titleHidden ? '' : h(blog.title)}</a><nav>${nav}<a href="${h(feed)}">Feed</a></nav></header>`;
}

const v1Footer = (blog, extra = '') => `<footer class="site">${footerParts(blog, extra)}</footer>`;

function v1List(entries, blog, hrefFor) {
  const l = listOpts(blog);
  const items = entries
    .map((e) => {
      const meta = [l.dates ? `<time datetime="${h(e.date)}">${h(e.date)}</time>` : '', l.tags ? e.tags.map((t) => `<span class="tag">#${h(t)}</span>`).join('') : ''].join('');
      return `<li>
${meta ? `<div class="meta">${meta}</div>\n` : ''}<h2><a href="${h(hrefFor(e.slug))}">${h(e.title)}</a></h2>
${l.excerpts && e.excerpt ? `<p>${h(e.excerpt)}</p>\n` : ''}</li>`;
    })
    .join('\n');
  return `<ul class="posts${l.layout === 'cards' ? ' cards' : ''}">\n${items}\n</ul>`;
}

function v1Article({ blog, meta: m, bodyHtml, coverUrl }) {
  const tags = (m.tags || []).map((t) => `<span class="tag">#${h(t)}</span>`).join('');
  const author = m.author || blog.author;
  return `<article>
<h1>${h(m.title)}</h1>
<div class="meta"><time datetime="${h(m.date)}">${h(m.date)}</time>${author ? ` · ${h(author)}` : ''}${tags}</div>
${coverUrl ? `<p class="cover"><img src="${h(coverUrl)}" alt=""></p>\n` : ''}${bodyHtml}
</article>`;
}

const v1 = {
  list: (d) => v1List(d.entries, d.blog, d.hrefFor),
  index: (d) => ({
    bodyClass: '',
    html: `<div class="wrap">
${v1Header(d.blog, d)}
<h1>${h(d.blog.title)}</h1>
<p class="meta">${h(d.blog.description)}</p>
${d.indexHtml ?? v1List(d.entries, d.blog, d.hrefFor)}
${v1Footer(d.blog, d.footerExtra)}
</div>`,
  }),
  post: (d) => ({
    bodyClass: '',
    html: `<div class="wrap">
${v1Header(d.blog, d)}
${v1Article(d)}
${v1Footer(d.blog, d.footerExtra)}
</div>`,
  }),
};

// ================= wordpress-classic =================

function classicHeader(blog, { home, feed, logoUrl }, isHome) {
  const c = custom(blog).header || {};
  const titleHidden = c.showTitle === false && logoUrl;
  const logo = logoUrl ? `<div class="custom-logo-link"><a href="${h(home)}" rel="home"><img class="custom-logo" src="${h(logoUrl)}" alt="${titleHidden ? h(blog.title) : ''}"></a></div>` : '';
  const title = titleHidden ? '' : isHome ? `<h1 class="site-title"><a href="${h(home)}" rel="home">${h(blog.title)}</a></h1>` : `<p class="site-title"><a href="${h(home)}" rel="home">${h(blog.title)}</a></p>`;
  const items = [...links(c.links).map((l) => `<li class="menu-item"><a href="${l.href}" rel="noopener noreferrer">${l.label}</a></li>`), `<li class="menu-item"><a href="${h(feed)}">Feed</a></li>`].join('');
  return `<a class="skip-link screen-reader-text" href="#content">Skip to content</a>
<header id="masthead" class="site-header has-title-and-tagline has-menu">
<div class="site-branding">${logo}${title}<p class="site-description">${h(blog.description)}</p></div>
<nav id="site-navigation" class="primary-navigation main-navigation" aria-label="Primary menu"><div class="primary-menu-container"><ul id="primary-menu-list" class="menu-wrapper menu">${items}</ul></div></nav>
</header>`;
}

const classicFooter = (blog, extra = '') => `<footer id="colophon" class="site-footer default-max-width"><div class="site-info">${footerParts(blog, extra)}</div></footer>`;

const tagClasses = (tags) => (tags || []).map((t) => ` tag-${String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`).join('');
const tagsLinks = (tags) => (tags && tags.length ? `<footer class="entry-footer default-max-width"><span class="tags-links">Tagged ${tags.map((t) => `<span class="tag-link">${h(t)}</span>`).join(', ')}</span></footer>` : '');

function classicEntry(blog, e, hrefFor) {
  const l = listOpts(blog);
  const date = l.dates ? `<div class="entry-meta default-max-width"><span class="posted-on"><a href="${h(hrefFor(e.slug))}" rel="bookmark"><time class="entry-date published" datetime="${h(e.date)}">${h(e.date)}</time></a></span></div>` : '';
  return `<article id="post-${postId(e.slug)}" class="post-${postId(e.slug)} post type-post status-publish format-standard hentry${tagClasses(e.tags)}">
<header class="entry-header"><h2 class="entry-title default-max-width"><a href="${h(hrefFor(e.slug))}" rel="bookmark">${h(e.title)}</a></h2>${date}</header>
${l.excerpts && e.excerpt ? `<div class="entry-summary entry-content"><p>${h(e.excerpt)}</p></div>\n` : ''}${l.tags ? tagsLinks(e.tags) : ''}
</article>`;
}

const classic = {
  list: (d) => d.entries.map((e) => classicEntry(d.blog, e, d.hrefFor)).join('\n'),
  index: (d) => ({
    bodyClass: 'home blog',
    html: `<div id="page" class="site">
${classicHeader(d.blog, d, true)}
<div id="content" class="site-content"><div id="primary" class="content-area"><main id="main" class="site-main">
${d.indexHtml ?? d.entries.map((e) => classicEntry(d.blog, e, d.hrefFor)).join('\n')}
</main></div></div>
${classicFooter(d.blog, d.footerExtra)}
</div>`,
  }),
  post: (d) => {
    const m = d.meta;
    const id = postId(m.slug);
    const author = m.author || d.blog.author;
    return {
      bodyClass: `post-template-default single single-post postid-${id} single-format-standard`,
      html: `<div id="page" class="site">
${classicHeader(d.blog, d, false)}
<div id="content" class="site-content"><div id="primary" class="content-area"><main id="main" class="site-main">
<article id="post-${id}" class="post-${id} post type-post status-publish format-standard hentry${tagClasses(m.tags)}">
<header class="entry-header alignwide"><h1 class="entry-title">${h(m.title)}</h1>
<div class="entry-meta"><span class="posted-on"><time class="entry-date published" datetime="${h(m.date)}">${h(m.date)}</time></span>${author ? `<span class="byline"> by <span class="author vcard"><span class="fn">${h(author)}</span></span></span>` : ''}</div></header>
${d.coverUrl ? `<div class="post-thumbnail"><img class="attachment-post-thumbnail size-post-thumbnail wp-post-image" src="${h(d.coverUrl)}" alt=""></div>\n` : ''}<div class="entry-content">
${d.bodyHtml}
</div>
${tagsLinks(m.tags)}
</article>
</main></div></div>
${classicFooter(d.blog, d.footerExtra)}
</div>`,
    };
  },
};

export const CONTRACT_BUILDERS = { 'blog-webcli-v1': v1, 'wordpress-classic': classic };
export const DEFAULT_CONTRACT = 'blog-webcli-v1';

// d: { blog, home, feed, logoUrl, footerExtra, hrefFor, entries, indexHtml? } for an index;
//    { blog, meta, bodyHtml, coverUrl, home, feed, logoUrl, footerExtra } for a post.
// `indexHtml` replaces the post list (the index:html hook's output).
export const indexBody = (contract, d) => (CONTRACT_BUILDERS[contract] || v1).index(d);
export const indexList = (contract, d) => (CONTRACT_BUILDERS[contract] || v1).list(d);
export const postBody = (contract, d) => (CONTRACT_BUILDERS[contract] || v1).post(d);

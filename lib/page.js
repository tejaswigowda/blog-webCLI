// Page, index and feed templates. Pure functions of (blog, post, resolved URLs).
import { escapeHtml as h } from './html.js';
import { themeCss } from './customize.js';

export const GENERATOR = 'blog-webcli';
const APP = 'https://blog.webcli.app';

const meta = (attrs) => `<meta ${Object.entries(attrs).map(([k, v]) => `${k}="${h(v)}"`).join(' ')}>`;

function head({ blog, title, ogTitle = title, description, url, image, type, published, rootHref }) {
  const tags = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${h(title)}</title>`,
    meta({ name: 'description', content: description }),
    meta({ name: 'generator', content: GENERATOR }),
    `<link rel="canonical" href="${h(url)}">`,
    `<link rel="alternate" type="application/atom+xml" title="${h(blog.title)}" href="${h(rootHref)}feed.xml">`,
    meta({ property: 'og:type', content: type }),
    meta({ property: 'og:site_name', content: blog.title }),
    meta({ property: 'og:title', content: ogTitle }),
    meta({ property: 'og:description', content: description }),
    meta({ property: 'og:url', content: url }),
  ];
  if (image) tags.push(meta({ property: 'og:image', content: image }));
  if (published) tags.push(meta({ property: 'article:published_time', content: published }));
  tags.push(
    meta({ name: 'twitter:card', content: image ? 'summary_large_image' : 'summary' }),
    meta({ name: 'twitter:title', content: ogTitle }),
    meta({ name: 'twitter:description', content: description }),
  );
  if (image) tags.push(meta({ name: 'twitter:image', content: image }));
  tags.push(`<style>${themeCss(blog)}</style>`);
  return tags.join('\n');
}

// ---- chrome shared by the generated pages and the /blog/ reader ----

const custom = (blog) => blog.customize || {};

// opts: { home, feed, logoUrl } — hrefs differ between a static page and the reader.
export function siteHeader(blog, { home, feed, logoUrl = null }) {
  const c = custom(blog).header || {};
  const titleHidden = c.showTitle === false && logoUrl;
  const logo = logoUrl ? `<img class="logo" src="${h(logoUrl)}" alt="${titleHidden ? h(blog.title) : ''}">` : '';
  const links = (c.links || []).map((l) => `<a href="${h(l.url)}" rel="noopener noreferrer">${h(l.label)}</a>`).join('');
  return `<header class="site"><a class="brand" href="${h(home)}">${logo}${titleHidden ? '' : h(blog.title)}</a><nav>${links}<a href="${h(feed)}">Feed</a></nav></header>`;
}

export function siteFooter(blog, extra = '') {
  const f = custom(blog).footer || {};
  const links = (f.links || []).map((l) => `<a href="${h(l.url)}" rel="noopener noreferrer">${h(l.label)}</a>`);
  const text = f.text ? h(f.text) : blog.author ? h(blog.author) : '';
  return `<footer class="site">${[extra, text, ...links].filter(Boolean).join(' · ')}</footer>`;
}

export function postList(entries, blog, hrefFor) {
  const l = { layout: 'list', excerpts: true, dates: true, tags: true, ...custom(blog).list };
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

export function postArticle({ blog, meta: m, bodyHtml, coverUrl }) {
  const tags = (m.tags || []).map((t) => `<span class="tag">#${h(t)}</span>`).join('');
  const author = m.author || blog.author;
  return `<article>
<h1>${h(m.title)}</h1>
<div class="meta"><time datetime="${h(m.date)}">${h(m.date)}</time>${author ? ` · ${h(author)}` : ''}${tags}</div>
${coverUrl ? `<p class="cover"><img src="${h(coverUrl)}" alt=""></p>\n` : ''}${bodyHtml}
</article>`;
}

export function postPage({ blog, post, bodyHtml, url, image, coverUrl, logoUrl = null }) {
  const m = post.meta;
  const edit = blog.repo
    ? `<a href="${APP}/#repo=${encodeURIComponent(blog.repo).replace(/%2F/g, '/')}&amp;post=${h(m.slug)}" rel="nofollow">Suggest a correction</a>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
${head({ blog, title: `${m.title} · ${blog.title}`, ogTitle: m.title, description: post.description, url, image, type: 'article', published: m.date, rootHref: '../' })}
</head>
<body>
<div class="wrap">
${siteHeader(blog, { home: '../', feed: '../feed.xml', logoUrl })}
${postArticle({ blog, meta: m, bodyHtml, coverUrl })}
${siteFooter(blog, edit)}
</div>
</body>
</html>
`;
}

export function indexPage({ blog, entries, url, image, logoUrl = null }) {
  return `<!doctype html>
<html lang="en">
<head>
${head({ blog, title: blog.title, description: blog.description, url, image, type: 'website', rootHref: './' })}
</head>
<body>
<div class="wrap">
${siteHeader(blog, { home: './', feed: './feed.xml', logoUrl })}
<h1>${h(blog.title)}</h1>
<p class="meta">${h(blog.description)}</p>
${postList(entries, blog, (slug) => `${slug}/`)}
${siteFooter(blog)}
</div>
</body>
</html>
`;
}

// Atom 1.0. Deterministic: timestamps come from authored post dates only.
export function atomFeed({ blog, entries, base }) {
  const iso = (d) => `${d}T00:00:00Z`;
  const updated = entries.length ? iso(entries[0].date) : '1970-01-01T00:00:00Z';
  const x = h;
  const items = entries
    .map(
      (e) => `  <entry>
    <id>${x(base)}/${x(e.slug)}/</id>
    <title>${x(e.title)}</title>
    <link rel="alternate" type="text/html" href="${x(base)}/${x(e.slug)}/"/>
    <published>${iso(e.date)}</published>
    <updated>${iso(e.date)}</updated>
    <author><name>${x(e.author)}</name></author>
${e.tags.map((t) => `    <category term="${x(t)}"/>`).join('\n')}${e.tags.length ? '\n' : ''}    <summary>${x(e.excerpt)}</summary>
    <content type="html">${x(e.html)}</content>
  </entry>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${x(base)}/</id>
  <title>${x(blog.title)}</title>
  <subtitle>${x(blog.description)}</subtitle>
  <updated>${updated}</updated>
  <link rel="alternate" type="text/html" href="${x(base)}/"/>
  <link rel="self" type="application/atom+xml" href="${x(base)}/feed.xml"/>
  <author><name>${x(blog.author)}</name></author>
  <generator>${GENERATOR}</generator>
${items}
</feed>
`;
}

// Page, index and feed templates. Pure functions of (blog, post, resolved URLs).
import { escapeHtml as h } from './html.js';
import { DEFAULT_CONTRACT, indexBody, postBody } from './contracts.js';

export const GENERATOR = 'blog-webcli';
const APP = 'https://blog.webcli.app';

const meta = (attrs) => `<meta ${Object.entries(attrs).map(([k, v]) => `${k}="${h(v)}"`).join(' ')}>`;

function head({ blog, title, ogTitle = title, description, url, image, type, published, rootHref, css, comment = '' }) {
  const tags = [
    '<meta charset="utf-8">',
    ...(comment ? [comment] : []),
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
  tags.push(`<style>${css}</style>`);
  return tags.join('\n');
}

// ---- pages: the <head> is built here, the <body> by the theme's markup contract ----

const bodyOpen = (b) => (b.bodyClass ? `<body class="${h(b.bodyClass)}">` : '<body>');

export function postPage({ blog, post, bodyHtml, url, image, coverUrl, logoUrl = null, contract = DEFAULT_CONTRACT, css, comment = '' }) {
  const m = post.meta;
  const edit = blog.repo
    ? `<a href="${APP}/#repo=${encodeURIComponent(blog.repo).replace(/%2F/g, '/')}&amp;post=${h(m.slug)}" rel="nofollow">Suggest a correction</a>`
    : '';
  const body = postBody(contract, { blog, meta: m, bodyHtml, coverUrl, home: '../', feed: '../feed.xml', logoUrl, footerExtra: edit });
  return `<!doctype html>
<html lang="en">
<head>
${head({ blog, title: `${m.title} · ${blog.title}`, ogTitle: m.title, description: post.description, url, image, type: 'article', published: m.date, rootHref: '../', css, comment })}
</head>
${bodyOpen(body)}
${body.html}
</body>
</html>
`;
}

// `indexHtml` is the (hook-processed) post list; when absent the contract builds it from `entries`.
export function indexPage({ blog, entries, url, image, logoUrl = null, contract = DEFAULT_CONTRACT, css, comment = '', indexHtml }) {
  const body = indexBody(contract, { blog, entries, hrefFor: (slug) => `${slug}/`, home: './', feed: './feed.xml', logoUrl, indexHtml });
  return `<!doctype html>
<html lang="en">
<head>
${head({ blog, title: blog.title, description: blog.description, url, image, type: 'website', rootHref: './', css, comment })}
</head>
${bodyOpen(body)}
${body.html}
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

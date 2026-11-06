// Page, index and feed templates. Pure functions of (blog, post, resolved URLs).
import { escapeHtml as h } from './html.js';
import { DEFAULT_CONTRACT, indexBody, postBody } from './contracts.js';
import { VERSION } from './version.js';

export const GENERATOR = 'blog-webcli';
export const GENERATOR_ID = `${GENERATOR}@${VERSION}`;
export const LIVE_FILE = 'webcli-live.js';
const APP = 'https://blog.webcli.app';

const meta = (attrs) => `<meta ${Object.entries(attrs).map(([k, v]) => `${k}="${h(v)}"`).join(' ')}>`;

// What the page was built from, for the page's own script: the generator that wrote it, the digest of the
// markdown it shows, and where the live copy of the blog can be read (see lib/content.js). There is no
// commit id: the page is committed together with its source, so the commit that holds it cannot be named in it.
function provenance({ sourceSha, live }) {
  return [
    meta({ name: 'x-generator', content: GENERATOR_ID }),
    ...(sourceSha ? [meta({ name: 'x-content-sha256', content: sourceSha })] : []),
    ...(live
      ? [
          meta({ name: 'x-content-base', content: live.base }),
          meta({ name: 'x-webcli-page', content: live.kind }),
          ...(live.slug ? [meta({ name: 'x-webcli-slug', content: live.slug })] : []),
          ...(live.root !== undefined ? [meta({ name: 'x-webcli-root', content: live.root })] : []),
        ]
      : []),
  ];
}

const liveScript = (live) => (live ? `<script type="module" src="${h(live.src)}"></script>\n` : '');

function head({ blog, title, ogTitle = title, description, url, image, type, published, rootHref, css, comment = '', sourceSha = null, live = null, robots = null, nav = null }) {
  const tags = [
    '<meta charset="utf-8">',
    ...(comment ? [comment] : []),
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${h(title)}</title>`,
    meta({ name: 'description', content: description }),
    meta({ name: 'generator', content: GENERATOR }),
    ...provenance({ sourceSha, live }),
    ...(robots ? [meta({ name: 'robots', content: robots })] : []),
    `<link rel="canonical" href="${h(url)}">`,
    ...(nav && nav.prev ? [`<link rel="prev" href="${h(nav.prev.href)}">`] : []),
    ...(nav && nav.next ? [`<link rel="next" href="${h(nav.next.href)}">`] : []),
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

export function postPage({ blog, post, bodyHtml, url, image, coverUrl, logoUrl = null, contract = DEFAULT_CONTRACT, css, comment = '', sourceSha = null, live = null, nav = null }) {
  const m = post.meta;
  const edit = blog.repo
    ? `<a href="${APP}/#repo=${encodeURIComponent(blog.repo).replace(/%2F/g, '/')}&amp;post=${h(m.slug)}" rel="nofollow">Suggest a correction</a>`
    : '';
  const body = postBody(contract, { blog, meta: m, bodyHtml, coverUrl, home: '../', feed: '../feed.xml', logoUrl, footerExtra: edit, nav });
  return `<!doctype html>
<html lang="en">
<head>
${head({ blog, title: `${m.title} · ${blog.title}`, ogTitle: m.title, description: post.description, url, image, type: 'article', published: m.date, rootHref: '../', css, comment, sourceSha, live, nav })}
</head>
${bodyOpen(body)}
${body.html}
${liveScript(live)}</body>
</html>
`;
}

// `indexHtml` is the (hook-processed) post list; when absent the contract builds it from `entries`.
export function indexPage({ blog, entries, url, image, logoUrl = null, contract = DEFAULT_CONTRACT, css, comment = '', indexHtml, live = null }) {
  const body = indexBody(contract, { blog, entries, hrefFor: (slug) => `${slug}/`, home: './', feed: './feed.xml', logoUrl, indexHtml });
  return `<!doctype html>
<html lang="en">
<head>
${head({ blog, title: blog.title, description: blog.description, url, image, type: 'website', rootHref: './', css, comment, live })}
</head>
${bodyOpen(body)}
${body.html}
${liveScript(live)}</body>
</html>
`;
}

// 404.html: GitHub Pages serves it, with a 404 status, for any path the site does not have. Its script looks for
// a post published a moment ago whose page is not built yet (lib/live.js); when there is none this is the
// not-found page. Links are root-relative because the same file answers at any depth.
export function notFoundPage({ blog, base, logoUrl = null, contract = DEFAULT_CONTRACT, css, comment = '', live = null }) {
  const root = `${base}/`;
  const body = indexBody(contract, {
    blog,
    entries: [],
    hrefFor: (slug) => `${root}${slug}/`,
    home: root,
    feed: `${root}feed.xml`,
    logoUrl,
    indexHtml: `<div data-webcli-notfound><h2>Page not found</h2>\n<p>There is nothing at this address. <a href="${h(root)}">Back to ${h(blog.title)}</a></p></div>`,
  });
  return `<!doctype html>
<html lang="en">
<head>
${head({ blog, title: `Page not found · ${blog.title}`, description: blog.description, url: root, image: null, type: 'website', rootHref: root, css, comment, live, robots: 'noindex' })}
</head>
${bodyOpen(body)}
${body.html}
${liveScript(live)}</body>
</html>
`;
}

// Atom 1.0. Deterministic: timestamps come from authored post dates only.
export function atomFeed({ blog, entries, base }) {
  const iso = (d) => `${d}T00:00:00Z`;
  // the newest date, not the first entry's: a blog's order need not be by date (the feed's own order is document order; see the README)
  const updated = entries.length ? iso(entries.reduce((m, e) => (e.date > m ? e.date : m), entries[0].date)) : '1970-01-01T00:00:00Z';
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

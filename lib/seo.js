// Search-engine plumbing: sitemap.xml, robots.txt, JSON-LD and the blog.json "seo", "pagination" and "search"
// settings. Pure: timestamps are authored post dates, never the clock, so the output is reproducible.
import { Refusal } from './errors.js';
import { escapeHtml as h } from './html.js';
import { validateDateFormat } from './datefmt.js';

const bad = (m) => new Refusal('bad-blog-json', m);

export function validateSeo(b) {
  if (b.seo !== undefined) {
    const s = b.seo;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw bad('seo: must be an object');
    for (const k of Object.keys(s)) if (!['twitter', 'sitemap', 'robots', 'noindex'].includes(k)) throw bad(`seo: "${k}" is not a field (twitter, sitemap, robots, noindex)`);
    if (s.twitter !== undefined && !(typeof s.twitter === 'string' && /^@[A-Za-z0-9_]{1,15}$/.test(s.twitter))) throw bad('seo.twitter must be a handle like @name');
    for (const k of ['sitemap', 'robots', 'noindex']) if (s[k] !== undefined && typeof s[k] !== 'boolean') throw bad(`seo.${k} must be true or false`);
  }
  if (b.pagination !== undefined) {
    const p = b.pagination;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad('pagination: must be an object like {"size": 10}');
    for (const k of Object.keys(p)) if (k !== 'size' && k !== 'stable') throw bad(`pagination: "${k}" is not a field (size, stable)`);
    if (p.stable !== undefined && typeof p.stable !== 'boolean') throw bad('pagination.stable must be true or false');
    if (!Number.isInteger(p.size) || p.size < 1 || p.size > 100) throw bad('pagination.size must be a whole number from 1 to 100 (leave pagination out for one long list)');
  }
  if (b.stylesheet !== undefined && b.stylesheet !== 'inline' && b.stylesheet !== 'linked') throw bad('stylesheet must be "inline" or "linked"');
  if (b.search !== undefined && typeof b.search !== 'boolean') throw bad('search must be true or false');
  if (b.dateFormat !== undefined) validateDateFormat(b.dateFormat);
}

export const paginationSize = (blog) => (blog.pagination && blog.pagination.size) || 0;
// Pages numbered from the oldest post, so that a new post changes the front page and no other (see pagesOf in lib/listings.js).
export const paginationStable = (blog) => !!(blog.pagination && blog.pagination.size && blog.pagination.stable === true);
// "linked": every page links one style.css instead of carrying the CSS, so a change of colours, fonts or custom CSS is one file, not every page.
export const STYLE_FILE = 'style.css';
export const stylesheetLinked = (blog) => blog.stylesheet === 'linked';
export const searchEnabled = (blog) => blog.search === true;
// seo.noindex: a copy that should not compete with the original (a demo): every page says noindex, and there is no sitemap to ask for it
export const sitemapEnabled = (blog) => !(blog.seo && (blog.seo.sitemap === false || blog.seo.noindex === true));
export const robotsEnabled = (blog) => sitemapEnabled(blog) && !(blog.seo && blog.seo.robots === false);

// JSON-LD sits inside a <script>: it is data, but it must never be able to end the element or the page.
export const ldScript = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}</script>`;

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)));

export function postLd({ blog, meta, url, image, description, words }) {
  const author = meta.author || blog.author;
  return ldScript(
    clean({
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: meta.title,
      description,
      datePublished: meta.date,
      dateModified: meta.date,
      author: author ? { '@type': 'Person', name: author } : undefined,
      publisher: { '@type': 'Organization', name: blog.title },
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      url,
      image: image || undefined,
      keywords: (meta.tags || []).join(', '),
      wordCount: words,
    }),
  );
}

export const pageLd = ({ blog, meta, url, image, description }) =>
  ldScript(clean({ '@context': 'https://schema.org', '@type': 'WebPage', name: meta.title, description, url, image: image || undefined, isPartOf: { '@type': 'WebSite', name: blog.title, url: `${blog.domain}/` } }));

export function siteLd({ blog, url, search }) {
  return ldScript(
    clean({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: blog.title,
      description: blog.description,
      url,
      publisher: { '@type': 'Organization', name: blog.title },
      potentialAction: search ? { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${blog.domain}/search/?q={search_term_string}` }, 'query-input': 'required name=search_term_string' } : undefined,
    }),
  );
}

// urls: [{ loc, lastmod? }] in the order they should be listed.
export function sitemapXml(urls) {
  const items = urls.map((u) => `  <url><loc>${h(u.loc)}</loc>${u.lastmod ? `<lastmod>${h(u.lastmod)}</lastmod>` : ''}</url>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</urlset>\n`;
}

// A sitemap of sitemaps (sitemaps.org's sitemapindex): robots.txt and search engines read it where they read a sitemap.
export function sitemapIndexXml(locs) {
  const items = locs.map((l) => `  <sitemap><loc>${h(l)}</loc></sitemap>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</sitemapindex>\n`;
}

// robots.txt is only read at the root of a host: a blog served from a folder of one has no say in it.
export const robotsTxt = (blog) => `User-agent: *\nAllow: /\n\nSitemap: ${blog.domain}/sitemap.xml\n`;

// The pages the generator makes out of the posts besides the posts themselves: the pages of the index, one page
// per tag and (with more than one author) per author, the archive, the tag list, the search page. Pure, and
// deterministic: every list is in the blog's own order or in an order fixed here, never in the order things
// happened to be read.
import { escapeHtml as h } from './html.js';
import { indexList } from './contracts.js';
import { listingPage, SEARCH_FILE } from './page.js';
import { ARCHIVE_DIR, AUTHORS_DIR, PAGE_DIR, SEARCH_DIR, TAGS_DIR } from './site-model.js';
import { byYear, groupAuthors, paginate } from './taxonomy.js';

const up = (depth) => (depth ? '../'.repeat(depth) : './');

// Where each page of a paginated list lives, and the previous and next page it links to.
//   dir: the folder the first page is in ('' for the index, 'tags/video' for a tag)
export function pagesOf(entries, size, dir) {
  const chunks = paginate(entries, size);
  const base = dir ? dir.split('/').length : 0;
  return chunks.map((chunk, i) => {
    const n = i + 1;
    const depth = base + (n > 1 ? 2 : 0);
    const prev = n === 1 ? null : { href: n === 2 ? '../../' : `../${n - 1}/` };
    const next = n === chunks.length ? null : { href: n === 1 ? `${PAGE_DIR}/2/` : `../${n + 1}/` };
    return { n, of: chunks.length, entries: chunk, path: `${dir ? `${dir}/` : ''}${n > 1 ? `${PAGE_DIR}/${n}/` : ''}index.html`, home: up(depth), nav: { prev, next } };
  });
}

// "Previous page · Page 2 of 5 · Next page". Absent, not disabled, at either end; nothing at all for one page.
export function pagerHtml(p) {
  if (p.of < 2) return '';
  const a = (rel, href, label) => `<a rel="${rel}" href="${h(href)}">${label}</a>`;
  return `<nav class="pagination navigation" aria-label="Pages">${p.nav.prev ? a('prev', p.nav.prev.href, '← Previous page') : ''}<span class="page-of">Page ${p.n} of ${p.of}</span>${p.nav.next ? a('next', p.nav.next.href, 'Next page →') : ''}</nav>`;
}

const noun = (n) => `${n} post${n === 1 ? '' : 's'}`;

// The addresses worth a search engine's time, in a fixed order: the home page, the posts in the blog's order, the
// pages, the archive, the tags, the authors. A post that asks not to be indexed (noindex), or says it was first
// published elsewhere (a canonical address that is not its own), is left out. `metas`: slug -> frontmatter.
export function sitemapUrls({ blog, entries, pages, metas, site }) {
  const root = blog.domain;
  const wanted = (slug) => {
    const m = metas.get(slug) || {};
    return m.noindex !== 'true' && (!m.canonical || m.canonical === `${root}/${slug}/`);
  };
  const newest = (es) => es.reduce((d, e) => (e.date > d ? e.date : d), '');
  const urls = [{ loc: `${root}/`, ...(entries.length ? { lastmod: newest(entries) } : {}) }];
  for (const e of entries) if (wanted(e.slug)) urls.push({ loc: `${root}/${e.slug}/`, lastmod: e.date });
  for (const p of [...pages].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))) {
    const m = metas.get(p.slug) || {};
    if (wanted(p.slug)) urls.push({ loc: `${root}/${p.slug}/`, ...(m.date ? { lastmod: m.date } : {}) });
  }
  if (entries.length) urls.push({ loc: `${root}/${ARCHIVE_DIR}/` });
  if (site.tags.length) {
    urls.push({ loc: `${root}/${TAGS_DIR}/` });
    for (const t of site.tags) urls.push({ loc: `${root}/${TAGS_DIR}/${t.slug}/`, lastmod: newest(t.entries) });
  }
  if (site.authors) for (const a of groupAuthors(entries)) urls.push({ loc: `${root}/${AUTHORS_DIR}/${a.slug}/`, lastmod: newest(a.entries) });
  return urls;
}

// ctx: { blog, contract, css, comment, logoUrl, site, entries (published posts, in the blog's order) }
export function buildListings(ctx) {
  const { blog, contract, entries, site } = ctx;
  const root = ctx.blog.domain;
  const common = { blog, contract, css: ctx.css, comment: ctx.comment, logoUrl: ctx.logoUrl, site };
  const files = {};
  const list = (es, home) => indexList(contract, { blog, entries: es, hrefFor: (slug) => `${home}${slug}/`, tagHref: (t) => `${home}${site.tagPath(t)}` });

  // a list of posts under `dir`, one file per page
  const paged = ({ dir, entries: es, size, title, heading, intro, description }) => {
    const out = pagesOf(es, size, dir);
    for (const p of out) {
      const label = p.of > 1 ? `${title} (page ${p.n})` : title;
      files[p.path] = listingPage({
        ...common,
        title: label,
        heading,
        intro: p.of > 1 ? `${intro ? `${intro} · ` : ''}page ${p.n} of ${p.of}` : intro,
        description,
        url: `${root}/${dir ? `${dir}/` : ''}${p.n > 1 ? `${PAGE_DIR}/${p.n}/` : ''}`,
        home: p.home,
        indexHtml: `${list(p.entries, p.home)}${p.of > 1 ? `\n${pagerHtml(p)}` : ''}`,
        nav: p.nav,
      });
    }
    return out;
  };

  const size = ctx.size || 0;

  // tags
  if (site.tags.length) {
    for (const t of site.tags) {
      paged({ dir: `${TAGS_DIR}/${t.slug}`, entries: t.entries, size, title: `Posts tagged ${t.label}`, heading: `Tagged “${t.label}”`, intro: noun(t.entries.length) });
    }
    const items = site.tags.map((t) => `<li><a href="${h(t.slug)}/">${h(t.label)}</a> <span class="count">(${t.entries.length})</span></li>`).join('\n');
    files[`${TAGS_DIR}/index.html`] = listingPage({ ...common, title: 'Tags', heading: 'Tags', url: `${root}/${TAGS_DIR}/`, home: '../', indexHtml: `<ul class="tag-list">\n${items}\n</ul>` });
  }

  // authors: only where there is more than one
  if (site.authors) {
    for (const a of groupAuthors(entries)) {
      paged({ dir: `${AUTHORS_DIR}/${a.slug}`, entries: a.entries, size, title: `Posts by ${a.label}`, heading: a.label, intro: noun(a.entries.length) });
    }
  }

  // the archive: every post by year, newest first, whatever order the blog itself is in
  if (entries.length) {
    const years = byYear(entries)
      .map((y) => `<h2 id="y${h(y.year)}">${h(y.year)}</h2>\n<ul class="archive">\n${y.entries.map((e) => `<li><time datetime="${h(e.date)}">${h(e.date)}</time> <a href="../${h(e.slug)}/">${h(e.title)}</a></li>`).join('\n')}\n</ul>`)
      .join('\n');
    files[`${ARCHIVE_DIR}/index.html`] = listingPage({ ...common, title: 'Archive', heading: 'Archive', intro: noun(entries.length), url: `${root}/${ARCHIVE_DIR}/`, home: '../', indexHtml: years });
  }

  // search: a form, and the script that runs it (see lib/search-client.js). Without scripting it says so.
  if (ctx.search) {
    files[`${SEARCH_DIR}/index.html`] = listingPage({
      ...common,
      title: 'Search',
      heading: 'Search',
      url: `${root}/${SEARCH_DIR}/`,
      home: '../',
      script: `../${SEARCH_FILE}`,
      robots: 'noindex',
      indexHtml: `<div data-webcli-search>\n<form role="search"><input type="search" name="q" placeholder="Search posts" aria-label="Search posts" autocomplete="off"> <button type="submit">Search</button></form>\n<p data-status role="status"></p>\n<ul class="posts search-results" data-results></ul>\n<p data-nojs>Search needs JavaScript. You can browse every post in the <a href="../${ARCHIVE_DIR}/">archive</a>.</p>\n</div>`,
    });
  }
  return files;
}

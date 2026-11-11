// What can be said about a post before it is edited, from things already read: the post itself, the blog's index and lock file.
// Pure. (The two things that need a request, the post's history and whether the live page is this version, are summarised by
// summariseHistory and compareLive from what the app fetched.)
import { excerpt, plainLines, wordCount } from './html.js';
import { parseAliases } from './aliases.js';
import { sizeIn } from './image-size.js';
import { addrOf } from './permalink.js';
import { relatedCount, relatedFor } from './related.js';
import { sitemapEnabled } from './seo.js';
import { lockKey } from './assets.js';
import { sha256 } from './sha256.js';

const WORDS_PER_MINUTE = 200;
const TITLE_MAX = 60;
const DESC_MIN = 50;
const DESC_MAX = 160;
const INTERNAL = /^\.\.\/([^/?#]+)\/?(?:#.*)?$/;

// ops: the post's Delta; f: the fields as the form has them ({ title, slug, date, status, tags, description, seo_title, image, canonical,
// noindex, cover, aliases }); index: { posts, pages, sequence }; staged: lock keys of pictures chosen but not uploaded yet.
export function postStats({ ops, f, blog, index = { posts: [], pages: [], sequence: [] }, lock = {}, staged = new Set(), kind = 'post' }) {
  const delta = { ops };
  const words = wordCount(delta);
  const lines = plainLines(delta);
  const headings = lines.filter((l) => l.block && l.block.header && l.text).map((l) => ({ level: Number(l.block.header), text: l.text }));

  let images = 0;
  let noAlt = 0;
  let videos = 0;
  let tables = 0;
  let htmlBlocks = 0;
  const links = { internal: 0, external: 0 };
  const hrefs = [];
  const pictures = { total: 0, sized: 0 };
  const unpinned = [];
  for (const op of ops) {
    const ins = op.insert;
    if (ins && typeof ins === 'object') {
      if (ins.image) {
        images++;
        if (!(op.attributes && op.attributes.alt)) noAlt++;
        if (String(ins.image).startsWith('asset:')) {
          const key = lockKey(ins.image);
          pictures.total++;
          if (sizeIn(lock, key)) pictures.sized++;
          if (!lock[key] && !staged.has(key)) unpinned.push(ins.image);
        }
      } else if (ins.video) videos++;
      else if (ins.mdtable) tables++;
      else if (ins.htmlblock) htmlBlocks++;
    }
    const href = op.attributes && op.attributes.link;
    if (href) {
      hrefs.push(href);
      if (INTERNAL.test(href) || !/^[a-z][a-z0-9+.-]*:/i.test(href)) links.internal++;
      else links.external++;
    }
  }
  let codeBlocks = 0;
  let inCode = false;
  for (const l of lines) {
    const isCode = !!(l.block && l.block['code-block'] !== undefined);
    if (isCode && !inCode) codeBlocks++;
    inCode = isCode;
  }

  const known = new Set([...index.posts.map((e) => e.slug), ...(index.pages || []).map((p) => p.slug), f.slug].filter(Boolean));
  const broken = [...new Set(hrefs.filter((h) => INTERNAL.test(h) && !known.has(INTERNAL.exec(h)[1])))];

  const published = f.status === 'published';
  let addr = f.slug || '';
  try {
    if (kind !== 'page' && f.slug && f.date) addr = addrOf(blog, { slug: f.slug, date: f.date });
  } catch {
    /* a date that is not one yet: the slug alone */
  }
  const url = f.slug ? `${blog.domain}/${addr}/` : '';
  let aliases = [];
  try {
    aliases = parseAliases({ aliases: f.aliases }, 'aliases');
  } catch {
    /* shown as typed elsewhere */
  }

  const title = f.seo_title || `${f.title || ''} · ${blog.title}`;
  const autoDescription = !f.description;
  const description = f.description || excerpt(delta);
  const hasImage = !!(f.image || (f.cover && f.cover !== 'auto') || (f.cover === 'auto' && (images || videos)) || blog.cover);

  const list = index.posts;
  const at = list.findIndex((e) => e.slug === f.slug);
  const neighbours = at < 0 ? null : { newer: list[at - 1] || null, older: list[at + 1] || null };
  const entries = list.map((e) => (e.slug === f.slug ? { ...e, tags: f.tags || [] } : e));
  if (at < 0 && f.slug && published) entries.push({ slug: f.slug, title: f.title, tags: f.tags || [] });
  const sequence = index.sequence && index.sequence.length ? index.sequence : entries.map((e) => e.slug);
  const related = kind === 'page' || !relatedCount(blog) ? [] : relatedFor(entries, sequence, f.slug, relatedCount(blog));

  return {
    words,
    minutes: words ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : 0,
    headings,
    extraH1: headings.filter((h) => h.level === 1).length,
    counts: { images, videos, tables, htmlBlocks, codeBlocks, links },
    imagesWithoutAlt: noAlt,
    pictures,
    unpinned,
    brokenLinks: broken,
    seo: {
      title: { length: title.length, state: !f.title && !f.seo_title ? 'missing' : title.length > TITLE_MAX ? 'long' : 'ok' },
      description: { length: description.length, auto: autoDescription, state: !description ? 'missing' : description.length < DESC_MIN ? 'short' : description.length > DESC_MAX ? 'long' : 'ok' },
      shareImage: hasImage,
      noindex: !!f.noindex,
      canonical: f.canonical || '',
      inSitemap: published && !f.noindex && (!f.canonical || f.canonical === url) && sitemapEnabled(blog),
    },
    address: { url, path: addr, aliases },
    neighbours,
    related,
    comments: (list[at] && list[at].comments) || 0,
  };
}

// commits: GitHub's list for a path, newest first. -> { count, more, first, last, authors }
export function summariseHistory(commits, limit = 100) {
  if (!Array.isArray(commits) || !commits.length) return { count: 0, more: false, first: null, last: null, authors: [] };
  const who = (c) => (c.author && c.author.login) || (c.commit && c.commit.author && c.commit.author.name) || 'unknown';
  const when = (c) => (c.commit && c.commit.author && c.commit.author.date) || '';
  return {
    count: commits.length,
    more: commits.length >= limit,
    first: { date: when(commits[commits.length - 1]), by: who(commits[commits.length - 1]) },
    last: { date: when(commits[0]), by: who(commits[0]), message: ((commits[0].commit && commits[0].commit.message) || '').split('\n')[0] },
    authors: [...new Set(commits.map(who))],
  };
}

const HASH = /<meta name="x-content-sha256" content="([0-9a-f]{64})"/;

// The live page against the source as saved: 'live' (the page was built from exactly this text), 'stale' (from other text: a build is
// pending, or failed), 'missing' (no page at the address), 'unknown' (a page with no hash, or not readable).
export function compareLive({ status, html }, sourceText) {
  if (status === 404) return { state: 'missing', bytes: 0 };
  if (!(status >= 200 && status < 300) || typeof html !== 'string') return { state: 'unknown', bytes: 0 };
  const bytes = new TextEncoder().encode(html).length;
  const m = HASH.exec(html);
  if (!m) return { state: 'unknown', bytes };
  return { state: m[1] === sha256(sourceText) ? 'live' : 'stale', bytes };
}


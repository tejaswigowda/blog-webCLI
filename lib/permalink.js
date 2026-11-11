// Where a post lives. By default at /<slug>/. A blog that came from a WordPress site with dated addresses can keep them: blog.json
//   "permalink": "/{year}/{month}/{slug}/"
// emits each post at its old path, which is better than a redirect. The slug stays the post's id (posts/<slug>.md, its comments
// file, the reserved names, slug-collision); only the path is derived. A path that depends on `date` must not move when the date is
// edited, so planChange refuses that (permalink-move).
import { Refusal } from './errors.js';

export const DEFAULT_PERMALINK = '/{slug}/';
const TOKENS = new Set(['slug', 'year', 'month', 'day']);
const bad = (detail) => new Refusal('unsupported-permalink', detail);

export function validatePermalink(b) {
  if (b.permalink === undefined) return;
  const p = b.permalink;
  if (typeof p !== 'string' || !p.startsWith('/') || !p.endsWith('/') || p.length > 100) throw bad('permalink must be a path like "/{slug}/" or "/{year}/{month}/{slug}/"');
  for (const m of p.matchAll(/\{([^}]*)\}/g)) {
    if (m[1] === 'category') throw bad('permalink: {category} cannot be reproduced (a post here has tags, not one category); keep "/{slug}/" and the old category addresses become alias stubs');
    if (!TOKENS.has(m[1])) throw bad(`permalink: {${m[1]}} is not a field (slug, year, month, day)`);
  }
  const segments = p.split('/').slice(1, -1);
  if (!segments.length || segments.length > 4) throw bad('permalink: one to four path segments');
  if (segments[segments.length - 1] !== '{slug}' || segments.filter((s) => s.includes('{slug}')).length !== 1) throw bad('permalink: the last segment must be {slug}, and {slug} appears once');
  for (const t of TOKENS) if (p.split(`{${t}}`).length > 2) throw bad(`permalink: {${t}} appears more than once`);
  for (const s of segments) if (!/^(?:\{(?:slug|year|month|day)\}|[a-z0-9][a-z0-9_-]*)$/.test(s)) throw bad(`permalink: "${s}" is not a segment (a token, or lower-case letters, digits, - and _)`);
}

export const permalinkOf = (blog) => blog.permalink || DEFAULT_PERMALINK;
export const isDated = (blog) => permalinkOf(blog) !== DEFAULT_PERMALINK;

// "2024/05/hello" for a post dated 2024-05-17 under "/{year}/{month}/{slug}/"
export function addrOf(blog, { slug, date }) {
  const p = permalinkOf(blog);
  if (p === DEFAULT_PERMALINK) return slug;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
  if (!m) throw bad(`the permalink uses the date, and "${date}" is not one`);
  return p.slice(1, -1).replace('{year}', m[1]).replace('{month}', m[2]).replace('{day}', m[3]).replace('{slug}', slug);
}

// the entry's address: recorded in the index when it differs from the slug
export const addrOfEntry = (e) => e.path || e.slug;

// "../" for each segment of a page's own address: the way back to the blog's root
export const upFrom = (addr) => '../'.repeat(addr.split('/').length);

// the link from the page at `from` to the page at `to` (both addresses, no slashes at the ends)
export function relativeLink(from, to) {
  const a = from.split('/');
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `${'../'.repeat(a.length - i)}${b.slice(i).join('/')}/`;
}

// would an edit that changes the date move the post's address?
export const movesWithDate = (blog, slug, oldDate, newDate) => isDated(blog) && addrOf(blog, { slug, date: oldDate }) !== addrOf(blog, { slug, date: newDate });

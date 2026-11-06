// Post ordering. The order is a property of the blog, set in blog.json; reverse-chronological is only the
// default. One module decides it, so the index, prev/next and the feed can never disagree, and the browser
// does not sort anything for itself: it reads the sequence this produces (index/posts.json).
//
//   "order": { "by": "date", "dir": "desc" }                                   the default
//   "order": { "by": "manual", "list": "order.json", "unlisted": "append-by-date" }
//   "order": { "by": "frontmatter:episode", "dir": "asc" }
//   "order": { "by": "title", "dir": "asc" }
//
// The tiebreak is the slug, always ascending, in every mode, and it is not configurable: two posts that tie
// must come out in the same order on every run and every machine, or CI's regenerate-and-diff fails for a
// reason that looks like a generator bug. Nothing here is locale-sensitive for the same reason.
import { Refusal } from './errors.js';
import { SLUG_RE } from './frontmatter.js';

export const ORDER_FILE = 'order.json';
export const DEFAULT_ORDER = Object.freeze({ by: 'date', dir: 'desc' });
const FIELD = /^[A-Za-z][\w-]*$/;
const LIST_FILE = /^[A-Za-z0-9][\w.-]*\.json$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;

const bad = (m) => new Refusal('bad-blog-json', `order: ${m}`);

// What blog.json said (or the default), with every default filled in, so the index can record exactly the
// configuration that produced the sequence.
export function resolveOrder(blog) {
  const o = blog && blog.order;
  if (!o) return { ...DEFAULT_ORDER };
  if (o.by === 'manual') return { by: 'manual', list: o.list || ORDER_FILE, unlisted: o.unlisted || 'append-by-date' };
  return { by: o.by, dir: o.dir || (o.by === 'date' ? 'desc' : 'asc') };
}

export function validateOrder(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad('must be an object');
  if ('tiebreak' in o) throw bad('"tiebreak" is not configurable: it is always the slug, so that regenerating is deterministic');
  for (const k of Object.keys(o)) if (!['by', 'dir', 'list', 'unlisted'].includes(k)) throw bad(`"${k}" is not a field (by, dir, list, unlisted)`);
  const manual = o.by === 'manual';
  const field = typeof o.by === 'string' && o.by.startsWith('frontmatter:');
  if (!(o.by === 'date' || o.by === 'title' || manual || (field && FIELD.test(o.by.slice('frontmatter:'.length))))) {
    throw bad('"by" must be date, title, manual, or frontmatter:<field>');
  }
  if (manual) {
    if (o.dir !== undefined) throw bad('a manual order has no direction: the list is the order');
    if (o.list !== undefined && !(typeof o.list === 'string' && LIST_FILE.test(o.list))) throw bad('"list" must be the name of a .json file at the top of the blog, like order.json');
    if (o.unlisted !== undefined && o.unlisted !== 'append-by-date') throw bad('"unlisted" can only be append-by-date');
  } else {
    if (o.list !== undefined || o.unlisted !== undefined) throw bad('"list" and "unlisted" belong to a manual order');
    if (o.dir !== undefined && o.dir !== 'asc' && o.dir !== 'desc') throw bad('"dir" must be asc or desc');
  }
  return o;
}

// order.json: { "order": ["intro", "shapes", …] }. Drafts may be in it (sequencing unpublished material is the
// normal case for a course); the generated sequence is this list filtered to what is published.
export function parseOrderList(text, where = ORDER_FILE) {
  if (typeof text !== 'string') throw new Refusal('bad-order-list', `${where} does not exist. Create it as {"order": []} and list your slugs in it.`, where);
  let o;
  try {
    o = JSON.parse(text);
  } catch (e) {
    throw new Refusal('bad-order-list', `${where} is not valid JSON (${e.message})`, where);
  }
  if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(o.order) || !o.order.every((s) => typeof s === 'string' && SLUG_RE.test(s))) {
    throw new Refusal('bad-order-list', `${where} must look like {"order": ["first-slug", "second-slug"]}, every entry a slug`, where);
  }
  return o.order;
}

// Plain code-unit comparison of normalised, lower-cased text, then the text as written: no locale, no ICU,
// so every machine agrees.
const fold = (s) => s.normalize('NFC').toLowerCase();
export function collate(a, b) {
  const x = fold(a);
  const y = fold(b);
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

const bySlug = (a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

// posts: the published, canonical posts ({ slug, path, meta }).
// files: every slug that has a posts/<slug>.md, drafts included (for the manual list's "unknown slug" check).
// list: the slugs of order.json, when the order is manual.
// -> { slugs, appended, errors }. errors are Refusals; slugs is [] when there are any.
export function sequenceOf({ order, posts, files = new Set(), list = null }) {
  const errors = [];
  const keyed = (cmp, dir) => (a, b) => (dir === 'desc' ? -1 : 1) * cmp(a, b) || bySlug(a, b);

  if (order.by === 'manual') {
    const seen = new Set();
    for (const s of list) {
      if (seen.has(s)) errors.push(new Refusal('duplicate-slug-in-order', `"${s}" appears more than once in ${order.list}`, order.list));
      seen.add(s);
      if (!files.has(s)) errors.push(new Refusal('unknown-slug-in-order', `"${s}" is in ${order.list} but there is no posts/${s}.md`, order.list));
    }
    if (errors.length) return { slugs: [], appended: [], errors };
    const published = new Map(posts.map((p) => [p.slug, p]));
    const listed = list.filter((s) => published.has(s));
    // a published post that is in no list is appended, oldest first, and reported: never dropped
    const appended = posts.filter((p) => !seen.has(p.slug)).sort((a, b) => (a.meta.date < b.meta.date ? -1 : a.meta.date > b.meta.date ? 1 : bySlug(a, b))).map((p) => p.slug);
    return { slugs: [...listed, ...appended], appended, errors };
  }

  if (order.by === 'date') return { slugs: [...posts].sort(keyed((a, b) => (a.meta.date < b.meta.date ? -1 : a.meta.date > b.meta.date ? 1 : 0), order.dir)).map((p) => p.slug), appended: [], errors };
  if (order.by === 'title') return { slugs: [...posts].sort(keyed((a, b) => collate(a.meta.title, b.meta.title), order.dir)).map((p) => p.slug), appended: [], errors };

  const field = order.by.slice('frontmatter:'.length);
  const values = new Map();
  for (const p of posts) {
    const v = p.meta[field];
    if (v === undefined || v === '') errors.push(new Refusal('missing-order-field', `"${p.slug}" has no "${field}", and the blog is ordered by it`, p.path));
    else if (typeof v !== 'string') errors.push(new Refusal('bad-order-field', `"${field}" in "${p.slug}" is a list; it must be a single value`, p.path));
    else values.set(p.slug, v);
  }
  if (errors.length) return { slugs: [], appended: [], errors };
  // numbers sort as numbers and text as text; a field that is some of each is refused, not coerced
  const numeric = posts.filter((p) => NUMBER.test(values.get(p.slug)));
  if (numeric.length && numeric.length !== posts.length) {
    const named = (list) => list.slice(0, 3).map((p) => `"${p.slug}" (${values.get(p.slug)})`).join(', ');
    const text = posts.filter((p) => !NUMBER.test(values.get(p.slug)));
    return { slugs: [], appended: [], errors: [new Refusal('mixed-order-field-types', `"${field}" is a number in ${named(numeric)}${numeric.length > 3 ? ' …' : ''} and text in ${named(text)}${text.length > 3 ? ' …' : ''}; use one kind`, numeric[0].path)] };
  }
  const cmp = numeric.length ? (a, b) => Number(values.get(a.slug)) - Number(values.get(b.slug)) : (a, b) => collate(values.get(a.slug), values.get(b.slug));
  return { slugs: [...posts].sort(keyed(cmp, order.dir)).map((p) => p.slug), appended: [], errors };
}

// The neighbours of a slug in a sequence, for prev/next navigation. `titles` maps slug -> title and `href`
// turns a slug into a link. The first post has no prev and the last no next: absent, never a dead link.
export function neighbours(slugs, slug, titles, href) {
  const i = slugs.indexOf(slug);
  if (i < 0) return null;
  const at = (j) => (j >= 0 && j < slugs.length ? { slug: slugs[j], title: titles.get(slugs[j]), href: href(slugs[j]) } : null);
  return { prev: at(i - 1), next: at(i + 1) };
}

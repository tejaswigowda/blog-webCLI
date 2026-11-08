// Related posts: the posts that share the most tags with this one. Opt-in (blog.json "related": { "count": 3 }), off when absent.
// The rank is a total order: shared tags (most first), then the post's place in the blog's resolved sequence, then slug. Every input
// is in index/posts.json, so the generator, the live renderer and the /blog/ reader compute the same block with the same code.
// A post therefore depends on every post that shares a tag with it: affectedBy() says exactly which pages one change rewrites.
import { Refusal } from './errors.js';
import { escapeHtml as h } from './html.js';

export const RELATED_MAX = 10;

export function validateRelated(b) {
  if (b.related === undefined) return;
  const r = b.related;
  const bad = (m) => new Refusal('bad-blog-json', m);
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw bad('related: must be an object like {"count": 3}');
  for (const k of Object.keys(r)) if (k !== 'count') throw bad(`related: "${k}" is not a field (count)`);
  if (!Number.isInteger(r.count) || r.count < 1 || r.count > RELATED_MAX) throw bad(`related.count must be a whole number from 1 to ${RELATED_MAX} (leave related out for none)`);
}

export const relatedCount = (blog) => (blog.related && blog.related.count) || 0;

// entries: [{ slug, title, tags }] (published posts only, so a draft or scheduled post is never a candidate); sequence: the resolved order.
// -> [{ slug, title }], at most `count`, never the post itself, never a post with no tag in common.
export function relatedFor(entries, sequence, slug, count) {
  const me = entries.find((e) => e.slug === slug);
  if (!me || !count) return [];
  const mine = new Set(me.tags || []);
  if (!mine.size) return [];
  const place = new Map(sequence.map((s, i) => [s, i]));
  const at = (s) => (place.has(s) ? place.get(s) : Infinity);
  return entries
    .filter((e) => e.slug !== slug)
    .map((e) => ({ slug: e.slug, title: e.title, shared: new Set((e.tags || []).filter((t) => mine.has(t))).size }))
    .filter((e) => e.shared > 0)
    .sort((a, b) => b.shared - a.shared || at(a.slug) - at(b.slug) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, count)
    .map(({ slug: s, title }) => ({ slug: s, title }));
}

export function relatedHtml(list) {
  if (!list || !list.length) return '';
  return `<aside class="related-posts">\n<h2>Related posts</h2>\n<ul>\n${list.map((r) => `<li><a href="../${h(r.slug)}/">${h(r.title)}</a></li>`).join('\n')}\n</ul>\n</aside>`;
}

const listKey = (l) => JSON.stringify(l.map((r) => [r.slug, r.title]));

// The posts whose related block differs between two states of the blog, because `slug` was added, changed or removed (either
// entries list may lack it). Only posts that share a tag with it (before or after), or that listed it, can differ.
export function affectedBy({ oldEntries, oldSequence, newEntries, newSequence, slug, count }) {
  if (!count) return [];
  const tags = new Set();
  for (const list of [oldEntries, newEntries]) for (const e of list) if (e.slug === slug) for (const t of e.tags || []) tags.add(t);
  const candidates = new Set();
  for (const list of [oldEntries, newEntries]) for (const e of list) if (e.slug !== slug && (e.tags || []).some((t) => tags.has(t))) candidates.add(e.slug);
  const inNew = new Set(newEntries.map((e) => e.slug));
  return [...candidates].filter((s) => inNew.has(s) && listKey(relatedFor(oldEntries, oldSequence, s, count)) !== listKey(relatedFor(newEntries, newSequence, s, count))).sort();
}

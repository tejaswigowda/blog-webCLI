// Grouping posts: by tag, by author, by year, and into pages. Pure and deterministic: the same posts give the
// same groups in the same order, whatever order they arrive in, so the generated pages never differ run to run.
import { sha256 } from './sha256.js';

// The URL form of a label: lowercase letters, digits and hyphens. A label with none of those (a tag written
// entirely in another script) falls back to a short digest, so it still has an address of its own.
export function slugify(label) {
  const s = String(label)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || `x-${sha256(String(label)).slice(0, 8)}`;
}

// Groups entries (already in the blog's order) by the slug of a label. Two labels that share a slug ("C++" and
// "c") share a group, named by the one that sorts first; `merged` lists the labels that were folded together.
function group(entries, labelsOf) {
  const groups = new Map();
  for (const e of entries) {
    const seen = new Set();
    for (const label of labelsOf(e)) {
      const slug = slugify(label);
      if (seen.has(slug)) continue;
      seen.add(slug);
      if (!groups.has(slug)) groups.set(slug, { slug, labels: new Set(), entries: [] });
      const g = groups.get(slug);
      g.labels.add(label);
      g.entries.push(e);
    }
  }
  return [...groups.values()]
    .map((g) => {
      const labels = [...g.labels].sort();
      return { slug: g.slug, label: labels[0], labels, entries: g.entries };
    })
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

export const groupTags = (entries) => group(entries, (e) => e.tags || []);
export const groupAuthors = (entries) => group(entries, (e) => (e.author ? [e.author] : []));

// Whether the blog has more than one author: a one-author blog has no use for author pages.
export const hasManyAuthors = (entries) => new Set(entries.filter((e) => e.author).map((e) => slugify(e.author))).size > 1;

// Years, newest first; within a year, newest first, ties by slug. This is the archive's own order (by authored
// date), whatever order the blog itself is in.
export function byYear(entries) {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const years = [];
  for (const e of sorted) {
    const year = e.date.slice(0, 4);
    if (!years.length || years[years.length - 1].year !== year) years.push({ year, entries: [] });
    years[years.length - 1].entries.push(e);
  }
  return years;
}

// Splits a list into pages of `size`; 0 (or less than one page's worth) is a single page.
export function paginate(entries, size) {
  if (!size || size < 1 || entries.length <= size) return [entries];
  const pages = [];
  for (let i = 0; i < entries.length; i += size) pages.push(entries.slice(i, i + size));
  return pages;
}

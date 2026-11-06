// A reader's own sort of the post list: a view, not a setting of the blog. It changes the order of the list
// on this page and nothing else: not the blog's order, not a URL, not any page's previous/next (those are
// decided once, at publish, from the blog's order: lib/order.js). "order" is the blog's own sequence, as the
// index records it, and is what everyone starts with.
import { collate } from './order.js';

export const READER_SORTS = Object.freeze([
  ['order', 'Blog order'],
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['title', 'Title A–Z'],
]);

const slugAsc = (a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

export function readerSort(entries, mode) {
  const by = {
    newest: (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : slugAsc(a, b)),
    oldest: (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : slugAsc(a, b)),
    title: (a, b) => collate(a.title, b.title) || slugAsc(a, b),
  }[mode];
  return by ? [...entries].sort(by) : entries;
}

export const isReaderSort = (m) => READER_SORTS.some(([k]) => k === m);

const key = (repo) => `blog.webcli.sort:${repo}`;
// per session: a reader's choice is remembered until the tab closes, and is never written anywhere else
export function savedSort(storage, repo) {
  try {
    const m = storage.getItem(key(repo));
    return isReaderSort(m) ? m : 'order';
  } catch {
    return 'order';
  }
}
export function saveSort(storage, repo, mode) {
  try {
    storage.setItem(key(repo), mode);
  } catch {
    /* blocked: the choice just is not remembered */
  }
}

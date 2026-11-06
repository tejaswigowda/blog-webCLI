// What every page of a blog needs to know about the rest of it: the header menu (its pages, the archive, the
// tags, search) and where a tag or an author lives. It is a function of blog.json and of the published posts
// and pages, nothing else, so the generator and the browser's live renderer (which rebuilds a page from the
// index) arrive at the same markup.
import { searchEnabled } from './seo.js';
import { groupTags, hasManyAuthors, slugify } from './taxonomy.js';

export const TAGS_DIR = 'tags';
export const AUTHORS_DIR = 'authors';
export const ARCHIVE_DIR = 'archive';
export const SEARCH_DIR = 'search';
export const PAGE_DIR = 'page';

// entries: published posts, { tags, author }; pages: published pages, { slug, title, menu: number|null }.
export function siteModel(blog, { entries = [], pages = [] } = {}) {
  const menuPages = pages
    .filter((p) => p.menu !== null && p.menu !== undefined)
    .sort((a, b) => a.menu - b.menu || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((p) => ({ label: p.title, path: `${p.slug}/` }));
  const hasTags = entries.some((e) => (e.tags || []).length);
  const menu = [
    ...menuPages,
    ...(entries.length ? [{ label: 'Archive', path: `${ARCHIVE_DIR}/` }] : []),
    ...(hasTags ? [{ label: 'Tags', path: `${TAGS_DIR}/` }] : []),
    ...(searchEnabled(blog) ? [{ label: 'Search', path: `${SEARCH_DIR}/` }] : []),
  ];
  const authors = hasManyAuthors(entries);
  return {
    menu,
    tagPath: (tag) => `${TAGS_DIR}/${slugify(tag)}/`,
    authorPath: authors ? (name) => `${AUTHORS_DIR}/${slugify(name)}/` : null,
    tags: groupTags(entries),
    authors,
  };
}

// The model as a page at some depth sees it: `home` is the path back to the blog's root ("../", "../../", "./").
export function viewFrom(model, home) {
  return {
    menu: model.menu.map((m) => ({ label: m.label, href: `${home}${m.path}` })),
    tagHref: (t) => `${home}${model.tagPath(t)}`,
    authorHref: model.authorPath ? (n) => `${home}${model.authorPath(n)}` : null,
  };
}

// Old addresses that keep working. A post or page may list where it used to live (`aliases: [2020/05/old-post]`, written by the
// WordPress importer from each item's permalink); the generator writes a small page at each of those paths that sends the reader,
// and a crawler, to the post's own address (see redirectPage in lib/page.js). A static site cannot answer with a 301, so the page
// carries a canonical link, a meta refresh and a plain link, and says noindex: the same three things a redirect plugin leaves.
// An alias is a path below the blog's root: no query string, no scheme, no host, nothing that is not a plain path segment.
import { Refusal } from './errors.js';

export const MAX_ALIASES = 25;
const SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N}._~-]{0,99}$/u;
// Names the generator, the host or the repository own at the top of a blog: an alias below one would write into them.
export const ROOT_NAMES = new Set([
  'posts', 'pages', 'index', 'feed', 'feed.xml', 'assets', 'static', 'node_modules', 'p', 'tags', 'authors', 'archive', 'search', 'search.json', 'page',
  'sitemap.xml', 'sitemaps', 'robots.txt', '404.html', 'index.html', 'licences.json', 'blog.json', 'assets.lock.json', 'extension-outputs.json', 'theme.css', 'style.css',
  'webcli-live.js', 'webcli-search.js', 'order.json', 'cname', 'readme.md', 'license', 'licence', 'images', 'videos', 'audio',
]);

const bad = (detail, where) => new Refusal('bad-alias', detail, where);

// "/2020/05/Old-Post/" -> "2020/05/Old-Post"
export function normaliseAlias(raw, where) {
  if (typeof raw !== 'string') throw bad('an alias must be text: the old path of this page, like 2020/05/old-post', where);
  const path = raw.trim().replace(/^\/+|\/+$/g, '');
  if (!path) throw bad('an alias cannot be empty: the home page is not a page that moved', where);
  if (/[?#:\s\\]/.test(path)) throw bad(`alias "${raw}" must be a plain path (no query string, fragment, scheme or spaces); a static site cannot redirect "?p=123"`, where);
  const segments = path.split('/');
  if (segments.length > 8 || path.length > 300) throw bad(`alias "${raw}" is longer than a path should be`, where);
  for (const s of segments) if (!SEGMENT.test(s) || s === '.' || s === '..') throw bad(`alias "${raw}": "${s}" is not a path segment (letters, digits and . _ ~ -, starting with a letter or digit)`, where);
  return path;
}

// -> the normalised aliases of a post's frontmatter, in the order written, with no repeats
export function parseAliases(meta, where) {
  const v = meta.aliases;
  if (v === undefined || v === '') return [];
  const list = Array.isArray(v) ? v : [v];
  if (list.length > MAX_ALIASES) throw bad(`at most ${MAX_ALIASES} aliases per page (this one has ${list.length})`, where);
  const out = [];
  for (const raw of list) {
    const a = normaliseAlias(raw, where);
    if (out.includes(a)) throw bad(`alias "${a}" is listed twice`, where);
    out.push(a);
  }
  return out;
}

// items: [{ path, slug, aliases }] for the published posts and pages. slugs: every slug the blog has, drafts included, because
// a draft is a page waiting to happen. `shared`: top-level folders of the blog's own directory that belong to an asset or video repository.
// -> { records: [{ from, slug }] sorted by path, errors: [Refusal] }
export function checkAliases(items, { slugs, shared = new Set() }) {
  const errors = [];
  const records = [];
  const claimed = new Map();
  for (const item of items) {
    for (const from of item.aliases) {
      const first = from.split('/')[0];
      if (from === item.slug) {
        errors.push(new Refusal('alias-collision', `alias "${from}" is the page's own address; list only the addresses it used to have`, item.path));
      } else if (ROOT_NAMES.has(first.toLowerCase()) || shared.has(first)) {
        errors.push(new Refusal('alias-collision', `alias "${from}" is below "${first}", which the generator or the repository owns`, item.path));
      } else if (slugs.has(first)) {
        errors.push(new Refusal('alias-collision', `alias "${from}" is below "${first}", the address of a post or page`, item.path));
      } else if (claimed.has(from)) {
        errors.push(new Refusal('alias-collision', `alias "${from}" is claimed by both ${claimed.get(from)} and ${item.path}`, item.path));
      } else {
        claimed.set(from, item.path);
        records.push({ from, slug: item.slug });
      }
    }
  }
  records.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return { records, errors };
}

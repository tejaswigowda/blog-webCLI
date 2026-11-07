// A live WordPress site's public REST API (/wp-json/wp/v2) read into the same model as an export file (lib/wxr.js).
// Pure: the caller fetches the pages of JSON (it knows how to fetch where it runs) and hands them over here. Only what
// the API shows without signing in is there: published posts and pages. Drafts, private posts and menus need an export.
import { Refusal } from './errors.js';
import { dateOf, fileKind } from './wxr.js';
import { decodeHtml } from './wp-html.js';

export const PER_PAGE = 100;

// The addresses to read, for a site address like https://example.com or https://example.com/blog.
export function restBase(address) {
  const given = address.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(given) && !/^https?:\/\//i.test(given)) throw new Refusal('bad-wp-site', 'a site address starts with https://');
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(given) ? given : `https://${given}`);
  } catch {
    throw new Refusal('bad-wp-site', `"${address}" is not a web address`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Refusal('bad-wp-site', 'a site address starts with https://');
  const site = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  const api = (path, page) => `${site}/wp-json/wp/v2/${path}${path.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=${page}`;
  return { site, root: `${site}/wp-json/`, api };
}

export const RESOURCES = ['posts', 'pages', 'media', 'tags', 'categories', 'users', 'comments'];

const rendered = (v) => (v && typeof v === 'object' ? v.rendered ?? '' : v ?? '');

// data: { root, posts, pages, media, tags, categories, users, comments } — arrays of the API's objects (root: the /wp-json/ object)
export function restModel(data, { today } = {}) {
  const root = data.root || {};
  if (!root || typeof root !== 'object' || (root.name === undefined && !(data.posts || []).length)) throw new Refusal('bad-wp-site', 'the address answered, but not as a WordPress REST API (/wp-json/)');
  const fallbackDate = today || '1970-01-01';
  const names = new Map();
  for (const t of [...(data.tags || []), ...(data.categories || [])]) if (t && t.id && t.name && t.slug !== 'uncategorized') names.set(`${t.taxonomy || ''}:${t.id}`, decodeHtml(String(t.name)));
  const termName = (taxonomy, id) => names.get(`${taxonomy}:${id}`) || names.get(`:${id}`) || null;
  const media = (data.media || []).filter((m) => m && m.source_url).map((m) => ({ id: m.id, url: m.source_url, title: String(rendered(m.title)), mime: String(m.mime_type || '').startsWith('image/') ? 'image' : fileKind(m.source_url) || '', parent: m.post || 0, alt: m.alt_text || '' }));
  const mediaUrl = new Map(media.map((m) => [m.id, m.url]));
  const commentsOf = new Map();
  for (const c of data.comments || []) {
    if (!c || !c.post || c.status !== 'approved' || (c.type && c.type !== 'comment')) continue;
    commentsOf.set(c.post, [...(commentsOf.get(c.post) || []), { id: c.id, parent: c.parent || 0, author: decodeHtml(String(c.author_name || '')).trim(), date: dateOf(c.date, c.date_gmt) || '', html: String(rendered(c.content)) }]);
  }
  const users = new Map((data.users || []).map((u) => [u.id, decodeHtml(String(u.name || '')) || u.slug]));
  const authors = {};
  const common = (p) => {
    const who = users.get(p.author) || (p.author ? `user-${p.author}` : '');
    if (who) authors[who] = who;
    return {
      id: p.id,
      title: String(rendered(p.title)),
      slug: p.slug || '',
      date: dateOf(p.date, p.date_gmt) || fallbackDate,
      status: p.status === 'publish' ? 'published' : 'draft',
      wpStatus: p.status,
      comments: commentsOf.get(p.id) || [],
      author: who,
      html: String(rendered(p.content)),
      excerpt: String(rendered(p.excerpt)),
      link: p.link || '',
      thumbnailId: p.featured_media || 0,
      thumbnailUrl: mediaUrl.get(p.featured_media) || '',
    };
  };
  return {
    source: 'rest',
    title: decodeHtml(String(root.name || '')).trim(),
    description: decodeHtml(String(root.description || '')).trim(),
    link: String(root.home || root.url || '').replace(/\/+$/, ''),
    language: '',
    authors,
    posts: (data.posts || []).map((p) => ({ ...common(p), tags: [...(p.tags || []).map((id) => termName('post_tag', id)), ...(p.categories || []).map((id) => termName('category', id))].filter((t, i, all) => t && all.indexOf(t) === i) })),
    pages: (data.pages || []).map((p) => ({ ...common(p), menuOrder: p.menu_order || 0, parent: p.parent || 0 })),
    media,
    menu: [],
    skipped: {},
  };
}

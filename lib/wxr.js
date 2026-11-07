// A WordPress export file (WXR, Tools → Export) read into one plain model that the rest of the import works on.
// The REST reader (lib/wp-rest.js) produces the same model, so everything after this point does not care where
// the content came from.
//
// model: {
//   source: 'wxr' | 'rest',
//   title, description, link, language,
//   authors: { login: displayName },
//   posts: [{ id, title, slug, date, status, author, tags, html, excerpt, thumbnailId, thumbnailUrl, link }],
//   pages: [{ id, title, slug, date, status, author, html, excerpt, thumbnailId, thumbnailUrl, menuOrder, parent, link }],
//   (a post or page also has comments: [{ id, parent, author, date, html }], the approved ones; no address or email is kept)
//   media: [{ id, url, title, mime ('image' | 'file' | ''), parent, alt }],
//   menu: [pageId, …]            pages that are in a navigation menu, in menu order
//   skipped: { 'product': 3 }    other content types, counted and not imported
// }
import { Refusal } from './errors.js';
import { child, childText, kids, parseXml, textOf } from './xml.js';

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif)(?:[?#].*)?$/i;
// Documents, audio, video and archives a media library holds. Never anything a browser would run or render as a page
// (html, svg, js, php, executables): those are not copied, so the pages of a blog can never serve one from an asset address.
const FILE_EXT = /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|epub|zip|gz|tgz|mp3|m4a|ogg|oga|wav|flac|mp4|m4v|webm|mov|ogv)(?:[?#].*)?$/i;
export const isImageUrl = (u) => IMAGE_EXT.test(u);
export const isFileUrl = (u) => FILE_EXT.test(u);
// 'image', 'file' (kept as it is) or null (not taken)
export const fileKind = (u) => (isImageUrl(u) ? 'image' : isFileUrl(u) ? 'file' : null);

const ZERO = /^0000-00-00/;

// 'YYYY-MM-DD HH:MM:SS' (or an RFC 822 date) -> 'YYYY-MM-DD', or null
export function dateOf(...candidates) {
  for (const c of candidates) {
    const s = String(c || '').trim();
    if (!s || ZERO.test(s)) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const t = Date.parse(s);
    if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  }
  return null;
}

const STATUS = { publish: 'published', future: 'draft', draft: 'draft', pending: 'draft', private: 'draft' };

function metaOf(item) {
  const out = {};
  for (const m of kids(item, 'wp:postmeta')) out[childText(m, 'wp:meta_key')] = childText(m, 'wp:meta_value');
  return out;
}

export function parseWxr(text, { today } = {}) {
  const doc = parseXml(text);
  const rss = child(doc, 'rss');
  const channel = child(rss, 'channel');
  if (!channel) throw new Refusal('bad-wp-export', 'this is not a WordPress export file: it has no <rss><channel> (use Tools → Export → All content in WordPress)');
  const fallbackDate = today || '1970-01-01';
  const model = {
    source: 'wxr',
    title: childText(channel, 'title').trim(),
    description: childText(channel, 'description').trim(),
    link: (childText(channel, 'wp:base_blog_url') || childText(channel, 'link')).trim().replace(/\/+$/, ''),
    language: childText(channel, 'language').trim(),
    authors: {},
    posts: [],
    pages: [],
    media: [],
    menu: [],
    skipped: {},
  };
  for (const a of kids(channel, 'wp:author')) {
    const login = childText(a, 'wp:author_login').trim();
    if (login) model.authors[login] = childText(a, 'wp:author_display_name').trim() || login;
  }

  const items = kids(channel, 'item').map((item) => ({
    id: Number(childText(item, 'wp:post_id')) || 0,
    type: childText(item, 'wp:post_type').trim(),
    status: childText(item, 'wp:status').trim(),
    title: childText(item, 'title').trim(),
    slug: childText(item, 'wp:post_name').trim(),
    date: dateOf(childText(item, 'wp:post_date'), childText(item, 'wp:post_date_gmt'), childText(item, 'pubDate'), childText(item, 'wp:post_modified')) || fallbackDate,
    author: childText(item, 'dc:creator').trim(),
    html: childText(item, 'content:encoded'),
    excerpt: childText(item, 'excerpt:encoded'),
    link: childText(item, 'link').trim(),
    parent: Number(childText(item, 'wp:post_parent')) || 0,
    menuOrder: Number(childText(item, 'wp:menu_order')) || 0,
    attachmentUrl: childText(item, 'wp:attachment_url').trim(),
    comments: kids(item, 'wp:comment')
      .map((c) => ({ id: Number(childText(c, 'wp:comment_id')) || 0, parent: Number(childText(c, 'wp:comment_parent')) || 0, author: childText(c, 'wp:comment_author').trim(), date: dateOf(childText(c, 'wp:comment_date'), childText(c, 'wp:comment_date_gmt')) || '', html: childText(c, 'wp:comment_content'), approved: childText(c, 'wp:comment_approved').trim(), type: childText(c, 'wp:comment_type').trim() }))
      .filter((c) => c.approved === '1' && (c.type === '' || c.type === 'comment') && c.html.trim())
      .map(({ approved, type, ...c }) => c),
    terms: kids(item, 'category').map((c) => ({ domain: c.attrs.domain, slug: c.attrs.nicename, name: textOf(c).trim() })),
    meta: metaOf(item),
  }));

  const byId = new Map(items.map((i) => [i.id, i]));
  const attachmentUrl = (id) => {
    const a = byId.get(Number(id));
    return a && a.type === 'attachment' ? a.attachmentUrl : '';
  };

  for (const it of items) {
    if (it.type === 'attachment') {
      if (it.attachmentUrl) model.media.push({ id: it.id, url: it.attachmentUrl, title: it.title, mime: it.meta._wp_attachment_image_alt !== undefined || isImageUrl(it.attachmentUrl) ? 'image' : fileKind(it.attachmentUrl) || '', parent: it.parent, alt: it.meta._wp_attachment_image_alt || '' });
      continue;
    }
    if (it.type === 'nav_menu_item') continue;
    if (it.type !== 'post' && it.type !== 'page') {
      if (it.status !== 'auto-draft' && it.status !== 'trash' && it.type) model.skipped[it.type] = (model.skipped[it.type] || 0) + 1;
      continue;
    }
    if (it.status === 'trash' || it.status === 'auto-draft' || it.status === 'inherit') continue;
    const status = STATUS[it.status];
    if (!status) continue;
    const common = { id: it.id, title: it.title, slug: it.slug, date: it.date, status, author: it.author, html: it.html, excerpt: it.excerpt, link: it.link, wpStatus: it.status, comments: it.comments, thumbnailId: Number(it.meta._thumbnail_id) || 0, thumbnailUrl: attachmentUrl(it.meta._thumbnail_id) };
    if (it.type === 'post') {
      const tags = [];
      for (const t of it.terms) {
        if ((t.domain === 'post_tag' || t.domain === 'category') && t.name && !(t.domain === 'category' && t.slug === 'uncategorized') && !tags.includes(t.name)) tags.push(t.name);
      }
      model.posts.push({ ...common, tags });
    } else model.pages.push({ ...common, menuOrder: it.menuOrder, parent: it.parent });
  }

  // pages named by a navigation menu, in the menu's own order
  const menuItems = items
    .filter((i) => i.type === 'nav_menu_item' && i.status === 'publish' && i.meta._menu_item_object === 'page' && !Number(i.meta._menu_item_menu_item_parent))
    .sort((a, b) => a.menuOrder - b.menuOrder || a.id - b.id);
  for (const m of menuItems) {
    const id = Number(m.meta._menu_item_object_id);
    if (id && !model.menu.includes(id)) model.menu.push(id);
  }
  return model;
}

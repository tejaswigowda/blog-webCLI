// WordPress content -> this blog's files. Pure: the model comes from lib/wxr.js or lib/wp-rest.js, the pictures are
// handed in by the caller (a browser fetches them, the CLI fetches them), and what comes out is a list of files:
// posts/<slug>.md, pages/<slug>.md and the image bytes, with every image named by a logical asset: reference.
//
//   const job = planWp(model, { today });
//   job.images                      what to fetch: [{ url, path, kind }]
//   const out = job.finish(fetched) { files, assets, notes, blog, summary }   fetched: Map(url -> bytes | null)
//
// Nothing is guessed silently: what could not be kept (a table, a shortcode, an image that would not download) is
// returned in `notes`, with the file it concerns.
import { Refusal } from './errors.js';
import { RESERVED_SLUGS, joinFile, newFront } from './frontmatter.js';
import { deltaToMd, deltaToMarkdownChecked, mdToDelta } from './markdown.js';
import { parsePost } from './blog.js';
import { decodeHtml, htmlToDelta } from './wp-html.js';
import { slugify } from './taxonomy.js';
import { isImageUrl } from './wxr.js';

export const IMAGES_KEY = 'images';
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// The kind of image these bytes are, by what they start with (never by what a server said), or null.
export function sniffImage(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && b[11] === 0x66) return 'avif';
  return null;
}

const bare = (host) => host.toLowerCase().replace(/^www\./, '');
const safeSeg = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'file';
const flat = (s) => decodeHtml(String(s || '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const cut = (s, max) => (s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, '')}…`);

function decodePath(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

export function planWp(model, { today = '1970-01-01', includeDrafts = true, includeLibrary = true } = {}) {
  let base = null;
  try {
    base = new URL(model.link);
  } catch {
    /* an export with no site address: relative addresses cannot be resolved */
  }
  const siteHost = base ? bare(base.hostname) : '';
  const notes = [];
  const note = (where, text) => notes.push({ where, text });

  // ---- the media library, by canonical address ----
  const absolute = (u) => {
    try {
      return new URL(u, base || undefined);
    } catch {
      return null;
    }
  };
  const photon = /^i\d\.wp\.com$/i;
  const canonical = (raw) => {
    const u = absolute(String(raw).trim());
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null;
    let host = u.host;
    let pathname = u.pathname;
    if (photon.test(u.hostname)) {
      const m = /^\/([^/]+)(\/.*)$/.exec(pathname); // i0.wp.com/<origin host>/<path>: the original is on the origin host
      if (m) {
        host = m[1];
        pathname = m[2];
      }
    }
    // an old http address is asked for over https (a browser page may not read plain http); this machine is left alone, for testing
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    return `${u.protocol === 'http:' && !local ? 'https:' : u.protocol}//${host}${pathname.split('/').map((s) => encodeURIComponent(decodePath(s))).join('/')}`;
  };
  const mediaByUrl = new Map();
  for (const m of model.media) {
    const c = canonical(m.url);
    if (c) mediaByUrl.set(c, m);
  }
  const mediaById = new Map(model.media.map((m) => [m.id, m]));
  // a resized copy (photo-300x200.jpg) is the library's photo.jpg when the library has it
  const original = (c) => {
    const un = c.replace(/-\d{2,5}x\d{2,5}(\.[A-Za-z0-9]+)$/, '$1').replace(/-scaled(\.[A-Za-z0-9]+)$/, '$1');
    return un !== c && mediaByUrl.has(un) ? un : c;
  };

  // ---- where each image will live ----
  const wanted = new Map(); // canonical url -> { url, path, kind }
  const taken = new Set();
  const pathFor = (c) => {
    if (wanted.has(c)) return wanted.get(c).path;
    const u = new URL(c);
    const pn = decodePath(u.pathname);
    const at = pn.indexOf('/wp-content/uploads/');
    const rest = at >= 0 ? pn.slice(at + '/wp-content/uploads/'.length) : `${bare(u.hostname)}${pn}`;
    const segs = rest.split('/').filter(Boolean).map(safeSeg);
    let p = `wp/${segs.join('/')}`;
    for (let n = 2; taken.has(p.toLowerCase()); n++) p = `wp/${segs.slice(0, -1).concat(segs[segs.length - 1].replace(/(\.[A-Za-z0-9]+)?$/, `-${n}$1`)).join('/')}`;
    taken.add(p.toLowerCase());
    return p;
  };
  const want = (c, kind) => {
    if (!wanted.has(c)) wanted.set(c, { url: c, path: pathFor(c), kind });
    return wanted.get(c);
  };
  // images the blog owns: on its own host, or in its library
  const owns = (c) => {
    try {
      return bare(new URL(c).hostname) === siteHost || mediaByUrl.has(c);
    } catch {
      return false;
    }
  };

  // ---- slugs, decided up front so a link between posts can be rewritten ----
  const entries = [
    ...model.posts.map((p) => ({ ...p, kind: 'post' })),
    ...model.pages.map((p) => ({ ...p, kind: 'page' })),
  ].filter((e) => includeDrafts || e.status === 'published');
  const used = new Set();
  const slugOf = new Map();
  const RESERVED = new Set([...RESERVED_SLUGS, 'images', 'videos']);
  for (const e of entries) {
    let s = slugify(decodePath(e.slug) || flat(e.title) || `${e.kind}-${e.id}`);
    if (RESERVED.has(s)) s = `${s}-wp`;
    let slug = s;
    for (let n = 2; used.has(slug); n++) slug = `${s.slice(0, 56)}-${n}`;
    used.add(slug);
    slugOf.set(e, slug);
  }
  const byPermalink = new Map();
  const byId = new Map();
  for (const e of entries) {
    byId.set(e.id, slugOf.get(e));
    const u = e.link && absolute(e.link);
    if (u) byPermalink.set(u.pathname.replace(/\/+$/, '') || '/', slugOf.get(e));
  }

  const linkTo = (href) => {
    const u = absolute(href);
    if (!u) return null;
    if (u.protocol === 'mailto:') return u.href;
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (bare(u.hostname) === siteHost) {
      const id = Number(u.searchParams.get('p') || u.searchParams.get('page_id'));
      const slug = (id && byId.get(id)) || byPermalink.get(u.pathname.replace(/\/+$/, '') || '/');
      if (slug) return `../${slug}/`;
    }
    return u.href;
  };

  const docs = [];
  let internalLinks = 0;
  for (const e of entries) {
    const slug = slugOf.get(e);
    const where = `${e.kind === 'page' ? 'pages' : 'posts'}/${slug}.md`;
    const docNotes = [];
    const { ops, notes: found } = htmlToDelta(e.html, {
      image: (src, alt) => {
        const c0 = canonical(src);
        if (!c0) return null;
        const c = original(c0);
        if (owns(c)) return `asset:${IMAGES_KEY}/${want(c, 'content').path}`;
        docNotes.push('an image hosted on another site stays linked there');
        return c0;
      },
      link: (href) => {
        const to = linkTo(href);
        if (to && to.startsWith('../')) internalLinks++;
        return to;
      },
      attachment: (id) => {
        const m = mediaById.get(id);
        return m ? { url: m.url, alt: m.alt || m.title || '' } : null;
      },
    });
    docNotes.push(...found);
    let cover = null;
    if (e.thumbnailUrl) {
      const c = canonical(e.thumbnailUrl);
      if (c) cover = want(original(c), 'featured').path;
    }
    docs.push({ e, slug, where, ops, cover, notes: [...new Set(docNotes)] });
  }
  if (includeLibrary) for (const m of model.media) {
    const c = canonical(m.url);
    if (c && (m.mime === 'image' || isImageUrl(m.url))) want(c, 'library');
  }

  // ---- the blog's own details ----
  const counts = new Map();
  for (const p of model.posts) {
    const name = model.authors[p.author] || p.author;
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  const topAuthor = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  let host = siteHost;
  const title = flat(model.title) || host || 'Imported blog';
  const blog = {
    title,
    description: cut(flat(model.description), 200) || (host ? `Imported from ${host}` : 'Imported from WordPress'),
    author: (topAuthor && topAuthor[0]) || title,
  };

  const images = [...wanted.values()];

  function finish(fetched = new Map()) {
    const failed = new Map(); // asset path -> the address it came from
    const assets = [];
    for (const im of images) {
      const bytes = fetched.get(im.url);
      if (bytes && bytes.length && bytes.length <= MAX_IMAGE_BYTES && sniffImage(bytes)) assets.push({ path: im.path, bytes, kind: im.kind });
      else failed.set(im.path, im);
    }
    const files = [];
    const out = [];
    for (const d of docs) {
      const { e } = d;
      const dn = [...d.notes];
      const ops = d.ops.map((op) => {
        if (op.insert && typeof op.insert === 'object' && typeof op.insert.image === 'string' && op.insert.image.startsWith(`asset:${IMAGES_KEY}/`)) {
          const f = failed.get(op.insert.image.slice(`asset:${IMAGES_KEY}/`.length));
          if (f) {
            dn.push('an image could not be downloaded and stays linked to the old site');
            return { ...op, insert: { image: f.url } };
          }
        }
        return op;
      });
      let md;
      try {
        md = deltaToMarkdownChecked({ ops }).md;
      } catch (err) {
        if (!(err instanceof Refusal)) throw err;
        // markdown cannot say it as built: keep the words as plain paragraphs rather than lose the post
        const text = ops.map((o) => (typeof o.insert === 'string' ? o.insert : o.insert && o.insert.image ? '' : '')).join('');
        md = deltaToMd(mdToDelta(text.split('\n').filter((l) => l.trim()).join('\n\n')));
        dn.push('its formatting could not be kept; the text was imported as plain paragraphs');
      }
      const status = e.status;
      const author = e.kind === 'post' ? model.authors[e.author] || e.author : '';
      const meta = {
        slug: d.slug,
        title: cut(flat(e.title), 200) || 'Untitled',
        ...(e.kind === 'post' ? { date: e.date } : {}),
        ...(author && author !== blog.author ? { author: author.replace(/\s+/g, ' ') } : {}),
        ...(e.kind === 'post' && e.tags.length ? { tags: e.tags.map((t) => decodeHtml(t).replace(/[,[\]"]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean) } : {}),
        status,
        ...(e.kind === 'page' && model.menu.includes(e.id) ? { menu: String(Math.min(model.menu.indexOf(e.id) + 1, 99)) } : {}),
        ...(d.cover && !failed.has(d.cover) ? { cover: `asset:${IMAGES_KEY}/${d.cover}` } : {}),
        ...(flat(e.excerpt) ? { description: cut(flat(e.excerpt), 300) } : {}),
      };
      if (d.cover && failed.has(d.cover)) dn.push('its featured image could not be downloaded, so it has no cover');
      if (e.wpStatus === 'private') dn.push('it was private on WordPress, so it was imported as a draft');
      if (e.wpStatus === 'future') dn.push('it was scheduled on WordPress, so it was imported as a draft');
      let text = joinFile(newFront(meta), md);
      let parsed = parsePost({ path: d.where, text });
      for (let k = 0; k < 3 && parsed.lossy; k++) {
        text = joinFile(newFront(meta), deltaToMd(mdToDelta(parsed.body)));
        parsed = parsePost({ path: d.where, text });
      }
      if (parsed.lossy) {
        note(d.where, 'it could not be written as markdown that survives a round trip, so it was left out');
        continue;
      }
      files.push({ path: d.where, text });
      for (const t of new Set(dn)) note(d.where, t);
      out.push(d);
    }
    const summary = {
      posts: out.filter((d) => d.e.kind === 'post' && d.e.status === 'published').length,
      drafts: out.filter((d) => d.e.status === 'draft').length,
      pages: out.filter((d) => d.e.kind === 'page').length,
      images: assets.length,
      imagesFailed: failed.size,
      imageBytes: assets.reduce((n, a) => n + a.bytes.length, 0),
      internalLinks,
      skipped: model.skipped,
    };
    return { files, assets, notes, blog, summary };
  }

  return { images, blog, finish, counts: { posts: model.posts.length, pages: model.pages.length, drafts: entries.filter((e) => e.status === 'draft').length, library: model.media.length, skipped: model.skipped } };
}

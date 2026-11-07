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
import { ROOT_NAMES, normaliseAlias } from './aliases.js';
import { slugify } from './taxonomy.js';
import { fileKind } from './wxr.js';

export const IMAGES_KEY = 'images';
// GitHub refuses a file over 100 MB; this leaves room, and a file over it is left linked to the old site, not cut up
export const MAX_FILE_BYTES = 90 * 1024 * 1024;
export const MAX_IMAGE_BYTES = MAX_FILE_BYTES;

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

// Is this file one to keep? A picture by its first bytes, never by what a server called it; any other kept kind of file
// (see lib/wxr.js) by its extension, and never if it is really a web page in disguise.
export function acceptFile(path, bytes) {
  if (!bytes || !bytes.length || bytes.length > MAX_FILE_BYTES) return false;
  const kind = fileKind(path);
  if (kind === 'image') return sniffImage(bytes) !== null;
  if (kind === 'file') {
    const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
    return !(head.startsWith('<') || head.startsWith('<!doctype') || head.startsWith('<?'));
  }
  return false;
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

// The approved comments of a post, as a "Comments" section at its end: who, when, and what they said as a quotation, in the
// order they were written, a reply naming the person it answers. No address, email or IP is ever in an export's output here.
export function commentOps(comments, opts) {
  const sorted = [...comments].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  const byId = new Map(sorted.map((c) => [c.id, c]));
  const ops = [{ insert: `Comments (${sorted.length})` }, { insert: '\n', attributes: { header: 2 } }];
  const notes = [];
  for (const c of sorted) {
    const who = flat(c.author) || 'Anonymous';
    const to = c.parent && byId.get(c.parent) ? ` — replying to ${flat(byId.get(c.parent).author) || 'Anonymous'}` : '';
    ops.push({ insert: who, attributes: { bold: true } }, { insert: `${c.date ? ` · ${c.date}` : ''}${to}` }, { insert: '\n' });
    const body = htmlToDelta(c.html, { image: () => null, link: opts.link });
    for (const n of body.notes) notes.push(`in a comment: ${n}`);
    for (const op of body.ops) ops.push(op.attributes === undefined && op.insert === '\n' ? { insert: '\n', attributes: { blockquote: true } } : op);
  }
  return { ops, notes: [...new Set(notes)], count: sorted.length };
}

const PAGINATE_OVER = 50;

export function planWp(model, { today = '1970-01-01', includeDrafts = true, includeLibrary = true, includeComments = true, redirects = true } = {}) {
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
  // only what is on the blog's own site is copied: its host (www or not), a subdomain of it, or, for a wordpress.com
  // blog, its files host. A library entry or a featured image on some other host is not the blog's to take.
  const wpCom = /^([^.]+)\.wordpress\.com$/.exec(siteHost);
  const sameSite = (host) => {
    const h = bare(host);
    return !!siteHost && (h === siteHost || h.endsWith(`.${siteHost}`) || (!!wpCom && h === `${wpCom[1]}.files.wordpress.com`));
  };
  const owns = (c) => {
    try {
      return sameSite(new URL(c).hostname);
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
    for (let n = 2; used.has(slug); n++) slug = `${s.slice(0, 56).replace(/-+$/, '')}-${n}`;
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
  let commentCount = 0;
  // a link to one of the blog's own files (a PDF, a bigger picture) points at the copy that comes across; to another
  // imported post, at its new page; anything else is left as it was
  const linkOf = (href, onInternal) => {
    const c = canonical(href);
    if (c && fileKind(new URL(c).pathname) && owns(c)) return `asset:${IMAGES_KEY}/${want(original(c), 'content').path}`;
    const to = linkTo(href);
    if (to && to.startsWith('../')) onInternal();
    return to;
  };
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
        return /^https?:\/\//i.test(String(src).trim()) ? String(src).trim() : c0;
      },
      link: (href) => linkOf(href, () => {
        internalLinks++;
      }),
      attachment: (id) => {
        const m = mediaById.get(id);
        return m ? { url: m.url, alt: m.alt || m.title || '' } : null;
      },
    });
    docNotes.push(...found);
    let allOps = ops;
    if (includeComments && e.comments && e.comments.length) {
      const c = commentOps(e.comments, { link: (href) => linkOf(href, () => {}) });
      allOps = [...ops, ...c.ops];
      commentCount += c.count;
      docNotes.push(...c.notes);
    }
    let cover = null;
    if (e.thumbnailUrl) {
      const c = canonical(e.thumbnailUrl);
      if (c && owns(c)) cover = want(original(c), 'featured').path;
      else if (c) docNotes.push('the featured image is hosted on another site and was not copied');
    }
    docs.push({ e, slug, where, ops: allOps, cover, notes: [...new Set(docNotes)] });
  }
  let libraryElsewhere = 0;
  if (includeLibrary) for (const m of model.media) {
    const c = canonical(m.url);
    if (!c || !m.mime) continue;
    if (owns(c)) want(c, 'library');
    else libraryElsewhere++;
  }
  if (libraryElsewhere) note('library', `${libraryElsewhere} media library ${libraryElsewhere === 1 ? 'file is' : 'files are'} hosted on another site and ${libraryElsewhere === 1 ? 'was' : 'were'} not copied`);

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
    // a long blog is a list of pages, not one page of thousands of posts (the index would be megabytes)
    ...(entries.filter((e) => e.kind === 'post' && e.status === 'published').length > PAGINATE_OVER ? { pageSize: 20, pageStable: true } : {}),
  };

  const images = [...wanted.values()];

  function finish(fetched = new Map()) {
    const failed = new Map(); // asset path -> the address it came from
    const assets = [];
    for (const im of images) {
      const bytes = fetched.get(im.url);
      if (acceptFile(im.path, bytes)) assets.push({ path: im.path, bytes, kind: im.kind });
      else failed.set(im.path, im);
    }
    const files = [];
    const out = [];
    // an image that could not be brought across stays linked to the old site, wherever the post names it
    const swap = (str, dn) => str.replace(new RegExp(`asset:${IMAGES_KEY}/[^\\s)"'<>]+`, 'g'), (m) => {
      const f = failed.get(m.slice(`asset:${IMAGES_KEY}/`.length));
      if (!f) return m;
      dn.push('an image could not be downloaded and stays linked to the old site');
      return f.url;
    });
    // old addresses that keep working: the path of each item's permalink, below the blog's own address
    const slugs = new Set(docs.map((d) => d.slug));
    const claimed = new Set();
    let plainPermalinks = 0;
    let redirected = 0;
    const aliasFor = (e, slug, dn) => {
      if (!redirects || !e.link) return [];
      let u;
      try {
        u = new URL(e.link);
      } catch {
        return [];
      }
      const root = base ? base.pathname.replace(/\/+$/, '') : '';
      if (u.search || u.pathname === '/' || u.pathname === root + '/' || u.pathname === root) {
        plainPermalinks++;
        return [];
      }
      if (root && !u.pathname.startsWith(`${root}/`)) return [];
      let path;
      try {
        path = normaliseAlias(decodeURIComponent(u.pathname.slice(root.length)));
      } catch {
        return [];
      }
      if (path === slug) return [];
      const first = path.split('/')[0];
      if (ROOT_NAMES.has(first.toLowerCase()) || slugs.has(first) || claimed.has(path)) {
        dn.push(`its old address /${path}/ could not be kept: it is taken by something in the new blog`);
        return [];
      }
      claimed.add(path);
      return [path];
    };
    for (const d of docs) {
      const { e } = d;
      const dn = [...d.notes];
      const ops = d.ops.map((op) => {
        if (op.insert && typeof op.insert === 'object') {
          if (op.insert.mdtable) {
            const t = op.insert.mdtable;
            return { ...op, insert: { mdtable: { head: t.head.map((c) => swap(c, dn)), align: t.align, rows: t.rows.map((r) => r.map((c) => swap(c, dn))) } } };
          }
          if (typeof op.insert.htmlblock === 'string') return { ...op, insert: { htmlblock: swap(op.insert.htmlblock, dn) } };
        }
        if (op.insert && typeof op.insert === 'object' && typeof op.insert.image === 'string' && op.insert.image.startsWith(`asset:${IMAGES_KEY}/`)) {
          const f = failed.get(op.insert.image.slice(`asset:${IMAGES_KEY}/`.length));
          if (f) {
            dn.push('an image could not be downloaded and stays linked to the old site');
            return { ...op, insert: { image: f.url } };
          }
        }
        if (op.attributes && typeof op.attributes.link === 'string' && op.attributes.link.startsWith(`asset:${IMAGES_KEY}/`)) {
          const f = failed.get(op.attributes.link.slice(`asset:${IMAGES_KEY}/`.length));
          if (f) {
            dn.push('a file could not be downloaded and stays linked to the old site');
            return { ...op, attributes: { ...op.attributes, link: f.url } };
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
        ...(() => {
          const aliases = aliasFor(e, d.slug, dn);
          redirected += aliases.length;
          return aliases.length ? { aliases } : {};
        })(),
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
      images: assets.filter((a) => fileKind(a.path) === 'image').length,
      files: assets.filter((a) => fileKind(a.path) !== 'image').length,
      comments: commentCount,
      imagesFailed: failed.size,
      imageBytes: assets.reduce((n, a) => n + a.bytes.length, 0),
      internalLinks,
      redirects: redirected,
      skipped: model.skipped,
    };
    if (plainPermalinks) note('permalinks', `${plainPermalinks} post${plainPermalinks === 1 ? ' uses' : 's use'} a plain address (?p=123, or none), which a static site cannot redirect`);
    return { files, assets, notes, blog, summary };
  }

  return { images, blog, finish, counts: { posts: model.posts.length, pages: model.pages.length, drafts: entries.filter((e) => e.status === 'draft').length, library: model.media.length, skipped: model.skipped } };
}

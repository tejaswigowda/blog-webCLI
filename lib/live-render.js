// Rebuilding one post page from the live copy of the blog's files, with the same code the generator uses.
// buildSite (lib/blog.js) and this module both end in renderPost; this one only has to gather what
// buildSite is handed: blog.json, the asset pins, the theme's CSS, the licence records and the recorded
// extension outputs are all files the generator committed, so they can be read back instead of
// re-derived. Pure: no DOM, no network (the caller supplies the bytes).
import { Refusal } from './errors.js';
import { parsePost, renderPost, validateBlog } from './blog.js';
import { DEFAULT_CONTRACT } from './contracts.js';
import { themeCss, resolveLogo } from './customize.js';
import { licenceComment } from './licences.js';
import { makeHooks, parseOutputsFile } from './extensions.js';
import { contentBase, liveEnabled } from './content.js';
import { neighbours } from './order.js';

const dec = new TextDecoder('utf-8');

// Never rebuilt in a browser: say why, so the page is simply left as the build wrote it.
export class CannotRebuild extends Error {
  constructor(reason, detail = '') {
    super(`${reason}${detail ? `: ${detail}` : ''}`);
    this.reason = reason;
  }
}

// get(path) -> Promise<Uint8Array | null>   (null: there is no such file)
// `index`: the parsed live index/posts.json when the caller already has it (the 404 path has just read it).
export async function loadSite(get, { index = null } = {}) {
  const text = async (p) => {
    const b = await get(p);
    return b ? dec.decode(b) : null;
  };
  const blogText = await text('blog.json');
  if (blogText === null) throw new CannotRebuild('no-blog-json');
  let blog;
  try {
    blog = validateBlog(blogText);
  } catch (e) {
    if (e instanceof Refusal) throw new CannotRebuild('bad-blog-json', e.detail);
    throw e;
  }
  if (!liveEnabled(blog)) throw new CannotRebuild('not-live', 'blog.json does not enable the live copy');
  const lockText = await text('assets.lock.json');
  const usedTheme = !!(blog.theme && typeof blog.theme === 'object');
  const themeText = usedTheme ? await text('theme.css') : null;
  if (usedTheme && themeText === null) throw new CannotRebuild('no-theme-css');
  const licenceText = await text('licences.json');
  if (licenceText === null) throw new CannotRebuild('no-licences-json');
  const pinned = blog.extensions || [];
  const outputsText = pinned.length ? await text('extension-outputs.json') : null;
  const indexText = index ? null : await text('index/posts.json');
  try {
    return {
      blog,
      index: index || (indexText ? JSON.parse(indexText) : null),
      lock: lockText ? JSON.parse(lockText) : {},
      themeText,
      records: JSON.parse(licenceText).dependencies || [],
      outputs: parseOutputsFile(outputsText),
    };
  } catch (e) {
    throw new CannotRebuild('unreadable-site-file', e.message);
  }
}

// The packs buildSite would have loaded, as far as the generated output depends on them: the manifest
// fields that reach a page (its markup contract, the source and attribution stamped into a comment, the
// hooks an extension implements) are exactly what licences.json recorded.
function packsFromRecords(blog, records) {
  const theme = records.find((r) => r.kind === 'theme' && !r.builtin);
  const exts = records.filter((r) => r.kind === 'extension');
  const pinned = blog.extensions || [];
  if (exts.length !== pinned.length) throw new CannotRebuild('stale-licences-json', 'licences.json does not match blog.json');
  return {
    theme: theme ? { manifest: { class_contract: theme.contract, source: theme.source, attribution: theme.attribution, dropped: theme.dropped } } : null,
    extensions: pinned.map((pin, i) => ({ pin, digest: pin.sha256, manifest: { kind: exts[i].extensionKind, hooks: exts[i].hooks || pin.hooks, source: exts[i].source, attribution: exts[i].attribution } })),
  };
}

// -> { html, slug, published }. Throws CannotRebuild when a page identical to the build's cannot be made.
export function renderFromSite(site, { slug, text }) {
  const { blog, lock, themeText, records, outputs, index } = site;
  let post;
  try {
    post = parsePost({ path: `posts/${slug}.md`, text });
  } catch (e) {
    if (e instanceof Refusal) throw new CannotRebuild(e.code, e.detail);
    throw e;
  }
  if (post.status !== 'published') return { html: null, slug, published: false, post };
  if (post.lossy) throw new CannotRebuild(post.lossy.code, post.lossy.detail);
  // Previous / next come from the sequence the build recorded in the index: this module never sorts (lib/order.js
  // decided the order once), so a page rebuilt here has the neighbours the next build will give it.
  if (!index || !Array.isArray(index.posts)) throw new CannotRebuild('no-index', 'the live index is missing');
  const slugs = Array.isArray(index.sequence) ? index.sequence : index.posts.map((e) => e.slug);
  const nav = neighbours(slugs, slug, new Map(index.posts.map((e) => [e.slug, e.title])), (s) => `../${s}/`);
  if (!nav) throw new CannotRebuild('not-in-index', `"${slug}" is not in the live index`);
  const packs = packsFromRecords(blog, records);
  const usedTheme = !!(blog.theme && typeof blog.theme === 'object');
  const hooks = makeHooks({ extensions: packs.extensions, outputs });
  let rendered;
  try {
    rendered = renderPost(blog, post, lock, {
      contract: usedTheme ? packs.theme.manifest.class_contract || (blog.theme && blog.theme.contract) || DEFAULT_CONTRACT : DEFAULT_CONTRACT,
      css: usedTheme ? themeText.replace(/\n$/, '') : themeCss(blog),
      comment: licenceComment(blog, packs),
      hooks,
      logoUrl: resolveLogo(blog, lock),
      live: { base: contentBase(blog) },
      nav,
    });
  } catch (e) {
    if (e instanceof Refusal) throw new CannotRebuild(e.code, e.detail);
    throw e;
  }
  if (hooks.missing.length) throw new CannotRebuild('extension-output-missing', 'an extension has no recorded output for this post yet');
  return { html: rendered.html, slug, published: true, post };
}

// The 404 variant of a rebuilt page: the status is still 404, so a crawler must not index it; the page
// that settles after the build will be indexed instead.
export const withNoindex = (html) => html.replace('</head>', '<meta name="robots" content="noindex">\n</head>');

export { DEFAULT_CONTRACT };

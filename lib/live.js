// The script every generated page loads (bundled to webcli-live.js by cli/build-live.js; see lib/content.js
// for when a blog ships it). GitHub Pages takes from seconds to minutes to publish what was just committed,
// so a page checks the repository's own copy and shows that instead:
//   * a post page compares the digest of its markdown (x-content-sha256) with the live file and, if they
//     differ, rebuilds itself with the generator's own renderer, in place and without a word;
//   * 404.html looks for a post that is published in the live index but has no page yet, and does the same.
// Only plain GET requests for files are made, with no credentials and no API: nothing here is rate limited
// per address the way GitHub's API is. (See varyPath for how a cached copy is avoided.) Nothing is cached by the page except "already checked" in
// sessionStorage, once per page per session.
import { SLUG_RE } from './frontmatter.js';
import { sha256Bytes } from './sha256.js';
import { VERSION } from './version.js';
import { readIndex } from './index-data.js';
import { CannotRebuild, loadSite, renderFromSite, withNoindex } from './live-render.js';

export { CannotRebuild, VERSION };

const dec = new TextDecoder('utf-8');
const SEEN = 'webcli-checked:';

// "1.4.0" vs "1.10.0": a missing or odd part counts as 0
export function compareVersions(a, b) {
  const n = (v) => String(v || '').split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}

// "blog-webcli@0.2.0" -> "0.2.0"
export const versionOf = (generator) => (/@([\w.+-]+)$/.exec(generator || '') || [])[1] || '';

// Asking for the same address twice gets the same cached answer, and the host this is read from may keep one
// for minutes: the query string does not help (GitHub's raw host leaves it out of its cache key, and ignores a
// no-cache request header), but the path does. "posts/x.md" and "%70osts/x.md" name the same file (RFC 3986: a
// percent-encoded unreserved character means the same as the character) yet are different keys, so choosing
// the encoding at random makes most requests miss the cache and read the file as it is now. A request that
// happens to repeat a recent one is as stale as that cache, never staler. Letters, digits and "-" only: not "."
// or "/", which a server may treat as structure.
export function varyPath(path, rand = randomUnit) {
  return path.replace(/[A-Za-z0-9-]/g, (c) => (rand() < 0.5 ? `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}` : c));
}

function randomUnit() {
  const c = globalThis.crypto;
  if (c && c.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  return Math.random();
}

// A plain, credential-free GET of one file of the live copy: no API, no headers of ours, no cookies.
export function makeGetter(base, fetchFn, { now = Date.now, signal, rand = randomUnit } = {}) {
  return async (path) => {
    const url = `${base}${varyPath(path, rand)}?t=${now()}`;
    const res = await fetchFn(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

// ---- a post page that exists ----
// -> { state, html?, why? } with state one of:
//    'skipped'   already checked in this session
//    'current'   the page shows the live markdown
//    'rebuilt'   it did not; html is the page as the next build will write it
//    'left'      it could not be checked or rebuilt; the page stays as the build wrote it
export async function checkPage({ base, slug, builtSha, pageGenerator = '', get, storage }) {
  const seenKey = `${SEEN}${base}${slug}`;
  try {
    if (storage && storage.getItem(seenKey)) return { state: 'skipped' };
    if (storage) storage.setItem(seenKey, '1'); // before the request: a failing network is not asked again either
  } catch {
    /* storage may be blocked; the check still runs */
  }
  let bytes;
  try {
    bytes = await get(`posts/${slug}.md`);
  } catch (e) {
    return { state: 'left', why: `unreachable: ${e.message}` };
  }
  if (!bytes) return { state: 'left', why: 'the live copy has no such post' };
  if (sha256Bytes(bytes) === builtSha) return { state: 'current' };
  if (pageGenerator && compareVersions(VERSION, versionOf(pageGenerator)) < 0) {
    return { state: 'left', why: `this script is ${VERSION} but the page was built by ${versionOf(pageGenerator)}` };
  }
  try {
    const out = renderFromSite(await loadSite(get), { slug, text: dec.decode(bytes) });
    if (!out.published) return { state: 'left', why: 'the live post is not published' };
    return { state: 'rebuilt', html: out.html };
  } catch (e) {
    if (e instanceof CannotRebuild) return { state: 'left', why: e.message };
    return { state: 'left', why: `unreachable: ${e.message}` };
  }
}

// ---- 404.html ----

// Which post is this path asking for? Exactly /<root>/<slug>, /<root>/<slug>/ or /<root>/<slug>/index.html.
export function slugFromPath(pathname, root = '') {
  let p = pathname;
  if (root && (p === root || p.startsWith(`${root}/`))) p = p.slice(root.length);
  else if (root) return null;
  const m = /^\/([^/]+)(?:\/(?:index\.html)?)?$/.exec(p);
  return m && SLUG_RE.test(m[1]) ? m[1] : null;
}

// -> { state, html?, why? }:
//    'rebuilt'   the post is published in the live copy; html is its page, marked noindex
//    'missing'   no such post (or a draft: a draft is not-found here exactly as in the generated site)
//    'pending'   it is published but cannot be rebuilt here yet; the not-found page should say it is coming
export async function checkMissing({ pathname, root = '', get }) {
  const slug = slugFromPath(pathname, root);
  if (!slug) return { state: 'missing' };
  let index;
  try {
    index = await readIndex(async (p) => {
      const bytes = await get(p);
      return bytes ? dec.decode(bytes) : null;
    });
  } catch (e) {
    return { state: 'missing', why: `unreachable: ${e.message}` };
  }
  const entry = index && Array.isArray(index.posts) ? index.posts.find((e) => e && e.slug === slug) : null;
  if (!entry || entry.status !== 'published') return { state: 'missing' };
  try {
    const bytes = await get(`posts/${slug}.md`);
    if (!bytes) return { state: 'missing' };
    const out = renderFromSite(await loadSite(get, { index }), { slug, text: dec.decode(bytes) });
    if (!out.published) return { state: 'missing' }; // the file says draft, whatever the index says
    return { state: 'rebuilt', slug, html: withNoindex(out.html) };
  } catch (e) {
    return { state: 'pending', why: e instanceof CannotRebuild ? e.message : `unreachable: ${e.message}` };
  }
}

// ---- the page ----

const metaContent = (doc, name) => {
  const m = doc.querySelector(`meta[name="${name}"]`);
  return m ? m.getAttribute('content') : '';
};

// Replace this page with `html`, keeping the script that is running.
export function swapIn(doc, html) {
  const next = new DOMParser().parseFromString(html, 'text/html');
  const running = [...doc.scripts].find((s) => /webcli-live\.js(\?|$)/.test(s.getAttribute('src') || ''));
  doc.title = next.title;
  for (const el of [...doc.head.children]) if (el.tagName !== 'SCRIPT') el.remove();
  for (const el of [...next.head.children]) if (el.tagName !== 'SCRIPT') doc.head.append(doc.importNode(el, true));
  doc.body.className = next.body.className;
  const kept = [...next.body.childNodes].filter((n) => n.nodeName !== 'SCRIPT').map((n) => doc.importNode(n, true));
  doc.body.replaceChildren(...kept, ...(running ? [running] : []));
}

const mark = (doc, state, why = '') => {
  doc.documentElement.dataset.webcliLive = state;
  if (why) doc.documentElement.dataset.webcliWhy = why;
};

export async function run({ doc = document, fetchFn = fetch.bind(globalThis), storage = null, location = globalThis.location } = {}) {
  const base = metaContent(doc, 'x-content-base');
  const kind = metaContent(doc, 'x-webcli-page');
  if (!base || !kind) return mark(doc, 'off');
  const pageGenerator = metaContent(doc, 'x-generator');
  if (pageGenerator && versionOf(pageGenerator) !== VERSION) {
    // recorded, never silent: a page and the code that rebuilds it should come from one build
    doc.documentElement.dataset.webcliVersions = `page ${versionOf(pageGenerator)}, script ${VERSION}`;
    console.warn(`blog-webcli: this page was built by ${pageGenerator}, the script is ${VERSION}`);
  }
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl && setTimeout(() => ctl.abort(), 10000);
  const get = makeGetter(base, fetchFn, { signal: ctl && ctl.signal });
  try {
    if (kind === 'post') {
      const out = await checkPage({ base, slug: metaContent(doc, 'x-webcli-slug'), builtSha: metaContent(doc, 'x-content-sha256'), pageGenerator, get, storage });
      if (out.state === 'rebuilt') swapIn(doc, out.html);
      return mark(doc, out.state, out.why);
    }
    if (kind === '404') {
      const out = await checkMissing({ pathname: location.pathname, root: metaContent(doc, 'x-webcli-root'), get });
      if (out.state === 'rebuilt') swapIn(doc, out.html);
      else if (out.state === 'pending') {
        const note = doc.querySelector('[data-webcli-notfound]');
        if (note) note.textContent = 'This post was published a moment ago and its page is still being deployed. Try again in a minute.';
      }
      return mark(doc, out.state, out.why);
    }
    return mark(doc, 'off');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

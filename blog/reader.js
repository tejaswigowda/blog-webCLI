// The /blog/ reader: takes a blog from the URL hash and shows it, styled by blog.json.
// Read-only and anonymous. If the blog cannot be loaded it points at the static site.
import { createNet, fmtBytes } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { NotFound, loadIndexFull, loadPost } from '../app/read.js';
import { hashFor, isTrustedHost, normalizeBlogUrl, openBlog, parseReaderHash, staticAddress, staticPostUrl } from '../app/reader-core.js';
import { indexBody, indexList, postBody } from '../lib/contracts.js';
import { neighbours } from '../lib/order.js';
import { READER_SORTS, readerSort, saveSort, savedSort } from '../lib/sort.js';
import { escapeHtml as esc } from '../lib/html.js';
import { resolveLogo, themeCss } from '../lib/customize.js';
import { checkPublishedCss } from '../lib/theme-pack.js';
import { at } from '../lib/reporef.js';
import { resolveAsset } from '../lib/assets.js';
import { THEMES } from '../lib/theme.js';
import { loadSite } from '../lib/live-render.js';
import { fileFor, previewHtml, sourceOf } from '../lib/preview.js';
import { withRepoOverrides } from '../lib/blog.js';
import { Refusal } from '../lib/errors.js';
import { parseRepoRef } from '../lib/reporef.js';

const net = createNet();
const gh = new GitHub(net); // anonymous on purpose: a reader holds no token
const page = document.getElementById('reader');
const tools = document.getElementById('tools');
const theme = document.getElementById('theme');
theme.textContent = THEMES.default;

net.subscribe((l) => {
  const el = document.getElementById('ledger');
  el.innerHTML = `Egress — uploaded <span class="zero">${fmtBytes(l.uploaded.bytes)}</span> · read ${fmtBytes(l.read.bytes)} in ${l.read.requests} request${l.read.requests === 1 ? '' : 's'}`;
});

const notice = (html, warn = false) => `<div class="notice${warn ? ' warn' : ''}">${html}</div>`;
const q = (el, s) => el.querySelector(s);

function home() {
  page.innerHTML = `<h1>Read a blog</h1>
<p>Open any blog that lives in a GitHub repository.</p>
<form class="readerform"><input name="repo" placeholder="owner/repo or owner/repo/folder" aria-label="Repository"><button>Open</button></form>
<p class="meta">Address form: <code>/blog/#repo=owner/repo</code>, or <code>owner/repo/folder</code> when the blog lives in a folder. Optional: <code>&amp;post=slug</code>, <code>&amp;images=…</code>, <code>&amp;video=…</code>, <code>&amp;audio=…</code> to name media repositories, and <code>&amp;blog=https://…</code> for the blog's own site.</p>`;
  q(page, 'form').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#repo=${q(page, 'input').value.trim()}`;
  });
}

function openStatic(url) {
  const host = new URL(url).host;
  if (isTrustedHost(url)) {
    page.innerHTML = notice(`Opening <a href="${esc(url)}">${esc(url)}</a>…`);
    location.replace(url);
    return;
  }
  page.innerHTML = notice(`<b>This link points to another site</b><p>It leads to ${esc(host)}, which this reader cannot vouch for.</p><p><a href="${esc(url)}" rel="noopener noreferrer">Continue to ${esc(url)}</a></p>`);
}

// The failsafe: the blog could not be read here, so point at the site it publishes.
function failsafe(parsed, blog, error) {
  let found;
  try {
    found = staticAddress({ blogUrl: parsed.blogUrl, blog, repo: parsed.repo });
  } catch (e) {
    found = { base: null, certain: false, error: e };
  }
  const why = error instanceof Refusal ? `Refused: ${error.code}. ${error.detail}` : error.message || String(error);
  const target = found.base ? (parsed.post ? staticPostUrl(found.base, parsed.post) : `${found.base}/`) : null;
  page.innerHTML = notice(
    `<b>This blog could not be loaded from GitHub.</b><p>${esc(why)}</p>${
      target
        ? `<p>It may be readable on its own site: <a href="${esc(target)}" rel="noopener noreferrer">${esc(target)}</a>${found.certain ? '' : ' (the usual GitHub Pages address for this repository; it may not exist)'}.</p>`
        : `<p>${esc(found.error.message)}</p>`
    }<p><a href="${esc(hashFor(parsed, { post: parsed.post }))}" id="retry">Try again</a></p>`,
    true,
  );
  q(page, '#retry').addEventListener('click', (e) => {
    e.preventDefault();
    route();
  });
}

// ---- the preview: the page the published site serves, made by the code that makes it (lib/preview.js) ----
// The reader takes what that page is made of (its stylesheet and its body) and shows it here, with the links of the site
// pointed at this reader. Nothing of its own is added to the page: the sort and the "static page" link sit below it.
const enc = new TextEncoder();
const LISTING_ROOTS = new Set(['tags', 'authors', 'archive', 'search', 'page']);
const domainRoot = (blog) => new URL(blog.domain).pathname.replace(/\/+$/, '');

function retarget(doc, { parsed, blog, file }) {
  const home = new URL(blog.domain);
  const dir = file.replace(/index\.html$/, '');
  const here = new URL(`${home.origin}${domainRoot(blog)}/${dir}`);
  for (const a of doc.body.querySelectorAll('a[href]')) {
    const raw = a.getAttribute('href');
    if (raw.startsWith('#')) continue;
    let u;
    try {
      u = new URL(raw, here);
    } catch {
      continue;
    }
    const root = domainRoot(blog);
    if (u.origin !== home.origin || !(u.pathname === root || u.pathname.startsWith(`${root}/`))) continue; // another site: as written
    const p = u.pathname.slice(root.length) || '/';
    const isPage = (p.endsWith('/') || p.endsWith('/index.html')) && !p.startsWith('/search/');
    // a page of the blog opens here; a file (the feed, the search page, which needs its own script) opens where it is published
    const segs = p.replace(/index\.html$/, '').split('/').filter(Boolean);
    // a post or a standalone page keeps the address the reader has always had (&post=slug); the listing pages have a path
    const href = !isPage ? `${home.origin}${root}${p}${u.search}${u.hash}` : segs.length === 1 && !LISTING_ROOTS.has(segs[0]) ? hashFor(parsed, { post: segs[0] }) : hashFor(parsed, { path: segs.join('/') + (segs.length ? '/' : '') });
    a.setAttribute('href', href);
  }
  // the reader may post nowhere (its policy says form-action 'none'): a comment or subscribe form is a pointer to the published page, which can
  for (const f of doc.body.querySelectorAll('form')) {
    const note = doc.createElement('p');
    note.className = 'meta';
    const link = doc.createElement('a');
    link.setAttribute('href', here.href);
    link.setAttribute('rel', 'noopener noreferrer');
    link.textContent = 'published page';
    note.append(`${f.classList.contains('comment-form') ? 'To leave a comment' : 'To use this form'}, go to the `, link, '.');
    f.replaceWith(note);
  }
}

function showPreview(html, ctx, css = '') {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const style = doc.querySelector('head style');
  theme.textContent = style ? style.textContent : css; // a linked stylesheet is not in the page: the preview has its text
  for (const s of doc.querySelectorAll('script')) s.remove(); // a page of the site loads its own scripts; the reader runs none of them
  retarget(doc, ctx);
  document.body.className = doc.body.className;
  document.title = doc.title;
  page.innerHTML = doc.body.innerHTML;
}

// true when the page was shown; throws when the blog has no generated site to preview (the caller falls back to the source)
async function preview(parsed, mine) {
  const repo = parseRepoRef(parsed.repo).ref;
  const { repo: plain, folder } = parseRepoRef(repo);
  const get = async (p) => {
    const t = await gh.readText(plain, at(folder, p), parsed.ref);
    return t === null ? null : enc.encode(t);
  };
  const loaded = await loadSite(get, { anyBlog: true });
  const site = { ...loaded, blog: withRepoOverrides(loaded.blog, parsed) }; // the address may point the media elsewhere
  const blog = site.blog;
  // &post=<slug> is the post's id; where it lives is the index's business (a dated permalink puts it at 2024/05/<slug>)
  const named = parsed.post ? site.index.posts.find((e) => e.slug === parsed.post) : null;
  const file = fileFor(parsed.post ? `${(named && named.path) || parsed.post}/` : parsed.path || '');
  const source = sourceOf(site, file);
  const text = source ? await gh.readText(plain, at(folder, source), parsed.ref) : null;
  if (mine !== seq) return true;
  const commentsFile = source && /^posts\//.test(source) ? await gh.readText(plain, at(folder, `comments/${source.replace(/^posts\//, '').replace(/\.md$/, '')}.json`), parsed.ref) : null;
  const out = previewHtml(site, file, { text, comments: commentsFile });
  if (mine !== seq) return true;
  const ctx = { parsed, blog, file };
  showPreview(out.html, ctx, out.css);
  if (out.redirect) {
    // an old address: the page says "moved", and its link is already the reader's own address for the post
    const to = document.querySelector('#reader a[href^="#"]');
    if (to) location.replace(to.getAttribute('href'));
    return true;
  }
  const staticUrl = `${blog.domain}/${file.replace(/index\.html$/, '')}`;
  const isIndex = file === 'index.html';
  const draw = (mode) => {
    const picker = isIndex && site.index.posts.length > 1
      ? `<label class="sortbar">Sort <select id="reader-sort" aria-label="Sort posts">${READER_SORTS.map(([k, label]) => `<option value="${esc(k)}"${k === mode ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label> `
      : '';
    tools.innerHTML = `${picker}${out.status === 404 ? '<span class="meta">The published site has no page at this address; this is what it shows. </span>' : ''}<a href="${esc(staticUrl)}" rel="noopener noreferrer">${out.status === 404 ? 'Site' : 'Published page'} ↗</a>`;
    const select = document.getElementById('reader-sort');
    if (select) select.addEventListener('change', () => { saveSort(sessionStorage, repo, select.value); show(select.value); });
  };
  // a reader's own order lists every post in one list; previous/next and every address stay as the blog has them
  const show = (mode) => {
    const sorted = mode === 'order' ? out : previewHtml(site, 'index.html', { text: null, entries: readerSort(site.index.posts, mode), size: 0 });
    showPreview(sorted.html, ctx, sorted.css);
    draw(mode);
  };
  if (isIndex) show(savedSort(sessionStorage, repo));
  else draw('order');
  return true;
}

// a link to a place in the page itself ("#y2026") is not a route
page.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href^="#"]');
  if (!a || a.getAttribute('href').startsWith('#repo=')) return;
  e.preventDefault();
  const el = document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)));
  if (el) el.scrollIntoView();
});

let seq = 0;
async function route() {
  const mine = ++seq;
  const parsed = parseReaderHash(location.hash);
  document.title = 'blog.webcli.app/blog';
  tools.innerHTML = '';
  document.body.className = '';
  theme.textContent = THEMES.default;
  if (!parsed.repo && !parsed.blogUrl) return home();
  if (!parsed.repo) {
    try {
      return openStatic(normalizeBlogUrl(parsed.blogUrl));
    } catch (e) {
      page.innerHTML = notice(`<b>${esc(e.message)}</b>`, true);
      return;
    }
  }
  page.innerHTML = '<div class="loading" role="status"><span class="spin" aria-hidden="true"></span><span>Loading the blog…</span></div>';
  tools.innerHTML = '';
  let blog = null;
  // the published site's own page, made by the code that makes it; a blog with no generated site yet is read from its source
  let unbuilt = '';
  try {
    if (await preview(parsed, mine)) return;
  } catch (e) {
    if (mine !== seq) return;
    unbuilt = e && e.reason ? e.reason : '';
  }
  try {
    const ctx = await openBlog(gh, parsed);
    blog = ctx.blog;
    if (mine !== seq) return;
    const repo = parseRepoRef(parsed.repo).ref;
    const contract = (blog.theme && typeof blog.theme === 'object' && blog.theme.contract) || 'blog-webcli-v1';
    let themeNote = unbuilt ? notice(`This blog has no generated site yet (${esc(unbuilt)}), so this is its source drawn by the reader. Publish it from the editor and this shows the page the site serves.`, true) : '';
    theme.textContent = themeCss(blog);
    if (blog.theme && typeof blog.theme === 'object') {
      // The blog's own committed copy of its theme (data in the blog's repository). The reader never
      // fetches a theme repository and runs nothing; the css is checked before it is applied.
      try {
        const { repo: plain, folder } = parseRepoRef(repo);
        const css = await gh.readText(plain, at(folder, 'theme.css'), parsed.ref);
        if (css === null) throw new Error('the blog has not published its theme.css yet');
        theme.textContent = checkPublishedCss(css);
      } catch (e) {
        themeNote = notice(`The theme could not be applied (${esc(e.detail || e.message)}); showing the default style.`, true);
      }
    }
    const linkHome = hashFor(parsed);
    let logoUrl = null;
    try {
      logoUrl = resolveLogo(blog, ctx.lock);
    } catch {
      /* an unresolved logo is simply not shown */
    }
    const chrome = { blog, home: linkHome, feed: `${blog.domain}/feed.xml`, logoUrl };
    const show = (b) => {
      document.body.className = b.bodyClass;
      page.innerHTML = themeNote + b.html;
    };

    if (parsed.post) {
      let loaded;
      try {
        loaded = await loadPost(gh, repo, parsed.post, parsed.ref, ctx);
      } catch (e) {
        if (!(e instanceof NotFound)) throw e;
        if (mine === seq) show(indexBody(contract, { ...chrome, entries: [], hrefFor: () => linkHome, indexHtml: notice(`No such post. <a href="${esc(linkHome)}">Back to ${esc(blog.title)}</a>`) }));
        return;
      }
      if (mine !== seq) return;
      let coverUrl = null;
      try {
        if (loaded.post.meta.cover && loaded.post.meta.cover !== 'auto') coverUrl = resolveAsset(loaded.post.meta.cover, blog, ctx.lock); // an automatic cover is the share preview, not drawn
      } catch {
        /* an unresolved cover is simply not shown */
      }
      document.title = `${loaded.post.meta.title} · ${blog.title}`;
      const footerExtra = [
        `<a href="${esc(linkHome)}">← ${esc(blog.title)}</a>`,
        `<a href="../#repo=${esc(repo)}&amp;correct=${esc(parsed.post)}" rel="nofollow">Suggest a correction</a>`,
        `<a href="${esc(staticPostUrl(blog.domain, parsed.post))}" rel="noopener noreferrer">Static page</a>`,
      ].join(' · ');
      // previous / next follow the blog's own order, as the index records it; a reader's sort never touches them
      let navLinks = null;
      try {
        const idx = await loadIndexFull(gh, repo, parsed.ref, { blog });
        navLinks = neighbours(idx.sequence, parsed.post, new Map(idx.posts.map((e) => [e.slug, e.title])), (slug) => hashFor(parsed, { post: slug }));
      } catch {
        /* without the index there is simply no previous/next */
      }
      show(postBody(contract, { ...chrome, meta: loaded.post.meta, bodyHtml: loaded.html, coverUrl, footerExtra, nav: navLinks }));
      return;
    }

    const { posts: entries } = await loadIndexFull(gh, repo, parsed.ref, { blog });
    if (mine !== seq) return;
    document.title = blog.title;
    // The blog's own order is the start; a reader may sort the list for themselves. That changes this list and
    // nothing else: the address stays as it is, and previous/next on a post do not move.
    const draw = (mode) => {
      const options = READER_SORTS.map(([k, label]) => `<option value="${esc(k)}"${k === mode ? ' selected' : ''}>${esc(label)}</option>`).join('');
      // a classic theme keeps the content in a column through its own width classes; the bar needs the same
      const bar = entries.length > 1 ? `<label class="sortbar${contract === 'wordpress-classic' ? ' default-max-width' : ''}">Sort <select id="reader-sort" aria-label="Sort posts">${options}</select></label>` : '';
      const list = entries.length ? bar + indexList(contract, { blog, entries: readerSort(entries, mode), hrefFor: (slug) => hashFor(parsed, { post: slug }) }) : '<p class="meta">No published posts yet.</p>';
      show(indexBody(contract, { ...chrome, entries, hrefFor: (slug) => hashFor(parsed, { post: slug }), indexHtml: list }));
      const picker = document.getElementById('reader-sort');
      if (picker) picker.addEventListener('change', () => { saveSort(sessionStorage, repo, picker.value); draw(picker.value); });
    };
    draw(savedSort(sessionStorage, repo));
  } catch (e) {
    if (mine === seq) failsafe(parsed, blog, e);
  }
}

addEventListener('hashchange', route);
route();

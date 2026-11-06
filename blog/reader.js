// The /blog/ reader: takes a blog from the URL hash and shows it, styled by blog.json.
// Read-only and anonymous. If the blog cannot be loaded it points at the static site.
import { createNet, fmtBytes } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { NotFound, loadIndex, loadPost } from '../app/read.js';
import { hashFor, isTrustedHost, normalizeBlogUrl, openBlog, parseReaderHash, staticAddress, staticPostUrl } from '../app/reader-core.js';
import { indexBody, postBody } from '../lib/contracts.js';
import { escapeHtml as esc } from '../lib/html.js';
import { resolveLogo, themeCss } from '../lib/customize.js';
import { checkPublishedCss } from '../lib/theme-pack.js';
import { at } from '../lib/reporef.js';
import { resolveAsset } from '../lib/assets.js';
import { THEMES } from '../lib/theme.js';
import { Refusal } from '../lib/errors.js';
import { parseRepoRef } from '../lib/reporef.js';

const net = createNet();
const gh = new GitHub(net); // anonymous on purpose: a reader holds no token
const page = document.getElementById('reader');
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

let seq = 0;
async function route() {
  const mine = ++seq;
  const parsed = parseReaderHash(location.hash);
  document.title = 'blog.webcli.app/blog';
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
  page.innerHTML = '<p class="notice">Loading…</p>';
  let blog = null;
  try {
    const ctx = await openBlog(gh, parsed);
    blog = ctx.blog;
    if (mine !== seq) return;
    const repo = parseRepoRef(parsed.repo).ref;
    const contract = (blog.theme && typeof blog.theme === 'object' && blog.theme.contract) || 'blog-webcli-v1';
    let themeNote = '';
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
      show(postBody(contract, { ...chrome, meta: loaded.post.meta, bodyHtml: loaded.html, coverUrl, footerExtra }));
      return;
    }

    const entries = await loadIndex(gh, repo, parsed.ref);
    if (mine !== seq) return;
    document.title = blog.title;
    show(indexBody(contract, { ...chrome, entries, hrefFor: (slug) => hashFor(parsed, { post: slug }), indexHtml: entries.length ? undefined : '<p class="meta">No published posts yet.</p>' }));
  } catch (e) {
    if (mine === seq) failsafe(parsed, blog, e);
  }
}

addEventListener('hashchange', route);
route();

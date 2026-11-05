// The /blog/ reader: takes a blog from the URL hash and shows it, styled by blog.json.
// Read-only and anonymous. If the blog cannot be loaded it points at the static site.
import { createNet, fmtBytes } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { NotFound, loadIndex, loadPost } from '../app/site.js';
import { hashFor, isTrustedHost, normalizeBlogUrl, openBlog, parseReaderHash, staticAddress, staticPostUrl } from '../app/reader-core.js';
import { postArticle, postList, siteFooter, siteHeader } from '../lib/page.js';
import { escapeHtml as esc } from '../lib/html.js';
import { resolveLogo, themeCss } from '../lib/customize.js';
import { resolveAsset } from '../lib/assets.js';
import { THEMES } from '../lib/theme.js';
import { Refusal } from '../lib/errors.js';
import { parseRepoRef } from '../lib/reporef.js';

const net = createNet();
const gh = new GitHub(net); // anonymous on purpose: a reader holds no token
const page = document.getElementById('page');
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
    theme.textContent = themeCss(blog);
    const repo = parseRepoRef(parsed.repo).ref;
    const linkHome = hashFor(parsed);
    let logoUrl = null;
    try {
      logoUrl = resolveLogo(blog, ctx.lock);
    } catch {
      /* an unresolved logo is simply not shown */
    }
    const header = siteHeader(blog, { home: linkHome, feed: `${blog.domain}/feed.xml`, logoUrl });

    if (parsed.post) {
      let loaded;
      try {
        loaded = await loadPost(gh, repo, parsed.post, parsed.ref, ctx);
      } catch (e) {
        if (!(e instanceof NotFound)) throw e;
        if (mine === seq) page.innerHTML = `${header}${notice(`No such post. <a href="${esc(linkHome)}">Back to ${esc(blog.title)}</a>`)}${siteFooter(blog)}`;
        return;
      }
      if (mine !== seq) return;
      let coverUrl = null;
      try {
        if (loaded.post.meta.cover) coverUrl = resolveAsset(loaded.post.meta.cover, blog, ctx.lock);
      } catch {
        /* an unresolved cover is simply not shown */
      }
      document.title = `${loaded.post.meta.title} · ${blog.title}`;
      const extra = [
        `<a href="${esc(linkHome)}">← ${esc(blog.title)}</a>`,
        `<a href="../#repo=${esc(repo)}&amp;correct=${esc(parsed.post)}" rel="nofollow">Suggest a correction</a>`,
        `<a href="${esc(staticPostUrl(blog.domain, parsed.post))}" rel="noopener noreferrer">Static page</a>`,
      ].join(' · ');
      page.innerHTML = `${header}${postArticle({ blog, meta: loaded.post.meta, bodyHtml: loaded.html, coverUrl })}${siteFooter(blog, extra)}`;
      return;
    }

    const entries = await loadIndex(gh, repo, parsed.ref);
    if (mine !== seq) return;
    document.title = blog.title;
    page.innerHTML = `${header}<h1>${esc(blog.title)}</h1><p class="meta">${esc(blog.description)}</p>${entries.length ? postList(entries, blog, (slug) => hashFor(parsed, { post: slug })) : '<p class="meta">No published posts yet.</p>'}${siteFooter(blog)}`;
  } catch (e) {
    if (mine === seq) failsafe(parsed, blog, e);
  }
}

addEventListener('hashchange', route);
route();

import { createNet, fmtBytes } from './net.js';
import { GitHub, assertToken } from './github.js';
import { NotFound, describePlan, executePlan, listPostFiles, listVideoReleases, loadBlog, loadIndex, loadPost, parseRepo, planChange, planInit } from './site.js';
import { createEditor, setAssetResolver, setVideoResolver } from './editor.js';
import { Refusal } from '../lib/errors.js';
import { mdToDelta, deltaToMarkdownChecked } from '../lib/markdown.js';
import { SLUG_RE, joinFile, newFront, parseMeta, setMeta, splitFile } from '../lib/frontmatter.js';
import { parsePost } from '../lib/blog.js';
import { resolveAsset } from '../lib/assets.js';
import { videoEmbedUrl } from '../lib/video.js';
import { at, parseRepoRef } from '../lib/reporef.js';
import { defaultDomain, defaultTitle } from '../lib/init.js';

const net = createNet();
const KEY = 'blog.webcli.token';
const gh = new GitHub(net, { token: sessionStorage.getItem(KEY) || localStorage.getItem(KEY) });
let login = null;
let cache = null; // { repo, ref, blog, lock }

const $ = (s) => document.querySelector(s);
const view = $('#view');

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

function errBox(e) {
  if (e instanceof Refusal) return h('div', { class: 'err' }, h('b', {}, `Refused: ${e.code}`), e.detail);
  return h('div', { class: 'err' }, h('b', {}, 'Something went wrong'), e.message || String(e));
}

// ---------- chrome ----------

const parseHash = () => {
  const p = new URLSearchParams(location.hash.slice(1));
  const mode = p.has('new') ? 'new' : p.has('correct') ? 'correct' : p.has('edit') ? 'edit' : null;
  return { repo: p.get('repo'), post: p.get('post') || p.get('edit') || p.get('correct'), ref: p.get('ref') || undefined, mode };
};
const link = (repo, extra = '') => `#repo=${repo}${extra}`;

function renderTop(repo) {
  const input = h('input', { name: 'repo', placeholder: 'owner/blog or owner/repo/folder', value: repo || '', 'aria-label': 'Repository' });
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); try { location.hash = link(parseRepo(input.value)); } catch (err) { view.replaceChildren(errBox(err)); } } }, input, h('button', {}, 'Open'));
  const auth = gh.token
    ? h('span', { class: 'muted' }, login ? `Signed in as ${login} · ` : 'Signed in · ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); signOut(); } }, 'Sign out'))
    : h('button', { type: 'button', onclick: () => signInDialog() }, 'Sign in to edit');
  $('#top').replaceChildren(h('a', { class: 'brand', href: '#' }, 'blog.webcli.app'), form, auth);
}

function renderLedger(l) {
  const zero = l.uploaded.bytes === 0;
  $('#ledger').replaceChildren(
    h(
      'details',
      {},
      h('summary', {}, 'Egress — uploaded ', h('span', { class: zero ? 'up-zero' : 'up-some' }, fmtBytes(l.uploaded.bytes)), ` · read ${fmtBytes(l.read.bytes)} in ${l.read.requests} request${l.read.requests === 1 ? '' : 's'}`),
      h('p', {}, 'Uploaded stays at 0 until you publish. Read counts listing and rendering. Bytes are counted as they cross the wire.'),
      h('ol', {}, l.log.slice(-30).map((e) => h('li', {}, `${e.method} ${e.url.replace('https://', '')} ↑${e.up} ↓${e.down} (${e.status})`))),
    ),
  );
}
net.subscribe(renderLedger);

function signOut() {
  sessionStorage.removeItem(KEY);
  localStorage.removeItem(KEY);
  gh.token = null;
  login = null;
  route();
}

function signInDialog() {
  const dlg = $('#dlg');
  const tok = h('input', { type: 'password', name: 'token', autocomplete: 'off', placeholder: 'github_pat_…', style: 'width:100%' });
  const remember = h('input', { type: 'checkbox' });
  const msg = h('div');
  dlg.replaceChildren(
    h('h2', {}, 'Sign in with a fine-grained token'),
    h('p', {}, 'Create a ', h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'fine-grained personal access token'), ' limited to your blog repository and your asset repositories, with ', h('b', {}, 'Contents: read & write'), ' and ', h('b', {}, 'Pull requests: write'), '. Classic tokens are refused: they can write to every repository you own.'),
    tok,
    h('p', {}, h('label', {}, remember, ' Remember on this device (localStorage). Otherwise the token lives only for this tab.')),
    msg,
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: async () => {
      try {
        const t = tok.value.trim();
        assertToken(t);
        gh.token = t;
        login = (await gh.whoami()).login;
        (remember.checked ? localStorage : sessionStorage).setItem(KEY, t);
        dlg.close();
        route();
      } catch (e) {
        gh.token = null;
        msg.replaceChildren(errBox(e.status === 401 ? new Error('GitHub rejected that token.') : e));
      }
    } }, 'Sign in'), h('button', { onclick: () => dlg.close() }, 'Cancel')),
  );
  dlg.showModal();
}

// ---------- routing ----------

let seq = 0;
async function route() {
  const mine = ++seq;
  const r = parseHash();
  renderTop(r.repo);
  renderLedger(net.ledger);
  document.title = 'blog.webcli.app';
  view.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try {
    if (!r.repo) return home();
    const repo = parseRepo(r.repo);
    if (gh.token && !login) gh.whoami().then((u) => { login = u.login; renderTop(r.repo); }, () => {});
    if (!cache || cache.repo !== repo || cache.ref !== r.ref) cache = { repo, ref: r.ref, ...(await loadBlog(gh, repo, r.ref)) };
    if (mine !== seq) return;
    let node;
    if (r.mode === 'new' || r.mode === 'edit' || r.mode === 'correct') node = await editorView(repo, r);
    else if (r.post) node = await postView(repo, r);
    else node = await listView(repo, r);
    if (mine === seq && node) view.replaceChildren(node);
  } catch (e) {
    if (mine !== seq) return;
    if (e instanceof Refusal && e.code === 'no-blog-json') {
      const node = await createBlogView(parseRepo(r.repo), r).catch((err) => errBox(err));
      if (mine === seq) view.replaceChildren(node);
      return;
    }
    view.replaceChildren(e instanceof NotFound ? h('p', {}, 'No such post. ', h('a', { href: link(r.repo) }, 'Back to the blog')) : errBox(e));
  }
}

function home() {
  view.replaceChildren(
    h('h1', {}, 'A blog is a GitHub repository'),
    h('p', {}, 'Open any blog with ', h('code', {}, '#repo=owner/blog'), ', or ', h('code', {}, '#repo=owner/repo/folder'), ' when the blog lives in a folder of a repository it shares with its images or videos. Posts are markdown with frontmatter, assets live in their own repositories or folders, and publishing commits the markdown and regenerates plain static pages, an index and a feed.'),
    h('p', { class: 'muted' }, 'Nothing is hosted here and nothing is uploaded until you publish. The egress ledger below counts every byte.'),
  );
}

const blogJsonHelp = () =>
  h('details', {}, h('summary', {}, 'What a blog repository needs'), h('pre', {}, JSON.stringify({ title: 'My Blog', description: 'What this is about', author: 'Me', domain: 'https://me.github.io/blog', repo: 'me/blog', assets: { base: 'https://cdn.jsdelivr.net/gh/{owner}/{repo}@{sha}/{path}', repos: { images: 'me/images' } } }, null, 2)));

// ---------- creating ----------

async function createBlogView(repo, r) {
  const { repo: plain, folder } = parseRepoRef(repo);
  const where = `${plain}${folder ? ` (folder ${folder}/)` : ''}`;
  const head = h('div', {}, h('h2', {}, 'No blog here yet'), h('p', {}, `${where} has no ${at(folder, 'blog.json')}.`));
  if (!gh.token) {
    head.append(h('p', {}, 'Sign in with a fine-grained token to create one.'), h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => signInDialog() }, 'Sign in')), blogJsonHelp());
    return head;
  }
  let info;
  try {
    info = await gh.repoInfo(plain);
  } catch (e) {
    if (e.status === 404) return h('div', {}, head, h('div', { class: 'err' }, `GitHub cannot show ${plain} to this token: it does not exist, or the token is not allowed to see it. Create the repository on GitHub first and include it in the token's repositories.`));
    throw e;
  }
  if (!(info.permissions && info.permissions.push)) return h('div', {}, head, h('div', { class: 'err' }, `This token cannot write to ${plain}.`));
  const branch = r.ref || info.default_branch;

  const f = {
    title: h('input', { value: defaultTitle(repo) }),
    description: h('input', { placeholder: 'What this blog is about' }),
    author: h('input', { value: login || '' }),
    domain: h('input', { value: defaultDomain(repo) }),
    images: h('input', { placeholder: 'optional: me/images or me/site/images' }),
    video: h('input', { placeholder: 'optional: me/renders (hls.webcli.app)' }),
  };
  const field = (label, el, hint) => h('div', {}, h('label', {}, label), el, hint ? h('div', { class: 'hint' }, hint) : null);
  const status = h('div');
  const go = h('button', { class: 'primary' }, 'Create blog…');
  go.addEventListener('click', async () => {
    go.disabled = true;
    status.replaceChildren();
    try {
      const fields = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
      const plan = await planInit(gh, { repo, branch, fields });
      if (!(await confirmPlan(plan))) return;
      const receipt = await executePlan(gh, plan);
      status.replaceChildren(receiptBox(receipt), h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => { cache = null; route(); } }, 'Open the blog')));
    } catch (e) {
      status.replaceChildren(errBox(e.status === 409 ? new Error(`${plain} is empty, and GitHub needs one commit before anything else can be written. Add a README on GitHub, then try again.`) : e));
    } finally {
      go.disabled = false;
    }
  });
  return h(
    'div',
    {},
    head,
    h('p', {}, 'Create it here: this commits a ', h('code', {}, 'blog.json'), ' and the generated site (index, feed) to ', h('b', {}, `${branch}`), '. Nothing is sent until you confirm.'),
    h('div', { class: 'row' }, field('Title', f.title), field('Author', f.author)),
    h('div', { class: 'row' }, field('Description', f.description)),
    h('div', { class: 'row' }, field('Address the blog is served at', f.domain, 'GitHub Pages address; used for links, the feed and og:url.')),
    h('div', { class: 'row' }, field('Images repository', f.images, 'owner/name, or owner/name/folder to share this repository.'), field('Video repository', f.video, 'Releases published with hls.webcli.app.')),
    h('div', { class: 'actions' }, go),
    status,
  );
}

// ---------- reading ----------

async function listView(repo, r) {
  const { blog } = cache;
  document.title = blog.title;
  const entries = await loadIndex(gh, repo, r.ref);
  const wrap = h('div', {}, h('h1', {}, blog.title), h('p', { class: 'muted' }, blog.description));
  if (gh.token) wrap.append(h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => (location.hash = link(repo, '&new')) }, 'New post'), h('button', { onclick: (e) => showDrafts(e.target, repo, r.ref, wrap) }, 'Show drafts')));
  wrap.append(
    h('ul', { class: 'posts' }, entries.map((e) => h('li', {}, h('h3', {}, h('a', { href: link(repo, `&post=${e.slug}${r.ref ? `&ref=${r.ref}` : ''}`) }, e.title)), h('div', { class: 'muted' }, e.date, (e.tags || []).map((t) => h('span', { class: 'tag' }, `#${t}`))), e.excerpt ? h('p', {}, e.excerpt) : null))),
  );
  if (!entries.length) wrap.append(h('p', { class: 'muted' }, 'No published posts yet.'));
  return wrap;
}

async function showDrafts(btn, repo, ref, wrap) {
  btn.disabled = true;
  const out = h('ul', { class: 'posts' });
  const { repo: slugRepo, folder } = parseRepoRef(repo);
  for (const n of await listPostFiles(gh, repo, ref)) {
    try {
      const m = parseMeta(splitFile(await gh.readText(slugRepo, at(folder, `posts/${n}`), ref), n).front, n);
      if (m.status === 'draft') out.append(h('li', {}, h('h3', {}, h('a', { href: link(repo, `&edit=${m.slug}`) }, `${m.title} (draft)`))));
    } catch {
      /* skip unreadable */
    }
  }
  wrap.append(h('h2', {}, 'Drafts'), out.children.length ? out : h('p', { class: 'muted' }, 'No drafts.'));
}

async function postView(repo, r) {
  const { blog } = cache;
  const { post, html } = await loadPost(gh, repo, r.post, r.ref, cache);
  document.title = `${post.meta.title} · ${blog.title}`;
  const body = h('article', { class: 'post' });
  body.innerHTML = html; // lib output: every text node escaped, URLs allow-listed
  return h(
    'div',
    {},
    h('p', {}, h('a', { href: link(repo) }, `← ${blog.title}`)),
    h('h1', {}, post.meta.title),
    h('p', { class: 'muted' }, post.meta.date, post.meta.author ? ` · ${post.meta.author}` : '', (post.meta.tags || []).map((t) => h('span', { class: 'tag' }, `#${t}`))),
    body,
    h('div', { class: 'actions' }, h('button', { onclick: () => (location.hash = link(repo, `&correct=${post.slug}`)) }, 'Suggest a correction'), gh.token ? h('button', { onclick: () => (location.hash = link(repo, `&edit=${post.slug}`)) }, 'Edit') : null),
  );
}

// ---------- editing ----------

const slugify = (t) => t.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);

async function editorView(repo, r) {
  if (!gh.token) {
    return h('div', {}, h('h2', {}, 'Sign in to edit'), h('p', {}, 'Editing commits to GitHub, so it needs a fine-grained token.'), h('button', { class: 'primary', onclick: () => signInDialog() }, 'Sign in'));
  }
  const { repo: plainRepo, folder } = parseRepoRef(repo);
  const info = await gh.repoInfo(plainRepo);
  const branch = r.ref || info.default_branch;
  const correcting = r.mode === 'correct';
  let isNew = r.mode === 'new';
  let existing = isNew ? null : await loadPost(gh, repo, r.post, branch, cache, { allowDraft: true });
  const { blog } = cache;
  const staged = new Map();
  const status = h('div');
  const canPush = !!(info.permissions && info.permissions.push);

  setAssetResolver((ref) => {
    const s = staged.get(ref.replace(/^asset:/, ''));
    if (s) return s.url;
    try {
      return resolveAsset(ref, blog, cache.lock);
    } catch {
      return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><text x="8" y="34" font-family="sans-serif" font-size="14" fill="#888">unresolved asset</text></svg>');
    }
  });

  const m = existing ? existing.post.meta : { status: 'draft', date: new Date().toISOString().slice(0, 10) };
  const f = {
    title: h('input', { value: m.title || '', placeholder: 'Title', disabled: correcting }),
    slug: h('input', { value: m.slug || '', placeholder: 'set once, never changes', disabled: !isNew }),
    date: h('input', { type: 'date', value: m.date, disabled: correcting }),
    tags: h('input', { value: (m.tags || []).join(', '), placeholder: 'video, git', disabled: correcting }),
    status: h('select', { disabled: correcting }, ['draft', 'published'].map((s) => h('option', { value: s, selected: s === m.status }, s))),
    cover: h('input', { value: m.cover || '', placeholder: 'asset:images/cover.png', disabled: correcting }),
    description: h('input', { value: m.description || '', placeholder: 'Optional; defaults to the first paragraph', disabled: correcting }),
  };
  setVideoResolver((ref) => {
    try {
      return videoEmbedUrl(ref, blog);
    } catch {
      return 'about:blank';
    }
  });
  let slugTouched = false;
  f.slug.addEventListener('input', () => (slugTouched = true));
  f.title.addEventListener('input', () => { if (isNew && !slugTouched) f.slug.value = slugify(f.title.value); });
  const field = (label, el) => h('div', {}, h('label', {}, label), el);
  const note = h('textarea', { rows: 2, placeholder: 'What did you correct, and why?', style: 'width:100%', 'aria-label': 'Correction note' });
  const go = h('button', { class: 'primary' }, correcting ? 'Propose correction (pull request)' : 'Publish');
  const refreshLabel = () => { if (!correcting) go.textContent = f.status.value === 'published' ? 'Publish' : 'Save draft'; };
  f.status.addEventListener('change', refreshLabel);
  refreshLabel();

  const editorEl = h('div', { id: 'editor' });
  const node = h(
    'div',
    {},
    h('p', {}, h('a', { href: existing ? link(repo, `&post=${existing.post.slug}`) : link(repo) }, '← Back')),
    h('h1', {}, correcting ? `Correct: ${m.title}` : isNew ? 'New post' : `Edit: ${m.title}`),
    h('div', { class: 'row' }, field('Title', f.title), field('Slug (the URL — never changes)', f.slug)),
    h('div', { class: 'row' }, field('Date', f.date), field('Tags', f.tags), field('Status', f.status)),
    h('div', { class: 'row' }, field('Cover', f.cover), field('Description', f.description)),
    editorEl,
    h('p', { class: 'hint' }, 'The toolbar offers only what markdown can express. Images are uploaded to the assets repository at publish time, not before.'),
    correcting ? h('div', {}, field('Note for the pull request', note), canPush ? null : h('div', { class: 'err' }, 'You do not have write access to this repository. ', h('a', { href: `https://github.com/${plainRepo}/edit/${branch}/${at(folder, `posts/${r.post}.md`)}`, target: '_blank', rel: 'noopener' }, 'Propose the change on GitHub instead'), ' — it forks and opens the pull request for you.')) : null,
    h('div', { class: 'actions' }, go),
    status,
  );
  // The Quill container must be in the document before Quill measures it.
  view.replaceChildren(node);
  const quill = await createEditor(editorEl, { onImage: () => pickImage(), onVideo: () => pickVideo() });
  quill.setContents(existing ? existing.post.delta.ops : mdToDelta('').ops, 'silent');
  go.disabled = correcting && !canPush;

  function pickImage() {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error('Images over 20 MB are not accepted; binaries should be reasonable.');
        const keys = Object.keys((blog.assets && blog.assets.repos) || {});
        if (!keys.length) throw new Error('blog.json has no assets.repos, so there is nowhere to put images.');
        const key = keys.includes('images') ? 'images' : keys[0];
        const bytes = new Uint8Array(await file.arrayBuffer());
        const name = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+/, '');
        const path = `${hex(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 10)}-${name}`;
        staged.set(`${key}/${path}`, { key, path, bytes, url: URL.createObjectURL(file) });
        const range = quill.getSelection(true);
        quill.insertEmbed(range.index, 'image', `asset:${key}/${path}`, 'user');
        quill.setSelection(range.index + 1);
        status.replaceChildren();
      } catch (e) {
        status.replaceChildren(errBox(e));
      }
    });
    input.click();
  }

  async function pickVideo() {
    try {
      if (!blog.video) throw new Error('blog.json has no "video" section, so there are no video repositories to embed from.');
      const releases = await listVideoReleases(gh, blog);
      const ref = await chooseVideo(releases, blog);
      if (!ref) return;
      const range = quill.getSelection(true);
      quill.insertEmbed(range.index, 'video', ref, 'user');
      quill.setSelection(range.index + 1);
      status.replaceChildren();
    } catch (e) {
      status.replaceChildren(errBox(e));
    }
  }

  function buildText() {
    const { md } = deltaToMarkdownChecked({ ops: quill.getContents().ops });
    const vals = {
      title: f.title.value.trim(),
      date: f.date.value,
      tags: f.tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      status: f.status.value,
      cover: f.cover.value.trim(),
      description: f.description.value.trim(),
    };
    const slug = existing ? existing.post.slug : f.slug.value.trim();
    if (!SLUG_RE.test(slug)) throw new Refusal('bad-frontmatter', `slug "${slug}" must be lowercase letters, digits and hyphens`);
    let front;
    if (existing) {
      front = existing.post.front;
      for (const k of Object.keys(vals)) {
        const was = existing.post.meta[k];
        if (JSON.stringify(empty(was) ? null : was) !== JSON.stringify(empty(vals[k]) ? null : vals[k])) front = setMeta(front, k, empty(vals[k]) ? null : vals[k]);
      }
    } else front = newFront({ slug, ...vals });
    return { slug, text: joinFile(front, md), md };
  }

  go.addEventListener('click', async () => {
    go.disabled = true;
    status.replaceChildren();
    try {
      const { slug, text, md } = buildText();
      const used = new Set([...text.matchAll(/asset:([^\s)\]]+)/g)].map((x) => x[1]));
      const plan = await planChange(gh, { repo, branch, slug, text, staged: [...staged.values()].filter((s) => used.has(`${s.key}/${s.path}`)), mode: correcting ? 'pr' : 'direct', create: isNew });
      if (!plan.changes.length && !plan.assetGroups.length) {
        status.replaceChildren(h('div', { class: 'ok' }, 'Nothing to publish: the repository already matches.'));
        return;
      }
      if (!(await confirmPlan(plan))) return;
      const receipt = await executePlan(gh, plan, { pullBody: note.value.trim() });
      status.replaceChildren(receiptBox(receipt));
      const path = `posts/${slug}.md`;
      existing = { post: parsePost({ path, text }) };
      isNew = false;
      f.slug.disabled = true;
      if (!correcting) {
        cache = null;
        cache = { repo, ref: r.ref, ...(await loadBlog(gh, repo, r.ref)) };
        staged.clear();
      }
      // What you see is what is stored.
      quill.setContents(mdToDelta(md).ops, 'silent');
      if (!correcting) history.replaceState(null, '', link(repo, `&edit=${slug}`));
    } catch (e) {
      status.replaceChildren(errBox(e));
    } finally {
      go.disabled = correcting && !canPush;
    }
  });
  return null;
}

function chooseVideo(releases, blog) {
  const dlg = $('#dlg');
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      resolve(v);
    };
    const repos = Object.values(blog.video.repos);
    const select = h('select', { size: Math.min(8, Math.max(2, releases.length)), style: 'width:100%' }, releases.map((r) => h('option', { value: r.ref }, `${r.slug} v${r.version}  ·  ${r.repo}`)));
    dlg.replaceChildren(
      h('h2', {}, 'Embed a video'),
      releases.length
        ? h('div', {}, h('p', { class: 'hint' }, 'Releases published with hls.webcli.app. The post stores a reference, not a URL; the player address comes from blog.json.'), select)
        : h('p', {}, 'No releases found in ', repos.join(', '), '. Publish a video with ', h('a', { href: `https://hls.webcli.app/#repo=${repos[0]}`, target: '_blank', rel: 'noopener' }, 'hls.webcli.app'), ' first; a release is a tag like ', h('code', {}, 'clip/v1'), '.'),
      h('div', { class: 'actions' }, releases.length ? h('button', { class: 'primary', onclick: () => select.value && done(select.value) }, 'Embed') : null, h('button', { onclick: () => done(null) }, 'Cancel')),
    );
    dlg.addEventListener('close', () => done(null), { once: true });
    dlg.showModal();
  });
}

function confirmPlan(plan) {
  const dlg = $('#dlg');
  return new Promise((resolve) => {
    let settled = false;
    const done = (answer) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      resolve(answer);
    };
    dlg.replaceChildren(
      h('h2', {}, 'Ready to send'),
      h('div', { class: 'preflight' }, describePlan(plan).map((l) => h('div', {}, l))),
      h('div', { class: 'files' }, [...plan.assetGroups.flatMap((g) => g.files.map((x) => ({ ...x, repo: g.repo }))), ...plan.changes.map((c) => ({ ...c, repo: plan.repo }))].map((c) => h('div', {}, `${c.action.padEnd(6)} ${c.repo}/${c.path}  ${fmtBytes(c.size)}`))),
      h('p', { class: 'hint' }, plan.mode === 'pr' ? 'This opens a pull request; the default branch is not changed.' : 'Nothing has been uploaded yet.'),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => done(true) }, plan.mode === 'pr' ? 'Open pull request' : 'Commit and push'), h('button', { onclick: () => done(false) }, 'Cancel')),
    );
    dlg.addEventListener('close', () => done(false), { once: true }); // Esc
    dlg.showModal();
  });
}

function receiptBox(receipt) {
  return h(
    'div',
    { class: 'ok' },
    h('b', {}, 'Sent.'),
    receipt.commits.map((c) => h('div', {}, `${c.files} file${c.files === 1 ? '' : 's'} → ${c.repo}@${c.branch} `, h('a', { href: c.url, target: '_blank', rel: 'noopener' }, c.sha.slice(0, 8)))),
    receipt.pull ? h('div', {}, 'Pull request: ', h('a', { href: receipt.pull.url, target: '_blank', rel: 'noopener' }, `#${receipt.pull.number}`)) : null,
  );
}

addEventListener('hashchange', route);
route();

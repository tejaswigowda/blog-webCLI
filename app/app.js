import { createNet, fmtBytes } from './net.js';
import { GitHub, assertToken } from './github.js';
import { NotFound, describePlan, detectAddress, executePlan, listPostFiles, listVideoReleases, loadBlog, loadIndex, loadPost, parseRepo, planChange, planExtension, planInit, planSettings, planTheme } from './site.js';
import { createSandbox } from './sandbox.js';
import { describeRelease, executeRelease, listReleaseFolders, planTagRelease, planUploadRelease, videoRepositories } from './release.js';
import { LIMITS } from '../lib/release.js';
import { insertionPoint } from '../lib/selection.js';
import { audioDecodable, encodeToRelease, estimateBytes, inspectUpload, nameProblem, slugFromFilename, webCodecsAvailable } from './encode.js';
import { licenceRecords } from '../lib/licences.js';
import { createEditor, setAssetResolver, setVideoResolver } from './editor.js';
import { Refusal } from '../lib/errors.js';
import { mdToDelta, deltaToMarkdownChecked } from '../lib/markdown.js';
import { SLUG_RE, joinFile, newFront, parseMeta, setMeta, splitFile } from '../lib/frontmatter.js';
import { parsePost } from '../lib/blog.js';
import { resolveAsset } from '../lib/assets.js';
import { videoBase, videoEmbedUrl } from '../lib/video.js';
import { at, parseRepoRef } from '../lib/reporef.js';
import { defaultDomain, defaultTitle } from '../lib/init.js';
import { FONTS, resolveLogo, themeCss } from '../lib/customize.js';
import { blogToForm, formToBlog } from '../lib/settings.js';
import { validateBlog } from '../lib/blog.js';
import { indexBody } from '../lib/contracts.js';
import { loadPinnedTheme } from './packs.js';

const net = createNet();
// Extensions run only here, at publish, in a sandbox that has no DOM, no network and no token.
let sandbox = null;
const runner = (job) => (sandbox ||= createSandbox()).runner(job);
const KEY = 'blog.webcli.token';
const gh = new GitHub(net, { token: sessionStorage.getItem(KEY) || localStorage.getItem(KEY) });
let login = null;
let cache = null; // { repo, ref, blog, lock }

const $ = (s) => document.querySelector(s);
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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

// The address a blog is served at is GitHub's to say (its Pages settings), so it is shown, never
// typed: a read-only field and what to do when GitHub says it is not served yet.
function addressView(repo, found, saved) {
  const input = h('input', { value: found && found.exact ? found.address : saved || (found && found.address) || defaultDomain(repo), readonly: true, 'aria-readonly': 'true' });
  const plain = parseRepoRef(repo).repo;
  const pagesLink = (found && found.settingsUrl) || `https://github.com/${plain}/settings/pages`;
  const ext = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  let note;
  if (!found) note = h('div', { class: 'hint' }, 'GitHub could not be asked just now. Used for links, the feed and og:url.');
  else if (found.exact) note = h('div', { class: 'hint' }, 'From this repository\'s GitHub Pages settings, so it is not edited here. To change it (a custom domain, HTTPS) ', ext(pagesLink, 'open the Pages settings'), '. Used for links, the feed and og:url.');
  else if (found.live) note = h('div', { class: 'hint' }, 'GitHub Pages is on, but this token cannot read its address, so the one saved in blog.json is shown. Give the token "Pages: Read-only" to have it read from GitHub.');
  else note = h('div', { class: 'err' }, h('b', {}, 'GitHub Pages is not enabled for this repository'), `Nothing is served at this address yet (${plain}). Turn it on under `, ext(pagesLink, 'Settings → Pages'), ' (Deploy from a branch → your default branch, / (root)). Until then the blog is readable at ', h('a', { href: `blog/${link(repo)}`, target: '_blank', rel: 'noopener' }, 'its reader page'), '.');
  return { input, note };
}

function errBox(e) {
  if (e instanceof Refusal) return h('div', { class: 'err' }, h('b', {}, `Refused: ${e.code}`), e.detail);
  return h('div', { class: 'err' }, h('b', {}, 'Something went wrong'), e.message || String(e));
}

// ---------- chrome ----------

const parseHash = () => {
  const p = new URLSearchParams(location.hash.slice(1));
  const mode = p.has('themes') ? 'themes' : p.has('extensions') ? 'extensions' : p.has('licences') ? 'licences' : p.has('settings') ? 'settings' : p.has('new') ? 'new' : p.has('correct') ? 'correct' : p.has('edit') ? 'edit' : null;
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
    if (r.mode === 'themes') node = await themesView(repo, r);
    else if (r.mode === 'extensions') node = await extensionsView(repo, r);
    else if (r.mode === 'licences') node = licencesView(repo, r);
    else if (r.mode === 'settings') node = await settingsView(repo, r);
    else if (r.mode === 'new' || r.mode === 'edit' || r.mode === 'correct') node = await editorView(repo, r);
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

  const found = await detectAddress(gh, repo).catch(() => null);
  const addr = addressView(repo, found, null);
  const f = {
    title: h('input', { value: defaultTitle(repo) }),
    description: h('input', { placeholder: 'What this blog is about' }),
    author: h('input', { value: login || '' }),
    domain: addr.input,
    images: h('input', { placeholder: "blank: this repository's images folder, or me/images" }),
    video: h('input', { placeholder: "blank: this repository's videos folder, or me/renders" }),
  };
  const field = (label, el, hint) => h('div', {}, h('label', {}, label), el, hint && hint.nodeType ? hint : hint ? h('div', { class: 'hint' }, hint) : null);
  const status = h('div');
  const go = h('button', { class: 'primary' }, 'Create blog…');
  go.addEventListener('click', async () => {
    go.disabled = true;
    status.replaceChildren();
    try {
      const fields = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
      const plan = await planInit(gh, { repo, branch, fields, runner });
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
    h('div', { class: 'row' }, field('Address the blog is served at', f.domain, addr.note)),
    h('div', { class: 'row' }, field('Images repository', f.images, 'Left blank, images go in an images folder of this repository. Or owner/name, owner/name/folder.'), field('Video repository', f.video, 'Left blank, videos are taken from a videos folder of this repository: releases published with hls.webcli.app.')),
    h('div', { class: 'actions' }, go),
    status,
  );
}

// ---------- settings ----------

const LIGHT = { accent: '#0b5fff', text: '#1d1d1f', background: '#ffffff', muted: '#6b6b72' };
const DARK = { accent: '#7aa7ff', text: '#e8e8ec', background: '#141416', muted: '#9a9aa3' };
const HEXRE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const fullHex = (v) => (/^#[0-9a-f]{3}$/i.test(v) ? '#' + [...v.slice(1)].map((c) => c + c).join('') : v);

// The theme's stylesheet, retargeted so it styles a shadow root instead of the page.
const forShadow = (css) => css.replace(/:root\b/g, ':host').replace(/(^|[\s,>+~}])body\b(?![-\w])/g, '$1.pv');

async function settingsView(repo, r) {
  if (!gh.token) {
    return h('div', {}, h('h2', {}, 'Sign in to change settings'), h('p', {}, 'Settings are saved to blog.json, so this needs a fine-grained token.'), h('button', { class: 'primary', onclick: () => signInDialog() }, 'Sign in'));
  }
  const { blog: current, lock } = cache;
  // blank means the blog's own repository (blog.json does not even say so)
  const homeFolder = (name) => (current.repo ? `blank: ${parseRepoRef(current.repo).repo}/${name}` : 'owner/name or owner/name/folder');
  const { repo: plain, folder } = parseRepoRef(repo);
  const info = await gh.repoInfo(plain);
  const branch = r.ref || info.default_branch;
  const canPush = !!(info.permissions && info.permissions.push);
  let entries = [];
  try {
    entries = await loadIndex(gh, repo, r.ref);
  } catch {
    /* the preview falls back to a sample */
  }
  if (!entries.length) entries = [{ slug: 'sample', title: 'A sample post', date: new Date().toISOString().slice(0, 10), tags: ['sample'], excerpt: 'The first lines of a post appear here, as the list shows them.' }];

  // A pinned theme is applied to the preview too, with its markup contract.
  let themePack = null;
  let themeNote = '';
  if (current.theme && typeof current.theme === 'object') {
    try {
      themePack = await loadPinnedTheme(gh, current.theme);
    } catch (e) {
      themeNote = ` The pinned theme could not be loaded for the preview (${e.detail || e.message}).`;
    }
  }
  const contract = themePack ? themePack.contract : 'blog-webcli-v1';

  const found = await detectAddress(gh, repo).catch(() => null);
  const addr = addressView(repo, found, current.domain);
  const f0 = blogToForm(current);
  const ctl = {};
  const bind = (key, el) => ((ctl[key] = el), el);
  const input = (key, attrs = {}) => bind(key, h('input', { value: f0[key] ?? '', ...attrs }));
  const area = (key, rows, attrs = {}) => bind(key, h('textarea', { rows, ...attrs }, f0[key] ?? ''));
  const check = (key, label) => h('label', { class: 'check' }, bind(key, h('input', { type: 'checkbox', checked: !!f0[key] })), ` ${label}`);
  const select = (key, options) => bind(key, h('select', {}, options.map(([v, t]) => h('option', { value: v, selected: v === f0[key] }, t))));
  const field = (label, el, hint) => h('div', {}, h('label', {}, label), el, hint && hint.nodeType ? hint : hint ? h('div', { class: 'hint' }, hint) : null);
  const section = (title, ...kids) => h('fieldset', {}, h('legend', {}, title), ...kids);

  const swatchCell = (key, fallback) => {
    const text = bind(key, h('input', { value: f0[key], placeholder: fallback }));
    const sw = h('input', { type: 'color', value: fullHex(HEXRE.test(f0[key]) ? f0[key] : fallback), 'aria-label': `${key} colour picker` });
    sw.addEventListener('input', () => { text.value = sw.value; text.dispatchEvent(new Event('input', { bubbles: true })); });
    text.addEventListener('input', () => { if (HEXRE.test(text.value.trim())) sw.value = fullHex(text.value.trim()); });
    return h('div', { class: 'cc' }, text, sw);
  };
  const colorRows = ['accent', 'text', 'background', 'muted'].flatMap((k) => [h('span', {}, k), swatchCell(`color_${k}`, LIGHT[k]), swatchCell(`dark_${k}`, DARK[k])]);

  const fontOpts = [['', 'Default'], ...Object.keys(FONTS).map((k) => [k, k])];
  const preview = h('div', { id: 'preview' });
  const shadow = preview.attachShadow({ mode: 'open' });
  const msg = h('div', { class: 'hint' });
  const status = h('div');

  const collect = () => {
    const out = {};
    for (const [k, el] of Object.entries(ctl)) out[k] = el.type === 'checkbox' ? el.checked : el.value;
    return out;
  };

  const redraw = () => {
    let next;
    try {
      next = validateBlog(formToBlog(current, collect()));
    } catch (e) {
      msg.textContent = `Not applied yet: ${e.detail || e.message}`;
      msg.classList.add('bad');
      return;
    }
    msg.textContent = `Preview follows your system light/dark setting. Nothing is saved until you press Save.${themeNote}`;
    msg.classList.remove('bad');
    let logoUrl = null;
    try {
      logoUrl = resolveLogo(next, lock);
    } catch {
      /* a logo that is not pinned yet shows after saving */
    }
    const body = indexBody(contract, { blog: next, entries, hrefFor: () => '#', home: '#', feed: '#', logoUrl });
    shadow.innerHTML = `<style>${forShadow(themeCss(next, themePack))}</style><div class="pv ${esc(body.bodyClass)}" style="pointer-events:none">${body.html}</div>`;
  };

  const form = h(
    'form',
    { onsubmit: (e) => e.preventDefault() },
    section('General', h('div', { class: 'row' }, field('Title', input('title')), field('Author', input('author'))), h('div', { class: 'row' }, field('Description', input('description'))), h('div', { class: 'row' }, field('Address the blog is served at', bind('domain', addr.input), addr.note))),
    section(
      'Media repositories',
      h('div', { class: 'row' }, field('Images', input('images', { placeholder: homeFolder('images') })), field('Audio', input('audio', { placeholder: 'owner/name or owner/name/folder' })), field('Video', input('video', { placeholder: homeFolder('videos') }))),
      h('details', {}, h('summary', {}, 'URL templates (change CDN or player)'), h('div', { class: 'row' }, field('Image / audio URL', input('assetBase', { placeholder: 'https://…{owner}/{repo}@{sha}/{path}' }))), h('div', { class: 'row' }, field('Video player', input('videoPlayer')), field('Video URL', input('videoBase')))),
    ),
    section('Colors', h('div', { class: 'colors' }, h('span', {}), h('b', {}, 'Light'), h('b', {}, 'Dark'), ...colorRows), h('div', { class: 'hint' }, 'Leave blank for the default. A colour with no dark value keeps the default dark palette.')),
    section(
      'Type and layout',
      h('div', { class: 'row' }, field('Body font', select('font', fontOpts)), field('Heading font', select('headingFont', fontOpts))),
      h('div', { class: 'row' }, field('Content width', input('width', { placeholder: '40rem' }), '25–80rem, 400–1280px or 40–120ch'), field('Text size', input('fontSize', { placeholder: '18px' }), '14–24px or 0.875–1.5rem')),
      h('div', { class: 'row' }, field('Post list', select('layout', [['list', 'List'], ['cards', 'Cards']])), h('div', {}, check('excerpts', 'Show excerpts'), check('dates', 'Show dates'), check('tags', 'Show tags'))),
    ),
    section(
      'Header and footer',
      h('div', { class: 'row' }, field('Logo', input('logo', { placeholder: 'asset:images/logo.png' }), 'An image already in your images repository; pinned when you save.'), h('div', {}, check('showTitle', 'Show the title next to the logo'))),
      h('div', { class: 'row' }, field('Header links', area('headerLinks', 3, { placeholder: 'About | https://example.com/about' }), 'One per line: Label | https://address (up to 8)')),
      h('div', { class: 'row' }, field('Footer text', input('footerText', { placeholder: '© 2026 Your Name' })), field('Footer links', area('footerLinks', 3, { placeholder: 'Source | https://github.com/you/blog' }))),
    ),
    section('Custom CSS', area('css', 6, { class: 'mono', spellcheck: 'false', placeholder: '.posts h2 { letter-spacing: .02em }' }), h('div', { class: 'hint' }, 'Rules, @media, @supports and @keyframes only. No url(), @import, @font-face or escapes: a stylesheet cannot load anything.')),
  );
  let timer = null;
  form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(redraw, 120); });
  form.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(redraw, 0); });

  const save = h('button', { class: 'primary' }, 'Save settings…');
  save.disabled = !canPush;
  save.addEventListener('click', async () => {
    save.disabled = true;
    status.replaceChildren();
    try {
      const plan = await planSettings(gh, { repo, branch, form: collect(), runner });
      if (plan.unchanged) {
        status.replaceChildren(h('div', { class: 'ok' }, 'Nothing to save: the repository already has these settings.'));
        return;
      }
      if (!(await confirmPlan(plan))) return;
      const receipt = await executePlan(gh, plan);
      cache = null;
      cache = { repo, ref: r.ref, ...(await loadBlog(gh, repo, r.ref)) };
      status.replaceChildren(receiptBox(receipt), h('p', { class: 'hint' }, 'blog.json and every generated page were updated together.'));
    } catch (e) {
      status.replaceChildren(errBox(e));
    } finally {
      save.disabled = !canPush;
    }
  });

  const node = h(
    'div',
    {},
    h('p', {}, h('a', { href: link(repo) }, `← ${current.title}`)),
    h('h1', {}, 'Blog settings'),
    h('p', { class: 'muted' }, `Saved to ${at(folder, 'blog.json')} in ${plain}. Posts are never touched; every generated page is regenerated from the new settings.`),
    canPush ? null : h('div', { class: 'err' }, `This token cannot write to ${plain}.`),
    section('Theme, extensions and licences',
      h('p', {}, `Theme: ${current.theme && typeof current.theme === 'object' ? `${current.theme.name} ${current.theme.version} (${current.theme.licence})` : 'default'} · Extensions: ${(current.extensions || []).length ? current.extensions.map((e) => `${e.name} ${e.version}`).join(', ') : 'none'}`),
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: link(repo, '&themes') }, 'Choose a theme'), h('a', { class: 'btn', href: link(repo, '&extensions') }, 'Extensions'), h('a', { class: 'btn', href: link(repo, '&licences') }, 'Licences'))),
    h('h3', {}, 'Preview'),
    preview,
    msg,
    form,
    h('div', { class: 'actions' }, save),
    status,
  );
  queueMicrotask(redraw);
  return node;
}

// ---------- themes, extensions, licences ----------

// themes.json / extensions.json: curated by pull request, convenience only. A repository works by its
// address whether or not it is listed.
async function readList(file, key) {
  try {
    const res = await net.request(new URL(file, location.href));
    if (!res.ok) return [];
    const list = res.json()[key];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.name === 'string' && typeof e.repo === 'string' && typeof e.ref === 'string') : [];
  } catch {
    return [];
  }
}

// "owner/repo[/folder]@ref"
function parseAddress(text) {
  const t = text.trim();
  const i = t.lastIndexOf('@');
  if (i < 1 || i === t.length - 1) throw new Refusal('unpinned-ref', 'Write it as owner/repo@v1.0.0: a theme or extension is always pinned to a tag or a commit.');
  parseRepoRef(t.slice(0, i));
  return { where: parseRepoRef(t.slice(0, i)).ref, ref: t.slice(i + 1).trim() };
}

function needSignIn(what) {
  return h('div', {}, h('h2', {}, `Sign in to change ${what}`), h('p', {}, 'This is saved to blog.json, so it needs a fine-grained token.'), h('button', { class: 'primary', onclick: () => signInDialog() }, 'Sign in'));
}

async function commitPlan(plan, status, repo, r) {
  if (plan.unchanged) {
    status.replaceChildren(h('div', { class: 'ok' }, 'Nothing to change: the repository already matches.'));
    return;
  }
  if (!(await confirmPlan(plan))) return;
  const receipt = await executePlan(gh, plan);
  cache = null;
  cache = { repo, ref: r.ref, ...(await loadBlog(gh, repo, r.ref)) };
  status.replaceChildren(receiptBox(receipt), h('p', { class: 'hint' }, 'blog.json and every generated page were updated together.'));
}

async function packContext(repo, r) {
  const { repo: plain } = parseRepoRef(repo);
  const info = await gh.repoInfo(plain);
  return { branch: r.ref || info.default_branch, canPush: !!(info.permissions && info.permissions.push) };
}

async function themesView(repo, r) {
  if (!gh.token) return needSignIn('the theme');
  const { blog } = cache;
  const { branch, canPush } = await packContext(repo, r);
  const status = h('div');
  const listed = await readList('themes.json', 'themes');
  const use = async (spec, btn) => {
    btn.disabled = true;
    status.replaceChildren();
    try {
      const plan = await planTheme(gh, { repo, branch, use: spec, runner });
      await commitPlan(plan, status, repo, r);
    } catch (e) {
      status.replaceChildren(errBox(e));
    } finally {
      btn.disabled = !canPush;
    }
  };
  const t = blog.theme && typeof blog.theme === 'object' ? blog.theme : null;
  const input = h('input', { placeholder: 'owner/theme-repo@v1.0.0   (or owner/repo/folder@v1.0.0)', style: 'width:100%' });
  const go = h('button', { class: 'primary' }, 'Use this theme…');
  go.addEventListener('click', () => { try { use(parseAddress(input.value), go); } catch (e) { status.replaceChildren(errBox(e)); } });
  go.disabled = !canPush;
  const builtin = h('button', {}, 'Use the default theme');
  builtin.disabled = !canPush || !t;
  builtin.addEventListener('click', () => use(null, builtin));
  return h(
    'div',
    {},
    h('p', {}, h('a', { href: link(repo, '&settings') }, '← Settings')),
    h('h1', {}, 'Theme'),
    h('p', {}, t ? h('span', {}, 'Current: ', h('b', {}, `${t.name} ${t.version}`), ` — ${t.licence} — ${t.repo}@${t.ref}`) : 'Current: the default theme.'),
    h('p', { class: 'hint' }, 'A theme is a repository (theme.json + CSS). It is pinned to a tag or commit and a sha256, so it cannot change under your published pages. Its CSS is baked into the generated pages; readers load nothing from the theme repository.'),
    h('h3', {}, 'By address'),
    h('p', { class: 'hint' }, 'Any repository works, listed or not.'),
    input,
    h('div', { class: 'actions' }, go, builtin),
    h('h3', {}, 'Built in'),
    listed.length
      ? h('ul', { class: 'posts' }, listed.map((e) => { const b = h('button', {}, 'Use…'); b.disabled = !canPush; b.addEventListener('click', () => { try { use(parseAddress(`${e.repo}@${e.ref}`), b); } catch (err) { status.replaceChildren(errBox(err)); } }); return h('li', {}, e.screenshot && /^https:\/\//.test(e.screenshot) ? h('img', { src: e.screenshot, alt: '', style: 'max-width:12rem;float:right;margin-left:1rem' }) : null, h('h3', {}, e.name), h('div', { class: 'muted' }, `${e.licence || 'licence not stated'} · ${e.repo}@${e.ref}`), e.description ? h('p', {}, String(e.description).slice(0, 200)) : null, b); }))
      : h('p', { class: 'muted' }, 'The built-in list could not be read. Any theme repository still works by its address.'),
    status,
  );
}

async function extensionsView(repo, r) {
  if (!gh.token) return needSignIn('extensions');
  const { blog } = cache;
  const { branch, canPush } = await packContext(repo, r);
  const status = h('div');
  const listed = await readList('extensions.json', 'extensions');
  const act = async (args, btn) => {
    btn.disabled = true;
    status.replaceChildren(h('p', { class: 'hint' }, 'Running in the sandbox…'));
    try {
      await commitPlan(await planExtension(gh, { repo, branch, ...args, runner }), status, repo, r);
    } catch (e) {
      status.replaceChildren(errBox(e));
    } finally {
      btn.disabled = !canPush;
    }
  };
  const input = h('input', { placeholder: 'owner/extension-repo@v1.0.0', style: 'width:100%' });
  const add = h('button', { class: 'primary' }, 'Add this extension…');
  add.disabled = !canPush;
  add.addEventListener('click', () => { try { act({ add: parseAddress(input.value) }, add); } catch (e) { status.replaceChildren(errBox(e)); } });
  const current = blog.extensions || [];
  return h(
    'div',
    {},
    h('p', {}, h('a', { href: link(repo, '&settings') }, '← Settings')),
    h('h1', {}, 'Extensions'),
    h('p', { class: 'hint' }, 'An extension is code, so it runs only when you publish, in a sandbox with no DOM, no network and no access to your token. What it returns is committed with your pages; the published blog contains no extension code, and readers run none.'),
    h('h3', {}, 'In use'),
    current.length
      ? h('ul', { class: 'posts' }, current.map((e) => { const b = h('button', {}, 'Remove…'); b.disabled = !canPush; b.addEventListener('click', () => act({ remove: e.repo }, b)); return h('li', {}, h('h3', {}, `${e.name} ${e.version}`), h('div', { class: 'muted' }, `${e.licence} · ${e.repo}@${e.ref}${e.hooks ? ` · ${e.hooks.join(', ')}` : ''}`), b); }))
      : h('p', { class: 'muted' }, 'None.'),
    h('h3', {}, 'By address'),
    input,
    h('div', { class: 'actions' }, add),
    h('h3', {}, 'Built in'),
    listed.length
      ? h('ul', { class: 'posts' }, listed.map((e) => { const b = h('button', {}, 'Add…'); b.disabled = !canPush; b.addEventListener('click', () => { try { act({ add: parseAddress(`${e.repo}@${e.ref}`) }, b); } catch (err) { status.replaceChildren(errBox(err)); } }); return h('li', {}, h('h3', {}, e.name), h('div', { class: 'muted' }, `${e.licence || 'licence not stated'} · ${e.repo}@${e.ref}`), e.description ? h('p', {}, String(e.description).slice(0, 200)) : null, b); }))
      : h('p', { class: 'muted' }, 'The built-in list could not be read. Any extension repository still works by its address.'),
    status,
  );
}

function licencesView(repo, r) {
  const { blog } = cache;
  const rows = licenceRecords(blog);
  return h(
    'div',
    {},
    h('p', {}, h('a', { href: link(repo, '&settings') }, '← Settings')),
    h('h1', {}, 'What is in this site'),
    h('p', { class: 'muted' }, 'Every theme and extension this blog depends on, with its licence. Recorded in blog.json, written to licences.json, and stamped into each generated page as a comment.'),
    h('table', { style: 'width:100%;border-collapse:collapse' }, h('thead', {}, h('tr', {}, ['Kind', 'Name', 'Version', 'Licence', 'Pinned to'].map((t) => h('th', { style: 'text-align:left;border-bottom:1px solid var(--rule);padding:.3rem' }, t)))), h('tbody', {}, rows.map((x) => h('tr', {}, [x.kind, x.name, x.version || '', x.licence, x.repo ? `${x.repo}@${x.ref}` : 'built in'].map((t) => h('td', { style: 'padding:.3rem;border-bottom:1px solid var(--rule)' }, String(t))))))),
    h('p', { class: 'hint' }, `The generator, ${blog.theme && typeof blog.theme === 'object' ? 'your pinned theme' : 'the default theme'} and any extensions are the only code or style that shapes the pages. Posts and images are your own content.`),
  );
}

// ---------- reading ----------

async function listView(repo, r) {
  const { blog } = cache;
  document.title = blog.title;
  const entries = await loadIndex(gh, repo, r.ref);
  const wrap = h('div', {}, h('h1', {}, blog.title), h('p', { class: 'muted' }, blog.description));
  // View blog opens the GitHub Pages site when GitHub is serving one, else the reader (which needs no Pages)
  const viewBlog = h('a', { class: 'btn', href: `blog/${link(repo, r.ref ? `&ref=${r.ref}` : '')}`, target: '_blank', rel: 'noopener', title: 'Opens the reader: GitHub Pages is not serving this blog' }, 'View blog');
  if (gh.token) wrap.append(h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => (location.hash = link(repo, '&new')) }, 'New post'), h('button', { onclick: () => (location.hash = link(repo, '&settings')) }, 'Settings'), viewBlog, h('button', { onclick: (e) => showDrafts(e.target, repo, r.ref, wrap) }, 'Show drafts')));
  if (gh.token) {
    detectAddress(gh, repo).then((found) => {
      if (found.live && found.exact && found.built) {
        viewBlog.href = `${found.address}/`;
        viewBlog.title = 'Opens the GitHub Pages site';
      }
    }).catch(() => {});
  }
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
  let { blog } = cache;
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
    cover: h('input', { value: m.cover || '', placeholder: 'asset:images/cover.png, or auto', disabled: correcting, style: 'flex:1' }),
    description: h('input', { value: m.description || '', placeholder: 'Optional; defaults to the first paragraph', disabled: correcting }),
  };
  const coverUpload = h('button', { type: 'button', disabled: correcting, onclick: () => chooseImage((ref) => { f.cover.value = ref; }) }, 'Upload…');
  const coverAuto = h('button', { type: 'button', disabled: correcting, onclick: () => { f.cover.value = 'auto'; } }, 'Auto');
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
  const field = (label, el, hint) => h('div', {}, h('label', {}, label), el, hint ? h('div', { class: 'hint' }, hint) : null);
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
    h('div', { class: 'row' }, field('Cover', h('div', { style: 'display:flex;gap:.4rem' }, f.cover, coverUpload, coverAuto), 'Upload an image, or auto: the post\'s first image, else the poster of its first video, else the blog\'s cover. It is the preview when the post is shared.'), field('Description', f.description)),
    editorEl,
    h('p', { class: 'hint' }, 'The toolbar offers only what markdown can express. Images are uploaded to the assets repository at publish time, not before.'),
    correcting ? h('div', {}, field('Note for the pull request', note), canPush ? null : h('div', { class: 'err' }, 'You do not have write access to this repository. ', h('a', { href: `https://github.com/${plainRepo}/edit/${branch}/${at(folder, `posts/${r.post}.md`)}`, target: '_blank', rel: 'noopener' }, 'Propose the change on GitHub instead'), ' — it forks and opens the pull request for you.')) : null,
    h('div', { class: 'row' }, field('Date', f.date), field('Tags', f.tags), field('Status', f.status)),
    h('div', { class: 'actions' }, go),
    status,
  );
  // The Quill container must be in the document before Quill measures it.
  view.replaceChildren(node);
  const quill = await createEditor(editorEl, { onImage: () => pickImage(), onVideo: () => pickVideo() });
  quill.setContents(existing ? existing.post.delta.ops : mdToDelta('').ops, 'silent');
  go.disabled = correcting && !canPush;

  // Stage an image for upload at publish, in the images repository. Returns its asset reference, or
  // null when there is nowhere to put it (the explanation is already shown).
  async function stageImage(file) {
    if (file.size > 20 * 1024 * 1024) throw new Error('Images over 20 MB are not accepted; binaries should be reasonable.');
    const repoKeys = () => Object.keys((blog.assets && blog.assets.repos) || {});
    if (!repoKeys().length) {
      // it may have been set in another tab since this one loaded
      cache = { repo, ref: r.ref, ...(await loadBlog(gh, repo, r.ref)) };
      blog = cache.blog;
    }
    const keys = repoKeys();
    if (!keys.length) {
      const sample = `${plainRepo}/images`;
      status.replaceChildren(h('div', { class: 'err' }, h('b', {}, 'This blog has no images repository yet'), 'Images are binaries, so they are kept in a repository (or a folder of one) that you do not have to clone to edit text. Name one in Settings, for example ', h('code', {}, 'me/images'), ' or ', h('code', {}, sample), ' to keep them in this repository. ', h('a', { href: link(repo, '&settings'), target: '_blank', rel: 'noopener' }, 'Open Settings in a new tab'), ', save, then choose the image again: what you have written here is not lost.'));
      return null;
    }
    const key = keys.includes('images') ? 'images' : keys[0];
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+/, '');
    const path = `${hex(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 10)}-${name}`;
    staged.set(`${key}/${path}`, { key, path, bytes, url: URL.createObjectURL(file) });
    return `asset:${key}/${path}`;
  }

  // A file chooser for an image; `use` receives the staged asset reference.
  function chooseImage(use) {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const ref = await stageImage(file);
        if (!ref) return;
        use(ref);
        status.replaceChildren();
      } catch (e) {
        status.replaceChildren(errBox(e));
      }
    });
    input.click();
  }

  function pickImage() {
    chooseImage((ref) => {
      const range = insertionPoint(quill);
      quill.insertEmbed(range.index, 'image', ref, 'user');
      quill.setSelection(range.index + 1);
    });
  }

  async function pickVideo() {
    try {
      if (!blog.video) throw new Error('blog.json has no "video" section, so there are no video repositories to embed from.');
      const releases = await listVideoReleases(gh, blog);
      const choice = await chooseVideo(releases, blog);
      if (!choice) return;
      const range = insertionPoint(quill);
      quill.insertEmbed(range.index, 'video', choice.ref, 'user');
      quill.setSelection(range.index + 1);
      status.replaceChildren(choice.receipt ? releaseReceipt(choice.receipt) : '');
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
      const plan = await planChange(gh, { repo, branch, slug, text, staged: [...staged.values()].filter((s) => used.has(`${s.key}/${s.path}`)), mode: correcting ? 'pr' : 'direct', create: isNew, runner });
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

// A searchable dropdown of the videos a post can embed, with the Embed button beside it. Entries are
// published releases (one per version) and render folders that have no tag yet; embedding the latter
// publishes them first (the tag is made under the hood, after the usual pre-flight).
function videoCombobox(blog, { entries, onEmbed, onUpload, onCancel, onOpenChange }) {
  let chosen = null;
  let query = '';
  let dirty = false; // typed since the last choice: only then does the text filter the list
  let open = false;
  let active = -1;
  let shown = [];
  let scanning = true;

  const label = (e) => (e.unpublished ? e.name : `${e.name} v${e.version}`);
  const posterOf = (e) => {
    try {
      if (e.unpublished) return `https://raw.githubusercontent.com/${e.repo}/${encodeURIComponent(e.branch)}/${e.folder ? `${e.folder}/` : ''}${e.name}/poster.jpg`;
      return `${videoBase(e.ref, blog)}poster.jpg`;
    } catch {
      return null;
    }
  };
  const thumb = (e, cls) => {
    const img = h('img', { alt: '', loading: 'lazy', src: posterOf(e) || '' });
    const box = h('div', { class: `thumb ${cls}` }, img);
    img.addEventListener('error', () => box.classList.add('no-poster'));
    return box;
  };

  const input = h('input', { type: 'text', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'video-options', 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false', placeholder: 'Search videos…', class: 'combo-input' });
  const toggle = h('button', { type: 'button', class: 'combo-toggle', tabindex: '-1', 'aria-label': 'Show all videos' }, '▾');
  const list = h('ul', { class: 'combo-list', id: 'video-options', role: 'listbox' });
  list.hidden = true;
  const embedBtn = h('button', { class: 'primary', disabled: true }, 'Embed');
  const preview = h('div', { class: 'combo-preview' });
  const note = h('div', { class: 'hint' });

  const matches = () => {
    const tokens = dirty ? query.trim().toLowerCase().split(/\s+/).filter(Boolean) : [];
    return entries.filter((e) => {
      const hay = `${e.name} ${e.unpublished ? 'not published yet' : `v${e.version}`} ${e.where}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  };

  const setOpen = (v) => {
    open = v;
    list.hidden = !v;
    input.setAttribute('aria-expanded', String(v));
    if (!v) input.removeAttribute('aria-activedescendant');
    if (onOpenChange) onOpenChange(v);
  };

  const drawPreview = () => {
    if (!chosen) {
      preview.replaceChildren(h('div', { class: 'muted' }, scanning ? 'Looking for videos…' : entries.length ? 'Choose a video.' : 'No videos here yet. Upload one: it is encoded in your browser and embedded.'));
      note.textContent = '';
      return;
    }
    preview.replaceChildren(thumb(chosen, 'large'), h('div', { class: 'meta' }, h('b', {}, label(chosen)), h('div', { class: 'muted' }, chosen.where)));
    note.textContent = chosen.unpublished ? `Not published yet: Embed will publish it first, as ${chosen.name}/v1 (you will see exactly what is sent before anything is).` : '';
  };

  const choose = (e) => {
    chosen = e;
    dirty = false;
    input.value = e ? label(e) : '';
    embedBtn.disabled = !e;
    embedBtn.textContent = e && e.unpublished ? 'Publish and embed' : 'Embed';
    drawPreview();
  };

  const drawList = () => {
    shown = matches();
    if (active >= shown.length) active = shown.length - 1;
    list.replaceChildren(...(shown.length ? shown.map((e, i) => {
      const li = h('li', { role: 'option', id: `video-opt-${i}`, 'aria-selected': String(e === chosen), class: i === active ? 'active' : '' },
        thumb(e, 'small'),
        h('div', { class: 'opt-text' }, h('div', { class: 'opt-name' }, e.name), h('div', { class: 'muted opt-repo' }, e.where)),
        e.unpublished ? h('span', { class: 'badge' }, 'not published yet') : h('span', { class: 'chip static' }, `v${e.version}`));
      li.addEventListener('mousedown', (ev) => { ev.preventDefault(); choose(e); setOpen(false); });
      return li;
    }) : [h('li', { class: 'empty' }, scanning ? 'Looking…' : entries.length ? 'No video matches' : 'No videos yet')]));
    if (active >= 0 && shown[active]) input.setAttribute('aria-activedescendant', `video-opt-${active}`);
    const el = list.querySelector('.active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  };

  const show = () => {
    shown = matches();
    active = Math.max(0, shown.indexOf(chosen));
    drawList();
    setOpen(true);
  };

  input.addEventListener('focus', () => { input.select(); });
  input.addEventListener('click', () => { if (!open) show(); });
  toggle.addEventListener('mousedown', (ev) => { ev.preventDefault(); input.focus(); if (open) setOpen(false); else { dirty = false; show(); } });
  input.addEventListener('input', () => {
    query = input.value;
    dirty = true;
    active = 0;
    if (chosen && input.value !== label(chosen)) { chosen = null; embedBtn.disabled = true; embedBtn.textContent = 'Embed'; drawPreview(); }
    drawList();
    setOpen(true);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!open) { show(); return; }
      const n = shown.length;
      if (n) active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n;
      drawList();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (open && shown[active]) { choose(shown[active]); setOpen(false); } else if (chosen) onEmbed(chosen);
    } else if (ev.key === 'Escape' && open) {
      ev.preventDefault();
      ev.stopPropagation();
      setOpen(false);
    }
  });
  input.addEventListener('blur', () => { if (open) setOpen(false); });
  embedBtn.addEventListener('click', () => { if (chosen) onEmbed(chosen); });

  drawPreview();
  const root = h('div', { class: 'video-combo' },
    h('div', { class: 'combo-row' }, h('div', { class: 'combo' }, input, toggle, list), embedBtn),
    note,
    preview,
    h('div', { class: 'actions' }, h('button', { onclick: onUpload }, 'Upload a video…'), h('button', { onclick: onCancel }, 'Cancel')),
  );
  return {
    root,
    isOpen: () => open,
    closeList: () => setOpen(false),
    focus: () => input.focus(),
    // entries arrive in two steps: the published releases at once, the render folders when the scan is done
    setEntries(next, { done = false } = {}) {
      entries = next;
      scanning = !done;
      if (!chosen && entries.length) choose(entries[0]);
      else drawPreview();
      if (open) drawList();
      input.disabled = !entries.length && done;
      input.placeholder = !entries.length && done ? 'No videos yet' : 'Search videos…';
    },
  };
}

function chooseVideo(releases, blog) {
  const dlg = $('#dlg');
  return new Promise((resolve) => {
    let settled = false;
    let combo = null;
    const onCancel = (e) => {
      if (combo && combo.isOpen()) { // Esc closes the open list first, the dialog second
        e.preventDefault();
        combo.closeList();
        return;
      }
      done(null);
    };
    const done = (v) => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      resolve(v);
    };
    const published = releases.map((r) => ({ ref: r.ref, name: r.slug, version: r.version, where: r.repo, key: r.key }));
    let unpublished = [];

    const showList = () => {
      combo = videoCombobox(blog, {
        entries: published,
        onEmbed: (e) => (e.unpublished ? showPublish(e) : done({ ref: e.ref })),
        onUpload: () => showUpload(),
        onCancel: () => done(null),
      });
      dlg.replaceChildren(h('h2', {}, 'Embed a video'), combo.root);
      combo.setEntries([...published, ...unpublished], { done: scanned });
      combo.focus();
    };
    const showUpload = () => dlg.replaceChildren(releaseView(blog, { mode: 'video', back: showList, created: done }));
    const showPublish = (e) => dlg.replaceChildren(releaseView(blog, { mode: 'tag', target: e, back: showList, created: done }));

    // render folders that have no tag yet are offered too; scanning reads the repository, so it follows
    let scanned = false;
    listReleaseFolders(gh, blog, { compare: false })
      .then((lists) => {
        unpublished = lists.flatMap((l) => l.folders.filter((f) => f.latest === 0).map((f) => ({ unpublished: true, key: l.key, where: l.where, name: f.name, repo: l.repo, folder: l.folder, branch: l.branch })));
      })
      .catch(() => {})
      .finally(() => {
        scanned = true;
        if (combo && !settled) combo.setEntries([...published, ...unpublished], { done: true });
      });

    showList();
    dlg.addEventListener('cancel', onCancel); // Esc. Not 'close': that fires after dlg.close(), and would dismiss a dialog opened right after
    dlg.showModal();
  });
}

// Getting a video into the post when it is not a published release yet. A release (a folder of HLS and
// a tag that never moves) is made for you, never asked for by name:
//   mode 'video': an uploaded video file is encoded in the browser, then published as a release;
//   mode 'tag':   a render folder already in the repository is tagged, which publishes it as v1.
// Either way the review screen says exactly what will be sent before anything is.
function releaseView(blog, { back, created, mode = 'video', target = null }) {
  const body = h('div');
  const status = h('div');
  const intro = mode === 'video'
    ? h('p', { class: 'hint' }, 'The video is encoded in this browser into an HLS ladder (the same encoder hls.webcli.app uses) and nothing leaves it until you press the button on the review screen. It is then published and embedded in your post.')
    : h('p', { class: 'hint' }, `${target.name} is already in ${target.where}; it only needs a tag to be published.`);
  const root = h('div', {}, h('h2', {}, mode === 'video' ? 'Upload a video' : 'Publish and embed'), intro, body, status);
  const keys = Object.keys(blog.video.repos);

  const run = async (label, fn) => {
    status.replaceChildren(...(label ? [h('p', { class: 'hint' }, label)] : []));
    try {
      return await fn();
    } catch (e) {
      status.replaceChildren(errBox(e));
      return null;
    }
  };

  const confirm = (list, plan, summary = null) => {
    const rows = plan.changes.slice(0, 25).map((c) => h('div', {}, `${c.action.padEnd(6)} ${c.path}${c.delete ? '' : `  ${fmtBytes(c.size)}`}`));
    if (plan.changes.length > 25) rows.push(h('div', { class: 'muted' }, `… and ${plan.changes.length - 25} more`));
    const go = h('button', { class: 'primary' }, plan.kind === 'tag' ? `Create tag ${plan.tag}` : 'Commit, push and tag');
    go.addEventListener('click', async () => {
      go.disabled = true;
      gh.onWait = (s) => status.replaceChildren(h('p', { class: 'hint' }, `GitHub limits how fast files can be created; continuing in ${s} s…`));
      const receipt = await run(plan.kind === 'tag' ? 'Tagging…' : `Uploading ${plan.files} file${plan.files === 1 ? '' : 's'}…`, () => executeRelease(gh, plan, { onProgress: (done, total) => status.replaceChildren(h('p', { class: 'hint' }, `Uploading file ${Math.min(done + 1, total)} of ${total}…`)) }));
      gh.onWait = null;
      if (!receipt) {
        go.disabled = false;
        return;
      }
      created({ ref: `video:${list.key}/${plan.name}@v${plan.version}`, receipt });
    });
    body.replaceChildren(...[
      h('h3', {}, `Ready to create ${plan.tag}`),
      h('div', { class: 'preflight' }, describeRelease(plan).map((l) => h('div', {}, l))),
      summary ? h('p', { class: 'hint' }, `Encoded in your browser from ${summary.info.width}×${summary.info.height} at ${summary.info.fps} fps: ${summary.rungs.join(', ')}.${summary.warning ? ` ${summary.warning}` : ''}`) : null,
      rows.length ? h('div', { class: 'files' }, rows) : null,
      h('p', { class: 'hint' }, 'Nothing has been uploaded yet. The tag is created last and never moved.'),
      h('div', { class: 'actions' }, go, h('button', { onclick: () => { status.replaceChildren(); if (mode === 'tag') back(); else draw(); } }, 'Back')),
    ].filter(Boolean));
  };

  const videoBox = (list) => {
    const picker = h('input', { type: 'file', accept: 'video/mp4,video/quicktime,.mp4,.mov,.m4v' });
    const name = h('input', { placeholder: 'release name, e.g. harbour-walk', style: 'width:16rem', disabled: true });
    const nameNote = h('div', { class: 'hint' });
    const facts = h('p', { class: 'hint' });
    const rungs = h('div');
    const audio = h('select', { disabled: true }, h('option', { value: 'keep' }, 'Keep the audio'), h('option', { value: 'drop' }, 'Drop the audio'));
    const audioNote = h('div', { class: 'hint' });
    const audioRow = h('div', {}, h('label', {}, 'Audio ', audio), audioNote);
    const estimate = h('p', { class: 'hint' });
    const bar = h('progress', { max: 1, value: 0, style: 'width:100%' });
    const barText = h('div', { class: 'hint' });
    const go = h('button', { class: 'primary', disabled: true }, 'Encode and review…');
    const stop = h('button', {}, 'Cancel encoding');
    const progress = h('div', {}, bar, barText, stop);
    progress.hidden = true;
    audioRow.hidden = true;
    let bytes = null;
    let inspected = null;
    let cancelled = false;

    const picked = () => [...rungs.querySelectorAll('input[type=checkbox]')].filter((c) => c.checked).map((c) => Number(c.value));
    const refresh = () => {
      if (!inspected) return;
      const keep = picked();
      const problem = nameProblem(name.value.trim());
      const est = estimateBytes(inspected, keep, audio.value);
      nameNote.textContent = problem || '';
      nameNote.className = problem ? 'err' : 'hint';
      estimate.textContent = keep.length ? `About ${fmtBytes(est)} will be added to the repository${est > LIMITS.total ? `, over the ${fmtBytes(LIMITS.total)} a release may hold: untick a rung or trim the video` : est > 100 * 1048576 ? ' (a large commit)' : ''}.` : 'Keep at least one rung.';
      go.disabled = !(keep.length && !problem && est <= LIMITS.total && list.canPush);
    };
    name.addEventListener('input', refresh);
    audio.addEventListener('change', refresh);

    picker.addEventListener('change', async () => {
      go.disabled = true;
      inspected = null;
      bytes = null;
      status.replaceChildren();
      facts.textContent = '';
      rungs.replaceChildren();
      estimate.textContent = '';
      audioRow.hidden = true;
      name.disabled = true;
      const file = picker.files[0];
      if (!file) return;
      try {
        if (!webCodecsAvailable()) throw new Error('This browser has no WebCodecs (VideoDecoder, VideoEncoder), so it cannot encode video. Use a recent Chrome, Edge or Safari, or make the render with hls.webcli.app and create a release from it.');
        if (file.size > 1024 * 1048576) throw new Error(`${fmtBytes(file.size)} is too large to encode in a browser tab. Trim it first.`);
        status.replaceChildren(h('p', { class: 'hint' }, 'Reading the video…'));
        bytes = new Uint8Array(await file.arrayBuffer());
        const seen = inspectUpload(bytes);
        status.replaceChildren();
        if (!seen.ok) {
          bytes = null;
          status.replaceChildren(h('div', { class: 'err' }, h('b', {}, `Cannot package this video: ${seen.refusal.reason}`), seen.refusal.detail));
          return;
        }
        inspected = seen;
        const i = seen.info;
        facts.textContent = `${i.width}×${i.height} · ${i.fps} fps · ${i.duration.toFixed(1)} s · ${i.codec} · ${seen.hasAudio ? 'with audio' : 'no audio'}`;
        for (const r of seen.rungs) {
          const box = h('input', { type: 'checkbox', value: String(r.height), checked: true });
          box.addEventListener('change', refresh);
          rungs.append(h('label', { style: 'display:block' }, box, ` ${r.name} · ${r.kbps} kbps · about ${fmtBytes(r.bytes)}`));
        }
        audioRow.hidden = !seen.hasAudio;
        audio.disabled = !seen.hasAudio;
        audioNote.textContent = '';
        if (seen.hasAudio) {
          const aac = await audioDecodable();
          audio.value = 'keep';
          if (!aac.ok) {
            // the encoder will not guess the AAC delay, so say so now and default to the picture alone
            audio.value = 'drop';
            audioNote.textContent = `This browser cannot keep this video's audio: ${aac.reason}${/desktop Chrome/.test(aac.reason) ? '' : ' Use desktop Chrome, Edge or Safari to keep it.'}`;
          }
        }
        name.disabled = false;
        name.value = slugFromFilename(file.name);
        refresh();
      } catch (e) {
        status.replaceChildren(errBox(e));
      }
    });

    stop.addEventListener('click', () => { cancelled = true; barText.textContent = 'Cancelling…'; });
    go.addEventListener('click', async () => {
      cancelled = false;
      for (const el of [go, picker, name, audio, ...rungs.querySelectorAll('input')]) el.disabled = true;
      progress.hidden = false;
      const result = await run('', () => encodeToRelease(gh, {
        where: list.where,
        file: { name: picker.files[0].name, bytes },
        name: name.value.trim(),
        keep: picked(),
        audio: audio.value,
        onProgress: (f, text) => { bar.value = f; barText.textContent = text; },
        shouldCancel: () => cancelled,
      }));
      progress.hidden = true;
      for (const el of [picker, name, audio, ...rungs.querySelectorAll('input')]) el.disabled = false;
      if (result) {
        status.replaceChildren();
        confirm(list, result.plan, result.summary);
      } else {
        status.replaceChildren(...(status.childNodes.length ? [...status.childNodes] : [h('p', { class: 'hint' }, 'Cancelled. Nothing was uploaded.')]));
        refresh();
      }
    });

    return h('div', {}, h('h4', {}, 'Pick a video'), h('p', { class: 'hint' }, `An MP4 or MOV with H.264 video at a steady 24, 25, 30, 50 or 60 fps. It goes to ${list.where}/<name>/ as <name>/v1.`), h('div', { class: 'actions' }, picker), facts, h('div', { class: 'row' }, h('label', {}, 'Release name ', name)), nameNote, h('h4', {}, 'Qualities'), rungs, audioRow, estimate, h('div', { class: 'actions' }, go), progress);
  };

  async function draw() {
    body.replaceChildren(h('p', { class: 'hint' }, mode === 'tag' ? 'Checking the repository…' : 'Looking in the video repository…'));
    let lists;
    try {
      lists = await videoRepositories(gh, blog);
    } catch (e) {
      body.replaceChildren(errBox(e));
      return;
    }
    if (mode === 'tag') {
      const list = lists.find((l) => l.key === target.key) || lists[0];
      const plan = await run('', () => planTagRelease(gh, { where: target.where, name: target.name }));
      if (!plan) {
        body.replaceChildren();
        return;
      }
      confirm(list, plan);
      return;
    }
    body.replaceChildren(...lists.map((list) => h('div', {},
      h('h3', {}, `${list.where}${keys.length > 1 ? `  (${list.key})` : ''}`),
      list.error ? h('div', { class: 'err' }, h('b', {}, 'Could not read this repository'), list.error) : null,
      list.canPush === false ? h('div', { class: 'err' }, h('b', {}, 'No write access'), `A video is a commit and a tag in ${list.repo}; your token or account cannot write there.`) : null,
      !list.error ? videoBox(list) : null,
    )));
  }

  root.append(h('div', { class: 'actions' }, h('button', { onclick: back }, '← Embed a video')));
  draw();
  return root;
}

function releaseReceipt(r) {
  return h('div', { class: 'ok' }, h('b', {}, `Created ${r.tag}.`), ' ', r.commit ? h('a', { href: r.commit.url, target: '_blank', rel: 'noopener' }, `commit ${r.commit.sha.slice(0, 7)}`) : null, r.commit ? ' · ' : '', h('a', { href: r.tagUrl, target: '_blank', rel: 'noopener' }, 'tag'), h('div', { class: 'hint' }, 'The CDN can take a few minutes to serve a new tag, so the player may not load it straight away.'));
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
    // replaceChildren(null) inserts the text "null": leave out what is not there
    dlg.replaceChildren(...[
      h('h2', {}, 'Ready to send'),
      h('div', { class: 'preflight' }, describePlan(plan).map((l) => h('div', {}, l))),
      h('div', { class: 'files' }, [...plan.assetGroups.flatMap((g) => g.files.map((x) => ({ ...x, repo: g.repo }))), ...plan.changes.map((c) => ({ ...c, repo: plan.repo }))].map((c) => h('div', {}, `${c.action.padEnd(6)} ${c.repo}/${c.path}  ${fmtBytes(c.size)}`))),
      plan.licences ? h('div', {}, h('h3', {}, 'Licences this blog will depend on'), h('div', { class: 'files' }, plan.licences.map((l) => h('div', {}, `${l.kind.padEnd(10)} ${l.name} ${l.version || ''}  ${l.licence}${l.repo ? `  ${l.repo}@${l.ref}` : '  (built in)'}`)))) : null,
      h('p', { class: 'hint' }, plan.mode === 'pr' ? 'This opens a pull request; the default branch is not changed.' : 'Nothing has been uploaded yet.'),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => done(true) }, plan.mode === 'pr' ? 'Open pull request' : 'Commit and push'), h('button', { onclick: () => done(false) }, 'Cancel')),
    ].filter(Boolean));
    dlg.addEventListener('cancel', () => done(false), { once: true }); // Esc (see chooseVideo for why not 'close')
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

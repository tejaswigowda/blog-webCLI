import { createNet, fmtBytes } from './net.js';
import { BULK_AT, GitHub, assertToken } from './github.js';
import { NotFound, describePlan, detectAddress, executePlan, listPageFiles, listPostFiles, listMedia, listVideoReleases, loadBlog, loadIndex, loadIndexFull, loadPost, parseRepo, planChange, planExtension, planInit, planSettings, planTheme } from './site.js';
import { createSandbox } from './sandbox.js';
import { describeRelease, executeRelease, listReleaseFolders, planTagRelease, videoRepositories } from './release.js';
import { insertionPoint } from '../lib/selection.js';
import { licenceRecords } from '../lib/licences.js';
import { createEditor, setAssetResolver, setVideoResolver } from './editor.js';
import { Refusal } from '../lib/errors.js';
import { describeError, progressLine, toast, working } from './ui.js';
import { describeDate, loadMoment, nowTime, today } from './dates.js';
import { icon } from './icons.js';
import { fmtClock, pollDeploy } from '../lib/deploy.js';
import { assessBuilds, describeBuilds, noteBuild, recentBuilds } from '../lib/buildrate.js';
import { liveEnabled, ownsNotFoundPage } from '../lib/content.js';
import { READER_SORTS, readerSort, saveSort, savedSort } from '../lib/sort.js';
import { mdToDelta, deltaToMarkdownChecked } from '../lib/markdown.js';
import { SLUG_RE, joinFile, newFront, parseMeta, setMeta, splitFile } from '../lib/frontmatter.js';
import { parsePost } from '../lib/blog.js';
import { filterMedia } from '../lib/media.js';
import { SCHEDULE_WARN_DAYS, daysUntil } from '../lib/schedule.js';
import { resolveAsset } from '../lib/assets.js';
import { videoBase, videoEmbedUrl } from '../lib/video.js';
import { at, parseRepoRef } from '../lib/reporef.js';
import { DEFAULT_CONTENT_BASE, defaultDomain, defaultTitle } from '../lib/init.js';
import { FONTS, resolveLogo, themeCss } from '../lib/customize.js';
import { blogToForm, formToBlog } from '../lib/settings.js';
import { DATE_FORMAT_EXAMPLES, DEFAULT_DATE_FORMAT } from '../lib/datefmt.js';
import { validateBlog } from '../lib/blog.js';
import { indexBody } from '../lib/contracts.js';
import { loadPinnedTheme } from './packs.js';
import { loadRegistry } from './registry-client.js';
import { highlightedTextarea } from './highlight.js';
import { config } from './config.js';
import { authorizeUrl, canRefresh, exchangeCode, installUrl, needsRefresh, newState, oauthConfigured, readCallback, redirectUri, refreshRecord, revokeToken } from './oauth.js';
import { createImportView } from './import-view.js';

const net = createNet();
// Extensions run only here, at publish, in a sandbox that has no DOM, no network and no token.
let sandbox = null;
const runner = (job) => (sandbox ||= createSandbox()).runner(job);
const KEY = 'blog.webcli.token';
const gh = new GitHub(net, { token: sessionStorage.getItem(KEY) || localStorage.getItem(KEY), store: localStorage });
let login = null;

// ---------- sign in with GitHub (a GitHub App's user token; see app/oauth.js) ----------
const OAUTH_KEY = `${KEY}.oauth`; // { refresh, expiresAt, refreshExpiresAt }: kept beside the token, in the same storage
const OAUTH_PENDING = 'blog.webcli.oauth';
const oauthOn = oauthConfigured(config.oauth);
const oauthFetch = (...a) => globalThis.fetch(...a);
const tokenStore = () => (localStorage.getItem(KEY) ? localStorage : sessionStorage);
const oauthRecord = () => { try { return JSON.parse(tokenStore().getItem(OAUTH_KEY)); } catch { return null; } };
function keepOAuth(rec, store) {
  store.setItem(KEY, rec.token);
  store.setItem(OAUTH_KEY, JSON.stringify({ refresh: rec.refresh, expiresAt: rec.expiresAt, refreshExpiresAt: rec.refreshExpiresAt }));
  gh.token = rec.token;
}
// An expiring token is renewed quietly while it is still good; one that cannot be renewed signs the user out, and says so.
async function refreshIfNeeded() {
  const rec = oauthRecord();
  if (!gh.token || !rec || !rec.refresh) return;
  if (!needsRefresh(rec)) return;
  if (!canRefresh(rec)) {
    signOut({ quiet: true });
    toast({ kind: 'info', title: 'Signed out', message: 'Your GitHub sign-in expired. Sign in again.' });
    return;
  }
  try {
    keepOAuth(await refreshRecord(oauthFetch, { proxy: config.oauth.proxy, refresh: rec.refresh }), tokenStore());
  } catch {
    /* the old token may still have a few minutes: try again at the next tick */
  }
}
if (oauthOn) setInterval(refreshIfNeeded, 60_000);

function startOAuth(remember) {
  const state = newState();
  sessionStorage.setItem(OAUTH_PENDING, JSON.stringify({ state, hash: location.hash, remember }));
  location.assign(authorizeUrl({ clientId: config.oauth.clientId, redirect: redirectUri(location), state }));
}

// Back from GitHub: the page is opened with ?code=… (or ?installation_id=… after the repositories were changed). Exchanges the code,
// puts the address back as it was, and says what happened. Returns true when it handled the visit.
async function finishOAuth() {
  const cb = readCallback(location.search);
  if (!cb) return false;
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(OAUTH_PENDING)); } catch { /* none */ }
  sessionStorage.removeItem(OAUTH_PENDING);
  history.replaceState(null, '', `${location.pathname}${(pending && pending.hash) || location.hash}`);
  if (cb.error) { toast({ kind: 'error', title: 'GitHub sign-in stopped', message: cb.error }); return true; }
  if (cb.installed && !cb.code) { toast({ kind: 'success', title: 'Repository access updated' }); return true; }
  if (!oauthOn || !pending || pending.state !== cb.state) { toast({ kind: 'error', title: 'GitHub sign-in refused', message: 'The sign-in did not start in this tab, so it was ignored. Try again.' }); return true; }
  try {
    const rec = await exchangeCode(oauthFetch, { proxy: config.oauth.proxy, code: cb.code, redirect: redirectUri(location) });
    keepOAuth(rec, pending.remember ? localStorage : sessionStorage);
    login = (await gh.whoami()).login;
    const mine = await gh.api('GET', '/user/installations').catch(() => null);
    if (mine && mine.total_count === 0) {
      toast({ kind: 'info', title: 'Choose the repositories this editor may use', message: 'Signed in, but the app is not installed on any repository yet.', action: { label: 'Choose repositories', onClick: () => openTab(installUrl(config.oauth.app)) }, timeout: 0 });
    } else toast({ kind: 'success', title: `Signed in as ${login}` });
  } catch (e) {
    gh.token = null;
    toast({ kind: 'error', ...describeError(e) });
  }
  return true;
}

// A tab keeps running the scripts it loaded: after an update, what it generates is not what the current version would write (a page
// built without a setting the new version knows rewrites every page that has it). Nothing is sent from such a tab: reload it.
// app-build.json is made by cli/build-live.js from every script of app/ and lib/.
const fetchBuild = async () => {
  try {
    const res = await fetch('app-build.json', { cache: 'no-store', credentials: 'omit' });
    return res.ok ? (await res.json()).id || null : null;
  } catch {
    return null;
  }
};
const startedWith = fetchBuild();
async function ensureCurrent() {
  const [was, now] = await Promise.all([startedWith, fetchBuild()]);
  if (was && now && was !== now) throw new Refusal('stale-app', 'The editor was updated after this page was opened. Reload the page (nothing has been sent), then try again.');
}
gh.beforeWrite = ensureCurrent;

// A long job on a big blog: the activity line says how far it has got and when it is waiting out GitHub's limit, and Stop ends it.
// Nothing here changes what the job does; a blog too small to need it never sees more than the label.
const fmtWait = (s) => (s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} s`);
function heavy(label, fn, opts) {
  return working(label, async (update) => {
    const what = label.replace(/…$/, '');
    let stopping = false;
    const stop = () => {
      stopping = true;
      update(`${what} · stopping…`, { stop: null });
    };
    const was = { onProgress: gh.onProgress, onWait: gh.onWait, isCancelled: gh.isCancelled };
    gh.isCancelled = () => stopping;
    gh.onProgress = (verb, done, total) => update(`${what} · ${verb.toLowerCase()} ${done.toLocaleString()} of ${total.toLocaleString()}`, { stop: total > BULK_AT && !stopping ? stop : null });
    gh.onWait = (seconds) => update(`${what} · waiting ${fmtWait(seconds)} for GitHub's rate limit`, { stop: stopping ? null : stop });
    try {
      return await fn();
    } finally {
      Object.assign(gh, was);
    }
  }, opts);
}
let cache = null; // { repo, ref, blog, lock }

const $ = (s) => document.querySelector(s);
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// the header is sticky, so whatever sticks under it needs its height (it wraps on a narrow screen)
const topBar = document.querySelector('#top');
if (topBar && typeof ResizeObserver !== 'undefined') new ResizeObserver(() => document.documentElement.style.setProperty('--top-h', `${topBar.offsetHeight}px`)).observe(topBar);
const view = $('#view');

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'icon') el.dataset.icon = v;
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  if (el.dataset.icon) el.append(icon(el.dataset.icon));
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

// change a button's words and keep its icon (textContent = would drop it)
const relabel = (btn, text) => btn.replaceChildren(...[btn.dataset.icon && icon(btn.dataset.icon), text].filter(Boolean));

// The address a blog is served at is GitHub's to say (its Pages settings), so it is shown, never
// typed: a read-only field and what to do when GitHub says it is not served yet.
function addressView(repo, found, saved) {
  const input = h('input', { value: found && found.exact ? found.address : saved || (found && found.address) || defaultDomain(repo), readonly: true, 'aria-readonly': 'true' });
  const plain = parseRepoRef(repo).repo;
  const pagesLink = (found && found.settingsUrl) || `https://github.com/${plain}/settings/pages`;
  const ext = (href, text) => outbound(text, href, { class: 'link' });
  let note;
  if (!found) note = h('div', { class: 'hint' }, 'GitHub could not be asked just now. Used for links, the feed and og:url.');
  else if (found.exact) note = h('div', { class: 'hint' }, 'From this repository\'s GitHub Pages settings, so it is not edited here. To change it (a custom domain, HTTPS) ', ext(pagesLink, 'open the Pages settings'), '. Used for links, the feed and og:url.');
  else if (found.live) note = h('div', { class: 'hint' }, 'GitHub Pages is on, but this token cannot read its address, so the one saved in blog.json is shown. Give the token "Pages: Read-only" to have it read from GitHub.');
  else note = h('div', { class: 'err' }, h('b', {}, 'GitHub Pages is not enabled for this repository'), `Nothing is served at this address yet (${plain}). Turn it on under `, ext(pagesLink, 'Settings → Pages'), ' (Deploy from a branch → your default branch, / (root)). Until then the blog is readable at ', ext(`blog/${link(repo)}`, 'its reader page'), '.');
  return { input, note };
}

function fail(e) {
  const d = describeError(e);
  return toast({ kind: 'error', title: d.title, message: d.message });
}

// Every commit to the repository the blog lives in is a GitHub Pages build; count them (lib/buildrate.js).
function countBuilds(receipt) {
  const last = receipt.commits[receipt.commits.length - 1];
  if (!last || receipt.pull) return;
  for (const c of receipt.commits) if (c.repo === last.repo) noteBuild(localStorage, c.repo);
}

// What the pre-flight says about the build this commit starts, before anything is sent.
function buildNote(plan) {
  if (plan.mode === 'pr' || !plan.changes.length) return null;
  const a = assessBuilds(recentBuilds(localStorage, plan.repo).length);
  if (a.level === 'ok') return null;
  const here = cache && parseRepoRef(cache.repo).repo === plan.repo ? cache.blog : null;
  return h('div', { class: a.level === 'limit' ? 'err' : 'caution' }, describeBuilds(a, { readersSeeIt: !!here && liveEnabled(here) }));
}

function sent(receipt, opts = {}) {
  countBuilds(receipt);
  const links = [
    ...receipt.commits.map((c) => ({ href: c.url, text: `${c.files} file${c.files === 1 ? '' : 's'} → ${c.repo}@${c.branch} (${c.sha.slice(0, 8)})` })),
    ...(receipt.pull ? [{ href: receipt.pull.url, text: `Pull request #${receipt.pull.number}` }] : []),
  ];
  return toast({ kind: 'success', title: opts.title || (receipt.pull ? 'Pull request opened' : 'Sent'), message: opts.message || '', links, action: opts.action });
}

// Navigation is done with buttons: they go to a place in this app (the hash) or open another site.
const go_ = (hash) => () => { location.hash = hash; };
const nav = (label, hash, attrs = {}) => h('button', { type: 'button', ...attrs, onclick: go_(hash) }, label);
const openTab = (url) => window.open(url, '_blank', 'noopener');
const outbound = (label, url, attrs = {}) => h('button', { type: 'button', ...attrs, 'data-href': url, onclick: (e) => openTab(e.currentTarget.dataset.href) }, label);

// A post's date as words ("Yesterday", "3 days ago", "Oct 12"); the full date is in the tooltip.
function dateEl(iso, { long = false } = {}) {
  const d = describeDate(iso);
  return h('time', { datetime: iso, title: d.full }, long ? (d.relative && d.full !== d.relative ? `${d.full} · ${d.relative}` : d.full) : d.label);
}

// Where a publish is on its way to readers: committed -> building -> live (0:34), and the link withheld until
// GitHub says the build is live. The state is GitHub's own (lib/deploy.js), not a guess.
function deployPanel({ gh, repo, hasPages }) {
  const box = h('div', { class: 'deploy', hidden: true, 'aria-live': 'polite' });
  let run = 0; // a newer publish replaces the one being watched

  const copy = async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ kind: 'success', title: 'Link copied', message: url });
    } catch {
      toast({ kind: 'info', title: 'Copy this link', message: url, timeout: 0 });
    }
  };

  function draw(st, ctx) {
    const live = st.state === 'live';
    const failed = st.state === 'failed';
    const waiting = st.state === 'committed' || st.state === 'unknown';
    const stage = (label, cls) => h('li', { class: `step ${cls}`, 'aria-current': cls === 'active' ? 'step' : null }, label);
    const clock = st.seconds !== undefined ? ` (${fmtClock(st.seconds)})` : '';
    const steps = h('ol', { class: 'steps' },
      stage('Committed', 'done'),
      stage(failed ? 'Build failed' : st.state === 'building' || waiting ? `Building${st.state === 'building' ? clock : ''}` : 'Built', failed ? 'failed' : live ? 'done' : st.state === 'building' ? 'active' : 'todo'),
      stage(live ? `Live${clock}` : 'Live', live ? 'done' : 'todo'));
    const parts = [steps];
    const say = (text, cls = 'hint') => parts.push(h('div', { class: cls }, text));
    if (st.state === 'failed') {
      say(`GitHub Pages could not build the site: ${st.error}${ctx.soft ? ' Readers still see the current text: their pages check the repository themselves.' : ''}`, 'err');
    } else if (st.state === 'unknown') {
      say(st.reason, 'caution');
    } else if (!ctx.published) {
      say('Saved as a draft: nothing is public, so there is no link to share.');
    } else if (live) {
      say('Live. Link previews will now show this post too.');
    } else {
      say(ctx.soft
        ? 'Readers can already open this link and see the current text. Link previews (Slack, iMessage, social cards) read the built page, so they wait for the build.'
        : ctx.isNew ? 'This link will not work for anyone until the build finishes.' : 'Readers see the previous version until the build finishes.');
      if (st.stalled) say(`No build has started after three minutes: GitHub Pages may be throttling builds (about 10 an hour).${ctx.soft ? ' Your readers still see the current text.' : ''}`, 'caution');
    }
    parts.push(h('div', { class: 'actions' },
      ctx.published ? h('button', { type: 'button', icon: 'copy', disabled: !live, title: live ? ctx.url : 'Available once the build is live', onclick: () => copy(ctx.url) }, 'Copy link') : null,
      failed ? outbound('Open the build log', `https://github.com/${repo}/actions`, { icon: 'external-link' }) : null));
    box.replaceChildren(...parts);
  }

  async function track(ctx) {
    const mine = ++run;
    box.hidden = false;
    if (!hasPages) {
      draw({ state: 'unknown', reason: 'GitHub Pages is not enabled for this repository, so there is no deployment to follow. Turn it on under Settings → Pages.' }, ctx);
      return;
    }
    draw({ state: 'committed', seconds: 0 }, ctx);
    try {
      await pollDeploy({ getBuild: () => gh.pagesBuild(repo), getDeployment: () => gh.pagesDeployment(repo, ctx.sha), sha: ctx.sha, since: ctx.since, onState: (st) => { if (mine === run) draw(st, ctx); }, signal: { get aborted() { return mine !== run; } } });
    } catch (e) {
      if (mine === run) draw({ state: 'unknown', reason: `Could not read the build state: ${e.message}` }, ctx);
    }
  }
  return { el: box, track };
}

const noted = (message) => toast({ kind: 'info', message });

function errBox(e) {
  if (e instanceof Refusal) return h('div', { class: 'err' }, h('b', {}, `Refused: ${e.code}`), e.detail);
  return h('div', { class: 'err' }, h('b', {}, 'Something went wrong'), e.message || String(e));
}

// ---------- chrome ----------

const parseHash = () => {
  const p = new URLSearchParams(location.hash.slice(1));
  const mode = p.has('import') ? 'import' : p.has('themes') ? 'themes' : p.has('extensions') ? 'extensions' : p.has('licences') ? 'licences' : p.has('settings') ? 'settings' : p.has('media') ? 'media' : p.has('new') || p.has('newpage') ? 'new' : p.has('correct') || p.has('correctpage') ? 'correct' : p.has('edit') || p.has('editpage') ? 'edit' : null;
  // a standalone page (pages/<slug>.md) is edited, or corrected by pull request, with the same editor as a post
  const kind = p.has('newpage') || p.has('editpage') || p.has('correctpage') ? 'page' : 'post';
  return { repo: p.get('repo'), post: p.get('post') || p.get('edit') || p.get('editpage') || p.get('correct') || p.get('correctpage'), ref: p.get('ref') || undefined, mode, kind };
};
const link = (repo, extra = '') => `#repo=${repo}${extra}`;

function renderTop(repo, ref) {
  const input = h('input', { name: 'repo', placeholder: 'owner/blog or owner/repo/folder', value: repo || '', 'aria-label': 'Repository' });
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); try { location.hash = link(parseRepo(input.value)); } catch (err) { view.replaceChildren(errBox(err)); } } }, input, h('button', { icon: 'arrow-right' }, ''));
  const auth = gh.token
    ? h('span', { class: 'signed', title: login ? `Signed in as ${login}` : 'Signed in' }, icon('user'), h('span', { class: 'who' }, login || 'Signed in'), oauthOn && /^ghu_/.test(gh.token) ? h('button', { type: 'button', class: 'icon-btn', icon: 'sliders', title: 'Repository access', 'aria-label': 'Repository access', onclick: () => openTab(installUrl(config.oauth.app)) }) : null, h('button', { type: 'button', class: 'icon-btn', icon: 'log-out', title: 'Sign out', 'aria-label': 'Sign out', onclick: () => signOut() }))
    : h('button', { type: 'button', class: 'primary', icon: 'log-in', onclick: () => signInDialog() }, 'Sign in to edit');
  $('#top').replaceChildren(
    nav('blog webCLI', repo ? link(repo, ref ? `&ref=${ref}` : '') : '', { class: 'brand', title: repo ? `Back to ${repo}` : 'Home' }),
    h('span', { class: 'pill' }, 'git-native'),
    h('span', { class: 'badge-local', title: 'The editor commits straight to GitHub from this page. There is no server in between.' }, 'No server in between'),
    form,
    auth,
    outbound('Fork on GitHub', 'https://github.com/tejaswigowda/blog-webCLI', { class: 'gh-link' }),
  );
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

function signOut({ quiet = false } = {}) {
  if (oauthOn && gh.token && /^ghu_/.test(gh.token)) revokeToken(oauthFetch, { proxy: config.oauth.proxy, token: gh.token });
  for (const s of [sessionStorage, localStorage]) {
    s.removeItem(KEY);
    s.removeItem(OAUTH_KEY);
  }
  gh.token = null;
  login = null;
  if (!quiet) route();
  else renderTop(parseHash().repo, parseHash().ref);
}

function signInDialog() {
  const dlg = $('#dlg');
  const tok = h('input', { type: 'password', name: 'token', autocomplete: 'off', placeholder: 'github_pat_…', style: 'width:100%' });
  const remember = h('input', { type: 'checkbox' });
  const msg = h('div');
  const expert = [
    oauthOn ? null : h('h2', {}, 'Sign in with a fine-grained token'),
    h('p', {}, 'Create a ', outbound('fine-grained personal access token', 'https://github.com/settings/personal-access-tokens/new', { class: 'link' }), ' limited to your blog repository and your asset repositories, with ', h('b', {}, 'Contents: read & write'), ' and ', h('b', {}, 'Pull requests: write'), '. Classic tokens are refused: they can write to every repository you own.'),
    tok,
    h('p', {}, h('label', {}, remember, ' Remember on this device (localStorage). Otherwise the token lives only for this tab.')),
    msg,
    h('div', { class: 'actions' }, h('button', { class: 'primary', icon: 'log-in', onclick: async () => {
      try {
        const t = tok.value.trim();
        assertToken(t);
        gh.token = t;
        login = (await gh.whoami()).login;
        (remember.checked ? localStorage : sessionStorage).setItem(KEY, t);
        localStorage.removeItem(OAUTH_KEY);
        sessionStorage.removeItem(OAUTH_KEY);
        dlg.close();
        route();
      } catch (e) {
        gh.token = null;
        msg.replaceChildren(errBox(e.status === 401 ? new Error('GitHub rejected that token.') : e));
      }
    } }, 'Sign in'), h('button', { icon: 'x', onclick: () => dlg.close() }, 'Cancel')),
  ].filter(Boolean);
  if (!oauthOn) dlg.replaceChildren(...expert);
  else {
    const keep = h('input', { type: 'checkbox' });
    dlg.replaceChildren(
      h('h2', {}, 'Sign in with GitHub'),
      h('p', {}, 'GitHub asks which repositories this editor may use (your blog and its asset repositories) and nothing else: it can write only to those, and only contents and pull requests. You can change that choice or revoke it on GitHub at any time.'),
      h('p', {}, h('label', {}, keep, ' Remember on this device (localStorage). Otherwise the sign-in lives only for this tab.')),
      h('div', { class: 'actions' }, h('button', { class: 'primary', icon: 'log-in', onclick: () => startOAuth(keep.checked) }, 'Sign in with GitHub'), h('button', { icon: 'x', onclick: () => dlg.close() }, 'Cancel')),
      h('details', { class: 'more' }, h('summary', {}, 'Use a token instead'), ...expert),
    );
  }
  dlg.showModal();
}

// ---------- routing ----------

let seq = 0;
let importer = null; // the WordPress import wizard keeps its state for the life of the page
let asking = false; // a whoami request is in flight
async function route() {
  const mine = ++seq;
  const r = parseHash();
  renderTop(r.repo, r.ref);
  renderLedger(net.ledger);
  document.title = 'blog.webcli.app';
  view.replaceChildren(progressLine('Loading…'));
  // the header names the user on every page, the start page included
  if (gh.token && !login && !asking) {
    asking = true;
    gh.whoami().then((u) => { login = u.login; renderTop(parseHash().repo, parseHash().ref); }, () => {}).finally(() => { asking = false; });
  }
  try {
    if (r.mode === 'import') {
      document.title = 'Import from WordPress · blog.webcli.app';
      importer ||= createImportView({ h, nav, gh, net, link, fmtBytes, working, confirmPlan, sent, fail, toast, signInDialog, icon });
      view.replaceChildren(importer());
      return;
    }
    if (r.mode === 'licences' && !r.repo) {
      document.title = 'Licences · blog.webcli.app';
      const node = await toolLicencesView();
      if (mine === seq) view.replaceChildren(node);
      return;
    }
    if (!r.repo) return home();
    const repo = parseRepo(r.repo);
    if (!cache || cache.repo !== repo || cache.ref !== r.ref) cache = { repo, ref: r.ref, ...(await loadBlog(gh, repo, r.ref)) };
    if (mine !== seq) return;
    let node;
    if (r.mode === 'themes') node = await themesView(repo, r);
    else if (r.mode === 'extensions') node = await extensionsView(repo, r);
    else if (r.mode === 'licences') node = licencesView(repo, r);
    else if (r.mode === 'settings') node = await settingsView(repo, r);
    else if (r.mode === 'media') node = await mediaView(repo, r);
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
    view.replaceChildren(e instanceof NotFound ? h('div', {}, h('p', {}, 'No such post.'), nav('Back to the blog', link(r.repo))) : errBox(e));
  }
}

function home() {
  view.replaceChildren(
    h('h1', {}, 'A blog is a GitHub repository'),
    h('p', {}, 'Open any blog with ', h('code', {}, '#repo=owner/blog'), ', or ', h('code', {}, '#repo=owner/repo/folder'), ' when the blog lives in a folder of a repository it shares with its images or videos. Posts are markdown with frontmatter, assets live in their own repositories or folders, and publishing commits the markdown and regenerates plain static pages, an index and a feed.'),
    h('p', { class: 'muted' }, 'Nothing is hosted here and nothing is uploaded until you publish. The egress ledger below counts every byte.'),
    h('div', { class: 'card' }, h('div', { class: 'card-header' }, 'Coming from WordPress?'), h('div', { class: 'card-body' },
      h('p', {}, 'Bring a WordPress blog (or several) into a GitHub repository: every post, page and draft as markdown, every picture in an images folder, and a blog.webcli.app blog around them. You choose an export file; nothing is sent until you have seen the pre-flight.'),
      h('div', { class: 'actions' }, nav('Import from WordPress', '#import', { class: 'primary', icon: 'upload' })),
    )),
    h('p', { class: 'hint' }, nav('Licences and dependencies of this tool', '#licences')),
  );
}

// What this tool is made of, from licences-inventory.json (generated by cli/inventory.js, checked in CI). Everything shown is text:
// nothing in the file is rendered as markup, and an address is offered as a link only when it is an https address.
const SURFACES = { runtime: 'runtime: built into the scripts a blog\'s pages load', tool: 'tool: the editor, reader and command line', dev: 'dev: build and test only' };
async function toolLicencesView() {
  let inv;
  try {
    const res = await fetch('licences-inventory.json', { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    inv = await res.json();
    if (!inv || !Array.isArray(inv.items)) throw new Error('not an inventory');
  } catch (e) {
    return h('div', {}, h('h1', {}, 'Licences'), errBox(new Error(`The inventory could not be read (${e.message}). It is licences-inventory.json in the repository.`)));
  }
  const str = (v) => (typeof v === 'string' ? v.slice(0, 200) : '');
  const items = inv.items.filter((i) => i && typeof i === 'object').map((i) => ({ name: str(i.name), version: str(i.version), licence: str(i.licence), upstream: /^https:\/\/[^\s]+$/.test(str(i.upstream)) ? str(i.upstream) : '', surfaces: (Array.isArray(i.surfaces) ? i.surfaces : []).filter((x) => x in SURFACES) }));
  const cell = { style: 'text-align:left;border-bottom:1px solid var(--rule);padding:.3rem .5rem;vertical-align:top' };
  const section = (surface) => {
    const rows = items.filter((i) => i.surfaces.includes(surface) && !(surface === 'dev' && i.name.startsWith('@esbuild/')));
    const hidden = surface === 'dev' ? items.filter((i) => i.surfaces.includes('dev')).length - rows.length : 0;
    return h('div', {}, h('h2', {}, SURFACES[surface]),
      h('table', { style: 'width:100%;border-collapse:collapse' }, h('thead', {}, h('tr', {}, ['Name', 'Version', 'Licence', 'From'].map((t) => h('th', cell, t)))),
        h('tbody', {}, rows.map((i) => h('tr', {}, h('td', cell, i.name), h('td', cell, i.version), h('td', cell, i.licence), h('td', cell, i.upstream ? outbound(i.upstream.replace(/^https:\/\//, ''), i.upstream, { class: 'link' }) : ''))))),
      hidden ? h('p', { class: 'hint' }, `…and ${hidden} platform builds of the same tool.`) : null);
  };
  return h('div', {}, h('p', {}, nav('Home', '#', { icon: 'arrow-left' })),
    h('h1', {}, 'Licences and dependencies of this tool'),
    h('p', { class: 'muted' }, 'The runtime (the generator and renderer, MIT) is what generated pages carry; the tool (the editor, reader and command line, GPL-3.0-only) is not distributed. Every third-party file is listed with its licence and where it came from. The list is generated, and the build fails if anything unlicensed or copyleft reaches the runtime.'),
    section('runtime'), section('tool'), section('dev'));
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
  const go = h('button', { class: 'primary', icon: 'plus' }, 'Create blog…');
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const fields = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
      const plan = await heavy('Preparing the blog…', () => planInit(gh, { repo, branch, fields, runner }), { button: go });
      if (!(await confirmPlan(plan))) return;
      const receipt = await heavy('Committing…', () => executePlan(gh, plan), { button: go });
      sent(receipt, { title: 'Blog created', action: { label: 'Open the blog', onClick: () => { cache = null; route(); } } });
    } catch (e) {
      fail(e.status === 409 ? new Error(`${plain} is empty, and GitHub needs one commit before anything else can be written. Add a README on GitHub, then try again.`) : e);
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
  if (!entries.length) entries = [{ slug: 'sample', title: 'A sample post', date: today(), tags: ['sample'], excerpt: 'The first lines of a post appear here, as the list shows them.' }];

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
    // the preview is narrower than a page and cannot answer a theme's viewport rules, so its content gets a margin of its own
    shadow.innerHTML = `<style>${forShadow(themeCss(next, themePack))}</style><style>.pv{padding:0 1.25rem 1rem;overflow-x:hidden;word-wrap:break-word}</style><div class="pv ${esc(body.bodyClass)}" style="pointer-events:none">${body.html}</div>`;
  };

  // The live preview sits with the form, where the settings are; the colours sit in the side panel, beside the theme.
  const previewCard = h('div', { class: 'card' }, h('div', { class: 'card-header' }, 'Preview'), h('div', { class: 'card-body' }, preview, msg));
  const colorsBox = section('Colors', h('div', { class: 'colors' }, h('span', {}), h('b', {}, 'Light'), h('b', {}, 'Dark'), ...colorRows), h('div', { class: 'hint' }, 'Leave blank for the default. A colour with no dark value keeps the default dark palette.'));
  const form = h(
    'form',
    { onsubmit: (e) => e.preventDefault() },
    section('General', h('div', { class: 'row' }, field('Title', input('title')), field('Author', input('author'))), h('div', { class: 'row' }, field('Description', input('description'))), h('div', { class: 'row' }, field('Address the blog is served at', bind('domain', addr.input), addr.note))),
    section(
      'Media repositories',
      h('div', { class: 'row' }, field('Images', input('images', { placeholder: homeFolder('images') })), field('Audio', input('audio', { placeholder: 'owner/name or owner/name/folder' })), field('Video', input('video', { placeholder: homeFolder('videos') }))),
      h('details', {}, h('summary', {}, 'URL templates (change CDN or player)'), h('div', { class: 'row' }, field('Image / audio URL', input('assetBase', { placeholder: 'https://…{owner}/{repo}@{sha}/{path}' }))), h('div', { class: 'row' }, field('Video player', input('videoPlayer')), field('Video URL', input('videoBase')))),
    ),
    section(
      'Post order',
      h('div', { class: 'row' }, field('Order the blog by', select('orderBy', [['date', 'Date'], ['title', 'Title'], ['manual', 'A list I keep (order.json)'], ['frontmatter', 'A frontmatter field']])), field('Direction', select('orderDir', [['', 'Default'], ['asc', 'Ascending'], ['desc', 'Descending']]))),
      h('div', { class: 'row' }, field('Frontmatter field', input('orderField', { placeholder: 'episode' }), 'Every published post must have it, all numbers or all text.'), field('List file', input('orderList', { placeholder: 'order.json' }), '{"order": ["first-slug", "second-slug"]}: drafts may be in it; a post that is in no list is added at the end, by date.')),
      h('div', { class: 'hint' }, 'Newest first is the default. This sets the index, the previous/next links on every page and the order of the feed document; a reader can still sort the list for themselves, which changes nothing else. Ties are broken by slug, always.'),
    ),
    section(
      'Publishing speed',
      check('live', 'Show new and edited posts to readers before the GitHub Pages build finishes'),
      h('div', { class: 'hint' }, 'GitHub Pages takes from seconds to minutes to publish what you commit. With this on, each page checks the repository itself (one small file request, no account, no API) and shows the current text, and a post that has no page yet is drawn at its address. Search engines and link previews still wait for the build.'),
      h('details', {}, h('summary', {}, 'Where the live copy is read from'), h('div', { class: 'row' }, field('Content URL', input('contentBase', { placeholder: DEFAULT_CONTENT_BASE }), 'A template ending in /{path}, using {owner} and {repo}. Blank: the default.'))),
    ),
    section(
      'Readers',
      check('search', 'Add a search page'),
      h('div', { class: 'hint' }, 'Search runs in the reader\'s browser against a file written at publish (search.json). It adds one same-origin script, on the search page only; nothing is sent anywhere.'),
      h('div', { class: 'row' }, field('Date format', input('dateFormat', { placeholder: DEFAULT_DATE_FORMAT, list: 'date-formats', spellcheck: 'false' }), h('div', { class: 'hint' }, 'How a post\'s date reads on every page and in the /blog/ reader: a ', outbound('moment.js format', 'https://momentjs.com/docs/#/displaying/format/', { class: 'link' }), ', such as MMM D, YYYY or D MMMM YYYY. YYYY-MM-DD shows the plain date. The preview shows it as you type; feeds and search engines always get the ISO date.'), h('datalist', { id: 'date-formats' }, DATE_FORMAT_EXAMPLES.map((x) => h('option', { value: x }))))),
      h('div', { class: 'row' }, field('Time zone', input('timezone', { placeholder: 'UTC' }), 'An IANA name like America/Phoenix. Used only to read the time of a scheduled post (publish_at); with none, that time is UTC.')),
      h('div', { class: 'row' }, field('Related posts', input('related', { type: 'number', min: 1, max: 10, placeholder: 'none' }), 'Lists this many posts that share tags with each post. Every post then depends on the posts sharing its tags: publishing one rewrites each of their pages, and the pre-flight says how many.')),
      h('div', { class: 'row' }, field('Posts per page', input('pageSize', { type: 'number', min: 1, max: 100, placeholder: 'all on one page' }), 'Splits the index and the tag and author pages. The feed and the /blog/ reader still list everything.')),
      h('div', { class: 'row' }, h('div', {}, check('pageStable', 'Stable page addresses (for a big blog)'), h('div', { class: 'hint' }, 'Counts pages from the oldest post, so publishing a post changes the front page and nothing else, instead of every page: far fewer files to send. The addresses of the older pages (page/1/ is the oldest) then never change. Turning it on or off renames the pages once.'))),
      h('div', { class: 'row' }, h('div', {}, check('linkStyle', 'Link the stylesheet instead of putting it in every page (for a big blog)'), h('div', { class: 'hint' }, 'Every page carries the blog\'s CSS, so changing a colour, a font or the custom CSS rewrites every page of the blog. Linked, the CSS is one file (style.css) and that change is one file. Turning it on or off rewrites every page once.'))),
      h('div', { class: 'row' }, field('Email subscribe form posts to', input('subAction', { placeholder: 'https://… (your newsletter provider\'s form address)' }), 'A plain HTML form: the address a reader types goes straight to that service, never through this page. Blank: no form.'), field('Email field name', input('subField', { placeholder: 'email' }))),
      h('details', {}, h('summary', {}, 'Subscribe form wording and hidden fields'), h('div', { class: 'row' }, field('Heading', input('subTitle', { placeholder: 'Subscribe by email' })), field('Button', input('subButton', { placeholder: 'Subscribe' }))), h('div', { class: 'row' }, field('Hidden fields', area('subHidden', 2, { placeholder: 'list=abc123', class: 'mono', spellcheck: 'false' }), 'One per line: name=value, as your provider asks.'))),
    ),
    section(
      'Search engines',
      h('div', { class: 'row' }, field('Twitter / X handle', input('seoTwitter', { placeholder: '@name' }), 'Added to link previews as twitter:site.')),
      h('div', {}, check('seoSitemap', 'Write sitemap.xml'), check('seoRobots', 'Write robots.txt (only where the blog is at the root of its address)')),
      h('div', { class: 'hint' }, 'Switching one off stops it being updated; delete a file you no longer want. A robots.txt you wrote yourself is replaced while this is on.'),
    ),
    section(
      'Comments and analytics',
      h('div', { class: 'hint' }, 'Both load a script from the address you name, on your readers\' pages, with that page\'s full powers: only name a service you trust, and prefer one that gives an integrity value to pin (put it in the attributes). Off unless you fill them in.'),
      h('div', { class: 'row' }, field('Comments script', input('commentsSrc', { placeholder: 'https://… (e.g. a GitHub-Discussions comments widget)' })), field('Attributes', area('commentsAttrs', 3, { placeholder: 'data-repo=owner/blog', class: 'mono', spellcheck: 'false' }), 'name=value per line: data-…, crossorigin, integrity.')),
      h('div', { class: 'row' }, field('Analytics script', input('analyticsSrc', { placeholder: 'https://… (a privacy-friendly counter)' })), field('Attributes', area('analyticsAttrs', 3, { placeholder: 'data-domain=example.com', class: 'mono', spellcheck: 'false' }), 'name=value per line.')),
    ),
    previewCard,
    section(
      'Type and layout',
      h('div', { class: 'row' }, field('Body font', select('font', fontOpts)), field('Heading font', select('headingFont', fontOpts))),
      h('div', { class: 'row' }, field('Content width', input('width', { placeholder: '40rem' }), '25–80rem, 400–1280px or 40–120ch'), field('Text size', input('fontSize', { placeholder: '18px' }), '14–24px or 0.875–1.5rem')),
      h('div', { class: 'row' }, field('Post list', select('layout', [['list', 'List'], ['cards', 'Cards']])), h('div', {}, check('excerpts', 'Show excerpts'), check('dates', 'Show dates'), check('tags', 'Show tags'))),
    ),
    section(
      'Header and footer',
      h('div', { class: 'row' }, field('Top bar text', input('topbarText', { placeholder: 'A line above the header' })), field('Top bar links', area('topbarLinks', 3, { placeholder: 'Facebook | https://facebook.com/you | asset:images/facebook.png' }), 'A bar above the header. One per line: Label | https://address, and after another | an icon from your images repository.')),
      h('div', { class: 'row' }, field('Logo', input('logo', { placeholder: 'asset:images/logo.png' }), 'An image already in your images repository; pinned when you save.'), h('div', {}, check('showTitle', 'Show the title next to the logo'))),
      h('div', { class: 'row' }, field('Header links', area('headerLinks', 3, { placeholder: 'About | https://example.com/about' }), 'One per line: Label | https://address (up to 8); an icon may follow a second |.')),
      h('div', { class: 'row' }, field('Footer text', input('footerText', { placeholder: '© 2026 Your Name' })), field('Footer links', area('footerLinks', 3, { placeholder: 'Source | https://github.com/you/blog' }))),
    ),
    section('Custom CSS', highlightedTextarea(area('css', 6, { class: 'mono', spellcheck: 'false', placeholder: '.posts h2 { letter-spacing: .02em }' })), h('div', { class: 'hint' }, 'Rules, @media, @supports and @keyframes only. No url(), @import, @font-face or escapes: a stylesheet cannot load anything.')),
  );
  let timer = null;
  form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(redraw, 120); });
  form.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(redraw, 0); });

  const save = h('button', { class: 'primary', icon: 'save' }, 'Save settings…');
  save.disabled = !canPush;
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const plan = await heavy('Preparing the changes…', () => planSettings(gh, { repo, branch, form: collect(), runner }), { button: save });
      if (plan.unchanged) {
        noted('Nothing to save: the repository already has these settings.');
        return;
      }
      if (!(await confirmPlan(plan))) return;
      const receipt = await heavy('Committing…', async () => {
        const rc = await executePlan(gh, plan);
        cache = null;
        cache = { repo, ref: r.ref, ...(await loadBlog(gh, repo, r.ref)) };
        return rc;
      }, { button: save });
      sent(receipt, { title: 'Settings saved', message: 'blog.json and every generated page were updated together.' });
    } catch (e) {
      fail(e);
    } finally {
      save.disabled = !canPush;
    }
  });

  const themeBox = section('Theme, extensions and licences',
      h('p', {}, `Theme: ${current.theme && typeof current.theme === 'object' ? `${current.theme.name} ${current.theme.version} (${current.theme.licence})` : 'default'} · Extensions: ${(current.extensions || []).length ? current.extensions.map((e) => `${e.name} ${e.version}`).join(', ') : 'none'}`),
      h('div', { class: 'actions' }, nav('Choose a theme', link(repo, '&themes'), { icon: 'droplet' }), nav('Extensions', link(repo, '&extensions'), { icon: 'box' }), nav('Licences', link(repo, '&licences'), { icon: 'shield' })));

  const node = h(
    'div',
    {},
    h('p', {}, nav(current.title, link(repo), { icon: 'arrow-left' })),
    h('div', { class: 'sticky-bar' }, h('h1', {}, 'Blog settings'), save),
    h('p', { class: 'muted' }, `Saved to ${at(folder, 'blog.json')} in ${plain}. Posts are never touched; every generated page is regenerated from the new settings.`),
    canPush ? null : h('div', { class: 'err' }, `This token cannot write to ${plain}.`),
    h('div', { class: 'cols' }, form, h('div', { class: 'side tall' }, themeBox, colorsBox)),
  );
  queueMicrotask(redraw);
  return node;
}

// ---------- themes, extensions, licences ----------

// The lists of themes and extensions come from the registry (a data repository, address in app/config.js), with a bundled
// snapshot as the fallback. A listed entry is convenience only: a repository works by its address whether or not it is listed,
// and the registry's own fields never decide what is pinned (see lib/registry.js).
let snapshotPromise = null;
async function readList(kind) {
  snapshotPromise ||= fetch(new URL('./registry-snapshot.json', import.meta.url), { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({ version: 1, themes: [], extensions: [] }));
  const snapshot = await snapshotPromise;
  return loadRegistry(kind, { url: config.registry, snapshot });
}

// Where the list came from, said plainly.
const listNote = (res) => (res.source === 'snapshot'
  ? h('p', { class: 'muted' }, `Showing the list bundled with this app: the registry could not be read (${res.why}).`)
  : res.rejected.length ? h('p', { class: 'muted' }, `${res.rejected.length} registry entr${res.rejected.length === 1 ? 'y was' : 'ies were'} not valid and ${res.rejected.length === 1 ? 'is' : 'are'} not shown.`) : null);

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

async function commitPlan(plan, repo, r, button) {
  if (plan.unchanged) {
    noted('Nothing to change: the repository already matches.');
    return;
  }
  if (!(await confirmPlan(plan))) return;
  const receipt = await heavy('Committing…', async () => {
    const rc = await executePlan(gh, plan);
    cache = null;
    cache = { repo, ref: r.ref, ...(await loadBlog(gh, repo, r.ref)) };
    return rc;
  }, { button });
  sent(receipt, { title: 'Saved', message: 'blog.json and every generated page were updated together.' });
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
  const registry = await readList('themes');
  const listed = registry.entries;
  const use = async (spec, btn) => {
    btn.disabled = true;
    try {
      const plan = await heavy('Preparing the theme…', () => planTheme(gh, { repo, branch, use: spec, runner }), { button: btn });
      await commitPlan(plan, repo, r, btn);
    } catch (e) {
      fail(e);
    } finally {
      btn.disabled = !canPush;
    }
  };
  const t = blog.theme && typeof blog.theme === 'object' ? blog.theme : null;
  const input = h('input', { placeholder: 'owner/theme-repo@v1.0.0   (or owner/repo/folder@v1.0.0)', style: 'width:100%' });
  const go = h('button', { class: 'primary', icon: 'check' }, 'Use this theme…');
  go.addEventListener('click', () => { try { use(parseAddress(input.value), go); } catch (e) { fail(e); } });
  go.disabled = !canPush;
  const builtin = h('button', {}, 'Use the default theme');
  builtin.disabled = !canPush || !t;
  builtin.addEventListener('click', () => use(null, builtin));
  return h(
    'div',
    {},
    h('p', {}, nav('Settings', link(repo, '&settings'), { icon: 'arrow-left' })),
    h('h1', {}, 'Theme'),
    h('p', {}, t ? h('span', {}, 'Current: ', h('b', {}, `${t.name} ${t.version}`), ` — ${t.licence} — ${t.repo}@${t.ref}`) : 'Current: the default theme.'),
    h('p', { class: 'hint' }, 'A theme is a repository (theme.json + CSS). It is pinned to a tag or commit and a sha256, so it cannot change under your published pages. Its CSS is baked into the generated pages; readers load nothing from the theme repository.'),
    h('h3', {}, 'By address'),
    h('p', { class: 'hint' }, 'Any repository works, listed or not.'),
    input,
    h('div', { class: 'actions' }, go, builtin),
    h('h3', {}, 'Listed'),
    listNote(registry),
    listed.length
      ? h('ul', { class: 'posts' }, listed.map((e) => { const b = h('button', { icon: 'check' }, 'Use…'); b.disabled = !canPush; b.addEventListener('click', () => { try { use({ ...parseAddress(`${e.repo}@${e.ref}`), expect: { sha256: e.sha256, licence: e.licence } }, b); } catch (err) { fail(err); } }); return h('li', {}, e.screenshot && /^https:\/\//.test(e.screenshot) ? h('img', { src: e.screenshot, alt: '', style: 'max-width:12rem;float:right;margin-left:1rem' }) : null, h('h3', {}, e.name), h('div', { class: 'muted' }, `${e.licence || 'licence not stated'} · ${e.repo}@${e.ref}`), e.blurb ? h('p', {}, e.blurb) : null, b); }))
      :       h('p', { class: 'muted' }, 'The list could not be read. Any theme repository still works by its address.'),
  );
}

async function extensionsView(repo, r) {
  if (!gh.token) return needSignIn('extensions');
  const { blog } = cache;
  const { branch, canPush } = await packContext(repo, r);
  const registry = await readList('extensions');
  const listed = registry.entries;
  const act = async (args, btn) => {
    btn.disabled = true;
    try {
      const plan = await heavy('Running the extension in the sandbox…', () => planExtension(gh, { repo, branch, ...args, runner }), { button: btn });
      await commitPlan(plan, repo, r, btn);
    } catch (e) {
      fail(e);
    } finally {
      btn.disabled = !canPush;
    }
  };
  const input = h('input', { placeholder: 'owner/extension-repo@v1.0.0', style: 'width:100%' });
  const add = h('button', { class: 'primary', icon: 'plus' }, 'Add this extension…');
  add.disabled = !canPush;
  add.addEventListener('click', () => { try { act({ add: parseAddress(input.value) }, add); } catch (e) { fail(e); } });
  const current = blog.extensions || [];
  return h(
    'div',
    {},
    h('p', {}, nav('Settings', link(repo, '&settings'), { icon: 'arrow-left' })),
    h('h1', {}, 'Extensions'),
    h('p', { class: 'hint' }, 'An extension is code, so it runs only when you publish, in a sandbox with no DOM, no network and no access to your token. What it returns is committed with your pages; the published blog contains no extension code, and readers run none.'),
    h('h3', {}, 'In use'),
    current.length
      ? h('ul', { class: 'posts' }, current.map((e) => { const b = h('button', { icon: 'x' }, 'Remove…'); b.disabled = !canPush; b.addEventListener('click', () => act({ remove: e.repo }, b)); return h('li', {}, h('h3', {}, `${e.name} ${e.version}`), h('div', { class: 'muted' }, `${e.licence} · ${e.repo}@${e.ref}${e.hooks ? ` · ${e.hooks.join(', ')}` : ''}`), b); }))
      : h('p', { class: 'muted' }, 'None.'),
    h('h3', {}, 'By address'),
    input,
    h('div', { class: 'actions' }, add),
    h('h3', {}, 'Listed'),
    listNote(registry),
    listed.length
      ? h('ul', { class: 'posts' }, listed.map((e) => { const b = h('button', { icon: 'plus' }, 'Add…'); b.disabled = !canPush; b.addEventListener('click', () => { try { act({ add: { ...parseAddress(`${e.repo}@${e.ref}`), expect: { sha256: e.sha256, licence: e.licence } } }, b); } catch (err) { fail(err); } }); return h('li', {}, h('h3', {}, e.name), h('div', { class: 'muted' }, `${e.licence || 'licence not stated'} · ${e.repo}@${e.ref}`), e.blurb ? h('p', {}, e.blurb) : null, b); }))
      :       h('p', { class: 'muted' }, 'The list could not be read. Any extension repository still works by its address.'),
  );
}

function licencesView(repo, r) {
  const { blog } = cache;
  const rows = licenceRecords(blog);
  return h(
    'div',
    {},
    h('p', {}, nav('Settings', link(repo, '&settings'), { icon: 'arrow-left' })),
    h('h1', {}, 'What is in this site'),
    h('p', { class: 'hint' }, nav('Licences of the tool itself', '#licences')),
    h('p', { class: 'muted' }, 'Every theme and extension this blog depends on, with its licence. Recorded in blog.json, written to licences.json, and stamped into each generated page as a comment.'),
    h('table', { style: 'width:100%;border-collapse:collapse' }, h('thead', {}, h('tr', {}, ['Kind', 'Name', 'Version', 'Licence', 'Pinned to'].map((t) => h('th', { style: 'text-align:left;border-bottom:1px solid var(--rule);padding:.3rem' }, t)))), h('tbody', {}, rows.map((x) => h('tr', {}, [x.kind, x.name, x.version || '', x.licence, x.repo ? `${x.repo}@${x.ref}` : 'built in'].map((t) => h('td', { style: 'padding:.3rem;border-bottom:1px solid var(--rule)' }, String(t))))))),
    h('p', { class: 'hint' }, `The generator, ${blog.theme && typeof blog.theme === 'object' ? 'your pinned theme' : 'the default theme'} and any extensions are the only code or style that shapes the pages. Posts and images are your own content.`),
  );
}

// ---------- media ----------

// Every image in the blog's asset repositories, with the pinned address a page would load it from. Listing is reading: the
// ledger counts it, and nothing is uploaded by opening the view.
async function loadMedia(repo, ref) {
  const { blog, lock } = cache;
  return listMedia(gh, { blog, lock, index: await loadIndexFull(gh, repo, ref, { blog }) });
}

// A searchable grid of tiles. Lazy images with explicit dimensions, so a repository of thousands of pictures is not fetched at full
// size; the grid is drawn a page at a time. `onPick` makes a tile choosable (the editor's picker); without it a tile copies its reference.
function mediaGrid(items, { onPick = null } = {}) {
  const PAGE = 120;
  let shown = PAGE;
  const search = h('input', { type: 'search', placeholder: 'Search images…', 'aria-label': 'Search images', autocomplete: 'off' });
  const unusedOnly = h('input', { type: 'checkbox' });
  const count = h('span', { class: 'muted' });
  const grid = h('div', { class: 'media-grid' });
  const more = h('button', { type: 'button' }, 'Show more');
  const tile = (it) => {
    const img = h('img', { src: it.url || '', alt: '', loading: 'lazy', width: 160, height: 120 });
    img.addEventListener('error', () => img.classList.add('broken'));
    const copy = h('button', { type: 'button', class: 'link', onclick: async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText(it.ref); toast({ kind: 'success', title: 'Copied', message: it.ref }); } catch { toast({ kind: 'error', title: 'Could not copy', message: it.ref }); } } }, 'Copy reference');
    const box = h('figure', { class: 'media-tile', title: it.ref }, img, h('figcaption', {}, h('span', { class: 'name' }, it.path), it.unused ? h('span', { class: 'badge' }, 'unused') : null, onPick ? null : copy));
    if (onPick) {
      box.tabIndex = 0;
      box.addEventListener('click', () => onPick(it));
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(it); } });
    }
    return box;
  };
  const draw = () => {
    const all = filterMedia(items, { query: search.value, onlyUnused: unusedOnly.checked });
    grid.replaceChildren(...all.slice(0, shown).map(tile));
    more.hidden = all.length <= shown;
    count.textContent = `${all.length.toLocaleString()} of ${items.length.toLocaleString()} image${items.length === 1 ? '' : 's'}${items.some((i) => i.unused) ? `, ${items.filter((i) => i.unused).length.toLocaleString()} unused` : ''}`;
    if (!all.length) grid.replaceChildren(h('p', { class: 'muted' }, items.length ? 'No images match.' : 'No images yet.'));
  };
  search.addEventListener('input', () => { shown = PAGE; draw(); });
  unusedOnly.addEventListener('change', () => { shown = PAGE; draw(); });
  more.addEventListener('click', () => { shown += PAGE; draw(); });
  draw();
  return { root: h('div', {}, h('div', { class: 'media-bar' }, search, h('label', { class: 'check' }, unusedOnly, ' Unused only'), count), grid, more), search };
}

async function mediaView(repo, r) {
  const { blog } = cache;
  document.title = `Media · ${blog.title}`;
  const { items, problems } = await loadMedia(repo, r.ref);
  const grid = mediaGrid(items);
  return h('div', {},
    h('p', {}, nav(blog.title, link(repo), { icon: 'arrow-left' })),
    h('h1', {}, 'Media'),
    h('p', { class: 'muted' }, 'The images in this blog\'s images repositories. Unused means no published or scheduled post and no blog.json setting references the image (a draft may still plan to). Opening this view uploads nothing.'),
    problems.map((p) => h('div', { class: 'err' }, p)),
    !Object.keys((blog.assets && blog.assets.repos) || {}).length ? h('p', { class: 'muted' }, 'This blog has no images repository yet. Name one in Settings.') : grid.root,
  );
}

// ---------- reading ----------

async function listView(repo, r) {
  const { blog } = cache;
  document.title = blog.title;
  const entries = await loadIndex(gh, repo, r.ref, { blog });
  const wrap = h('div', {}, h('h1', {}, blog.title), h('p', { class: 'muted' }, blog.description));
  // View blog opens the GitHub Pages site when GitHub is serving one, else the reader (which needs no Pages)
  const viewBlog = outbound('View blog', `blog/${link(repo, r.ref ? `&ref=${r.ref}` : '')}`, { icon: 'external-link', title: 'Opens the reader: GitHub Pages is not serving this blog' });
  // the same for every tab: the blog as a whole
  const globalActions = h('div', { class: 'actions' }, ...(gh.token ? [h('button', { icon: 'sliders', onclick: () => (location.hash = link(repo, '&settings')) }, 'Settings'), h('button', { icon: 'file-text', onclick: () => (location.hash = link(repo, '&media')) }, 'Media')] : []), viewBlog);
  if (gh.token) {
    detectAddress(gh, repo).then((found) => {
      if (found.live && found.exact && found.built) {
        viewBlog.dataset.href = `${found.address}/`;
        viewBlog.title = 'Opens the GitHub Pages site';
      }
    }).catch(() => {});
  }
  // The list starts in the blog's own order (the index records it); a reader may sort it for themselves. That
  // changes this list and nothing else: no address, no previous/next, nothing written anywhere.
  const sortLabel = h('label', { class: 'sortbar' }, 'Sort ');
  const list = h('ul', { class: 'posts' });
  let needle = '';
  const found = (e) => {
    const tokens = needle.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = `${e.title} ${e.excerpt || ''} ${(e.tags || []).join(' ')}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  };
  const drawList = (mode) => list.replaceChildren(...readerSort(entries, mode).filter(found).map((e) => h('li', { class: 'card-link' }, h('h3', {}, nav(e.title, link(repo, `&post=${e.slug}${r.ref ? `&ref=${r.ref}` : ''}`), { class: 'link' })), h('div', { class: 'muted' }, dateEl(e.date), (e.tags || []).map((t) => h('span', { class: 'tag' }, `#${t}`))), e.excerpt ? h('p', {}, e.excerpt) : null)));
  const mode0 = savedSort(sessionStorage, repo);
  const picker = h('select', { 'aria-label': 'Sort posts', onchange: () => { saveSort(sessionStorage, repo, picker.value); drawList(picker.value); } }, READER_SORTS.map(([k, label]) => h('option', { value: k, selected: k === mode0 }, label)));
  sortLabel.append(picker);
  const searchBox = h('input', { type: 'search', placeholder: 'Search posts…', 'aria-label': 'Search posts', autocomplete: 'off', style: 'margin-left:1rem' });
  const none = h('p', { class: 'muted' }, 'No posts match your search.');
  none.hidden = true;
  searchBox.addEventListener('input', () => { needle = searchBox.value; drawList(picker.value); none.hidden = !entries.length || list.children.length > 0; });
  sortLabel.append(searchBox);
  drawList(mode0);

  // Posts and Pages are tabs: the blog's posts, and its standalone pages (read on first use, a request each)
  const draftsBox = h('section', {});
  const postsPanel = h('div', { role: 'tabpanel', id: 'tab-posts' },
    gh.token ? h('div', { class: 'actions' }, h('button', { class: 'primary', icon: 'plus', onclick: () => (location.hash = link(repo, '&new')) }, 'New post'), h('button', { icon: 'file-text', onclick: (e) => showDrafts(e.currentTarget, repo, r.ref, draftsBox) }, 'Show drafts')) : null,
    draftsBox,
    ...(entries.length > 1 ? [sortLabel] : []), list, none,
    !entries.length ? h('p', { class: 'muted' }, 'No published posts yet.') : null);
  const pagesPanel = h('div', { role: 'tabpanel', id: 'tab-pages', hidden: true });
  let pagesLoaded = false;
  const tabs = [['posts', 'Posts', postsPanel], ['pages', 'Pages', pagesPanel]];
  const buttons = tabs.map(([key, label]) => h('button', { type: 'button', role: 'tab', 'aria-controls': `tab-${key}`, onclick: () => select(key) }, label));
  const select = (key) => {
    tabs.forEach(([k, , panel], i) => {
      panel.hidden = k !== key;
      buttons[i].setAttribute('aria-selected', String(k === key));
      buttons[i].tabIndex = k === key ? 0 : -1;
    });
    if (key === 'pages' && !pagesLoaded) {
      pagesLoaded = true;
      showPages(pagesPanel, repo, r.ref);
    }
  };
  const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Posts and pages' }, ...buttons);
  tablist.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = buttons.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    const next = (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    select(tabs[next][0]);
    buttons[next].focus();
  });
  select('posts');
  // the buttons sit above the tabs; once the bar sticks they move to its right, level with the tabs
  const bar = h('div', { class: 'stickybar' }, globalActions, tablist);
  const sentinel = h('div', { class: 'sticky-sentinel', 'aria-hidden': 'true' });
  if (typeof IntersectionObserver !== 'undefined') {
    const under = (document.querySelector('#top') || { offsetHeight: 0 }).offsetHeight; // the sticky header covers the top of the page
    new IntersectionObserver(([e]) => bar.classList.toggle('stuck', !e.isIntersecting && e.boundingClientRect.top < under), { rootMargin: `-${under}px 0px 0px 0px` }).observe(sentinel);
  }
  wrap.append(sentinel, bar, postsPanel, pagesPanel);
  return wrap;
}

async function showDrafts(btn, repo, ref, box) {
  btn.disabled = true;
  box.replaceChildren(progressLine('Reading drafts…'));
  const out = h('ul', { class: 'posts' });
  const { repo: slugRepo, folder } = parseRepoRef(repo);
  for (const n of await listPostFiles(gh, repo, ref)) {
    try {
      const m = parseMeta(splitFile(await gh.readText(slugRepo, at(folder, `posts/${n}`), ref), n).front, n);
      if (m.status !== 'published') out.append(h('li', { class: 'card-link' }, h('h3', {}, nav(m.status === 'scheduled' ? `${m.title} (scheduled for ${m.publish_at})` : `${m.title} (draft)`, link(repo, `&edit=${m.slug}`), { class: 'link' })), h('div', { class: 'muted' }, dateEl(m.date))));
    } catch {
      /* skip unreadable */
    }
  }
  box.replaceChildren(h('h2', {}, 'Drafts and scheduled'), out.children.length ? out : h('p', { class: 'muted' }, 'No drafts or scheduled posts.'));
  box.scrollIntoView({ block: 'start' });
}

// The standalone pages (about, contact, …): not posts, so not in the posts list. Read when the tab is first opened, a request each.
async function showPages(panel, repo, ref) {
  panel.replaceChildren(progressLine('Reading pages…'));
  const out = h('ul', { class: 'posts' });
  const { repo: slugRepo, folder } = parseRepoRef(repo);
  try {
    for (const n of await listPageFiles(gh, repo, ref)) {
      try {
        const m = parseMeta(splitFile(await gh.readText(slugRepo, at(folder, `pages/${n}`), ref), n).front, n);
        out.append(h('li', { class: 'card-link' }, h('h3', {}, nav(m.status === 'draft' ? `${m.title} (draft)` : m.title, link(repo, `&editpage=${m.slug}`), { class: 'link' })), h('div', { class: 'muted' }, m.menu ? `In the menu, position ${m.menu}` : 'Not in the menu')));
      } catch {
        /* skip unreadable */
      }
    }
  } catch (e) {
    panel.replaceChildren(errBox(e));
    return;
  }
  panel.replaceChildren(
    gh.token ? h('div', { class: 'actions' }, h('button', { class: 'primary', icon: 'plus', onclick: () => (location.hash = link(repo, '&newpage')) }, 'New page')) : null,
    out.children.length ? out : h('p', { class: 'muted' }, 'No pages yet.'),
  );
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
    h('p', {}, nav(blog.title, link(repo), { icon: 'arrow-left' })),
    h('h1', {}, post.meta.title),
    h('p', { class: 'muted' }, dateEl(post.meta.date, { long: true }), post.meta.author ? ` · ${post.meta.author}` : '', (post.meta.tags || []).map((t) => h('span', { class: 'tag' }, `#${t}`))),
    body,
    h('div', { class: 'actions' }, h('button', { icon: 'message', onclick: () => (location.hash = link(repo, `&correct=${post.slug}`)) }, 'Suggest a correction'), gh.token ? h('button', { icon: 'edit', onclick: () => (location.hash = link(repo, `&edit=${post.slug}`)) }, 'Edit') : null, gh.token ? h('button', { class: 'danger', icon: 'trash', onclick: (e) => deleteContent(repo, { slug: post.slug, kind: 'post', ref: r.ref, button: e.currentTarget }) }, 'Delete') : null),
  );
}

// ---------- editing ----------

// Delete a post or page: the same pre-flight and commit as a publish, and the file stays in the repository's history.
async function deleteContent(repo, { slug, kind, ref, button }) {
  const { repo: plainRepo } = parseRepoRef(repo);
  const branch = ref || (await gh.repoInfo(plainRepo)).default_branch;
  try {
    const plan = await heavy('Preparing the pre-flight…', () => planChange(gh, { repo, branch, slug, kind, remove: true, runner }), { button });
    if (!(await confirmPlan(plan))) return false;
    const receipt = await heavy('Committing…', () => executePlan(gh, plan), { button });
    sent(receipt, { title: kind === 'page' ? 'Page deleted' : 'Post deleted' });
    cache = null;
    location.hash = link(repo);
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

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
  const kind = r.kind === 'page' ? 'page' : 'post';
  const isPageKind = kind === 'page';
  const word = isPageKind ? 'page' : 'post';
  let isNew = r.mode === 'new';
  let existing = isNew ? null : await loadPost(gh, repo, r.post, branch, cache, { allowDraft: true, kind });
  let { blog } = cache;
  const staged = new Map();
  const canPush = !!(info.permissions && info.permissions.push);
  const deploy = deployPanel({ gh, repo: plainRepo, hasPages: !!info.has_pages });

  const picked = new Map(); // existing images chosen in the picker, not pinned yet: shown from the address the picker loaded
  setAssetResolver((ref) => {
    const s = staged.get(ref.replace(/^asset:/, ''));
    if (s) return s.url;
    if (picked.has(ref) && !(cache && cache.lock && cache.lock[ref.replace(/^asset:/, '')])) return picked.get(ref);
    try {
      return resolveAsset(ref, blog, cache.lock);
    } catch {
      return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><text x="8" y="34" font-family="sans-serif" font-size="14" fill="#888">unresolved asset</text></svg>');
    }
  });

  const m = existing ? existing.post.meta : { status: 'draft', date: isPageKind ? '' : today(), cover: isPageKind ? '' : 'auto' }; // a new post's cover is its first image, else its first video's poster, else the blog's
  const f = {
    title: h('input', { value: m.title || '', placeholder: 'Title', disabled: correcting }),
    slug: h('input', { value: m.slug || '', placeholder: 'set once, never changes', disabled: !isNew }),
    date: h('input', { type: 'date', value: (m.date || '').slice(0, 10), disabled: correcting }),
    // the time orders the posts of one day (newest first); a new post gets the time it was started, an old post keeps what it had
    time: h('input', { type: 'time', value: (m.date || '').length > 10 ? m.date.slice(11) : isNew && !isPageKind ? nowTime() : '', disabled: correcting, title: 'Orders the posts of one day; not shown on the page', 'aria-label': 'Time of day' }),
    tags: h('input', { value: (m.tags || []).join(', '), placeholder: 'video, git', disabled: correcting }),
    author: h('input', { value: m.author || '', placeholder: blog.author || 'Defaults to the blog\'s author', disabled: correcting }),
    menu: h('input', { type: 'number', min: 0, max: 99, value: m.menu || '', placeholder: 'not in the menu', disabled: correcting }),
    publish_at: h('input', { type: 'datetime-local', value: m.publish_at || '', disabled: correcting, 'aria-label': 'Publish at' }),
    status: h('select', { disabled: correcting }, (isPageKind ? ['draft', 'published'] : ['draft', 'scheduled', 'published']).map((s) => h('option', { value: s, selected: s === m.status }, s))),
    cover: h('input', { value: m.cover || '', placeholder: 'auto, or asset:images/cover.png', disabled: correcting, style: 'flex:1' }),
    description: h('input', { value: m.description || '', placeholder: 'Optional; defaults to the first paragraph', disabled: correcting }),
    seo_title: h('input', { value: m.seo_title || '', placeholder: 'Optional; defaults to the title', disabled: correcting }),
    image: h('input', { value: m.image || '', placeholder: 'asset:images/share.png (optional)', disabled: correcting, style: 'flex:1' }),
    canonical: h('input', { value: m.canonical || '', placeholder: 'https://… (only if first published elsewhere)', disabled: correcting }),
    noindex: h('input', { type: 'checkbox', checked: m.noindex === 'true', disabled: correcting }),
  };
  const dateNote = h('div', { class: 'hint' });
  const showDate = () => { const d = describeDate(f.date.value); dateNote.textContent = d.relative ? `${d.full} · ${d.relative}` : d.full; };
  f.date.addEventListener('input', showDate);
  f.date.addEventListener('change', showDate);
  showDate();
  const coverUpload = h('button', { type: 'button', icon: 'upload', disabled: correcting, onclick: () => chooseImage((ref) => { f.cover.value = ref; }) }, 'Choose…');
  const coverAuto = h('button', { type: 'button', icon: 'zap', disabled: correcting, onclick: () => { f.cover.value = 'auto'; } }, 'Auto');
  const imageUpload = h('button', { type: 'button', icon: 'upload', disabled: correcting, onclick: () => chooseImage((ref) => { f.image.value = ref; }) }, 'Choose…');
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
  const go = h('button', { class: 'primary', icon: 'send' }, correcting ? 'Propose correction (pull request)' : 'Publish');
  const scheduleHint = h('div', { class: 'hint' });
  const scheduleRow = h('div', {}, field('Publish at', f.publish_at, undefined), scheduleHint);
  const showSchedule = () => {
    const zone = (cache && cache.blog ? cache.blog : blog).timezone;
    const v = f.publish_at.value;
    let text = `Read as ${zone || 'UTC (set a time zone in Settings to use yours)'}. Goes live not before this time, normally within the hour. Needs the schedule workflow; the post's source is public meanwhile.`;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) {
      const days = daysUntil({ publish_at: v }, cache && cache.blog ? cache.blog : blog);
      if (days > SCHEDULE_WARN_DAYS) text += ` Warning: ${Math.floor(days)} days away. GitHub disables scheduled workflows after 60 days without repository activity.`;
    }
    scheduleHint.textContent = text;
  };
  f.publish_at.addEventListener('input', showSchedule);
  const refreshLabel = () => {
    if (correcting) return;
    const published = f.status.value === 'published';
    go.dataset.icon = published ? 'send' : 'save';
    relabel(go, published ? 'Publish' : f.status.value === 'scheduled' ? 'Schedule' : 'Save draft');
    scheduleRow.hidden = f.status.value !== 'scheduled';
    showSchedule();
  };
  f.status.addEventListener('change', refreshLabel);
  refreshLabel();

  const editorEl = h('div', { id: 'editor' });
  // what a search engine and a shared link show; all optional
  const sharing = h('details', { class: 'more' },
    h('summary', {}, 'Search and sharing'),
    h('div', { class: 'row' }, field('Search title', f.seo_title, 'The title search engines and shared links show. Defaults to the title.'), field('Share image', h('div', { style: 'display:flex;gap:.4rem' }, f.image, imageUpload), 'Defaults to the cover.')),
    h('div', { class: 'row' }, field('Canonical address', f.canonical, 'Only for a post first published elsewhere: search engines will treat that address as the original.'), field('Keep out of search', h('label', { class: 'check' }, f.noindex, ' noindex this page'), 'The page still exists and is in the feed; it asks search engines to skip it and stays out of the sitemap.')),
  );
  const node = h(
    'div',
    {},
    h('p', {}, nav('Back', existing && !isPageKind ? link(repo, `&post=${existing.post.slug}`) : link(repo), { icon: 'arrow-left' })),
    h('h1', {}, correcting ? `Correct: ${m.title}` : isNew ? `New ${word}` : `Edit: ${m.title}`),
    h('div', { class: 'cols' },
      h('div', {},
        h('div', { class: 'row' }, field('Title', f.title), field('Slug (the URL — never changes)', f.slug)),
        h('div', { class: 'row' }, field('Cover', h('div', { style: 'display:flex;gap:.4rem' }, f.cover, coverUpload, coverAuto), 'Upload an image, or auto: the post\'s first image, else the poster of its first video, else the blog\'s cover. It is the preview when the post is shared.'), field('Description', f.description)),
        sharing,
        editorEl,
        h('p', { class: 'hint' }, 'The toolbar offers only what markdown can express. Images are uploaded to the assets repository at publish time, not before.'),
      ),
      h('div', { class: 'side' }, h('div', { class: 'card' }, h('div', { class: 'card-header' }, correcting ? 'Propose' : 'Publish'), h('div', { class: 'card-body' },
        correcting ? h('div', {}, field('Note for the pull request', note), canPush ? null : h('div', { class: 'err' }, 'You do not have write access to this repository. ', outbound('Propose the change on GitHub instead', `https://github.com/${plainRepo}/edit/${branch}/${at(folder, `${isPageKind ? 'pages' : 'posts'}/${r.post}.md`)}`, { class: 'link' }), ' — it forks and opens the pull request for you.')) : null,
        isPageKind
          ? h('div', { class: 'row' }, field('Menu position', f.menu, 'A number puts the page in the header menu, lowest first. Leave blank to keep it out of the menu.'), field('Status', f.status))
          : [field('Author', f.author, 'Posts by more than one author get an author page each.'), h('div', { class: 'row' }, field('Date', h('div', { style: 'display:flex;gap:.4rem' }, f.date, f.time), dateNote), field('Tags', f.tags), field('Status', f.status)), scheduleRow],
        h('div', { class: 'actions' }, go, !isNew && !correcting && existing ? h('button', { type: 'button', class: 'danger', icon: 'trash', onclick: (e) => deleteContent(repo, { slug: existing.post.slug, kind, ref: r.ref, button: e.currentTarget }) }, `Delete ${word}`) : null),
        deploy.el,
      ))),
    ),
  );
  // The Quill container must be in the document before Quill measures it.
  view.replaceChildren(node);
  const quill = await createEditor(editorEl, { onImage: () => pickImage(), onVideo: () => pickVideo() });
  quill.setContents(existing ? existing.post.delta.ops : mdToDelta('').ops, 'silent');
  go.disabled = correcting && !canPush;

  // Stage an image for upload at publish, in the images repository. Returns its asset reference, or
  // null when there is nowhere to put it (the explanation is already shown).
  let noImages = null;
  async function stageImage(file) {
    if (noImages) noImages.close();
    noImages = null;
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
      noImages = toast({
        kind: 'error',
        title: 'This blog has no images repository yet',
        message: `Images are binaries, so they are kept in a repository (or a folder of one) that you do not have to clone to edit text. Name one in Settings, for example me/images or ${sample} to keep them in this repository, save, then choose the image again: what you have written here is not lost.`,
        links: [{ href: link(repo, '&settings'), text: 'Open Settings in a new tab' }],
      });
      return null;
    }
    const key = keys.includes('images') ? 'images' : keys[0];
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+/, '');
    const path = `${hex(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 10)}-${name}`;
    staged.set(`${key}/${path}`, { key, path, bytes, url: URL.createObjectURL(file) });
    return `asset:${key}/${path}`;
  }

  // The picker: an image already in the images repository (so it is not uploaded twice), or a new one. `use` receives an asset reference.
  async function chooseImage(use) {
    const have = Object.keys((blog.assets && blog.assets.repos) || {}).length;
    if (!have) return uploadImage(use);
    let media;
    try {
      media = await working('Looking at the images…', () => loadMedia(repo, r.ref));
    } catch (e) {
      return fail(e);
    }
    const dlg = h('dialog', { class: 'media-dialog' });
    const finish = (ref) => { dlg.close(); dlg.remove(); if (ref) use(ref); };
    const grid = mediaGrid(media.items, { onPick: (it) => { if (it.url) picked.set(it.ref, it.url); finish(it.ref); } });
    dlg.append(
      h('h2', {}, 'Choose an image'),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', icon: 'upload', onclick: () => { dlg.close(); dlg.remove(); uploadImage(use); } }, 'Upload a new image…'), h('button', { type: 'button', icon: 'x', onclick: () => finish(null) }, 'Cancel')),
      media.problems.map((p) => h('div', { class: 'err' }, p)),
      grid.root,
    );
    dlg.addEventListener('cancel', () => dlg.remove(), { once: true });
    document.body.append(dlg);
    dlg.showModal();
    grid.search.focus();
  }

  // A file chooser for a new image; `use` receives the staged asset reference.
  function uploadImage(use) {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const ref = await working('Preparing the image…', () => stageImage(file));
        if (!ref) return;
        use(ref);
      } catch (e) {
        fail(e);
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
      const releases = await working('Looking for videos…', () => listVideoReleases(gh, blog));
      const choice = await chooseVideo(releases, blog);
      if (!choice) return;
      const range = insertionPoint(quill);
      quill.insertEmbed(range.index, 'video', choice.ref, 'user');
      quill.setSelection(range.index + 1);
      if (choice.receipt) releaseReceipt(choice.receipt);
    } catch (e) {
      fail(e);
    }
  }

  function buildText() {
    const { md } = deltaToMarkdownChecked({ ops: quill.getContents().ops });
    const common = {
      title: f.title.value.trim(),
      status: f.status.value,
      publish_at: !isPageKind && f.status.value === 'scheduled' ? f.publish_at.value : '',
      cover: f.cover.value.trim(),
      description: f.description.value.trim(),
      seo_title: f.seo_title.value.trim(),
      image: f.image.value.trim(),
      canonical: f.canonical.value.trim(),
      noindex: f.noindex.checked ? 'true' : '',
    };
    // a page has a menu position and nothing dated; a post has a date, tags and an author
    const vals = isPageKind
      ? { ...common, menu: f.menu.value.trim() }
      : { ...common, date: f.date.value && f.time.value ? `${f.date.value}T${f.time.value}` : f.date.value, tags: f.tags.value.split(',').map((t) => t.trim()).filter(Boolean), author: f.author.value.trim() };
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
    try {
      const creating = isNew;
      const { slug, text, md } = buildText();
      const used = new Set([...text.matchAll(/asset:([^\s)\]]+)/g)].map((x) => x[1]));
      const plan = await heavy('Preparing the pre-flight…', () => planChange(gh, { repo, branch, slug, text, kind, staged: [...staged.values()].filter((s) => used.has(`${s.key}/${s.path}`)), mode: correcting ? 'pr' : 'direct', create: isNew, runner }), { button: go });
      if (!plan.changes.length && !plan.assetGroups.length) {
        noted('Nothing to publish: the repository already matches.');
        return;
      }
      if (!(await confirmPlan(plan))) return;
      const receipt = await heavy('Committing…', () => executePlan(gh, plan, { pullBody: note.value.trim() }), { button: go });
      sent(receipt, { title: correcting ? 'Correction proposed' : f.status.value === 'published' ? 'Published' : f.status.value === 'scheduled' ? 'Scheduled' : 'Draft saved' });
      const pushed = [...receipt.commits].reverse().find((c) => c.repo === plainRepo);
      if (!correcting && pushed) {
        const now = cache && cache.blog ? cache.blog : blog;
        deploy.track({ sha: pushed.sha, since: Date.now(), url: `${now.domain}/${slug}/`, published: f.status.value === 'published', isNew: creating, soft: !isPageKind && liveEnabled(now) && (!creating || ownsNotFoundPage(now)) });
      }
      const path = `${isPageKind ? 'pages' : 'posts'}/${slug}.md`;
      existing = { post: parsePost({ path, text }) };
      isNew = false;
      f.slug.disabled = true;
      if (!correcting) {
        cache = null;
        cache = { repo, ref: r.ref, ...(await working('Refreshing the blog…', () => loadBlog(gh, repo, r.ref))) };
        staged.clear();
      }
      // What you see is what is stored.
      quill.setContents(mdToDelta(md).ops, 'silent');
      if (!correcting) history.replaceState(null, '', link(repo, `&${isPageKind ? 'editpage' : 'edit'}=${slug}`));
    } catch (e) {
      fail(e);
    } finally {
      go.disabled = correcting && !canPush;
    }
  });
  return null;
}

// A searchable dropdown of the videos a post can embed, with the Embed button beside it. Entries are
// published releases (one per version) and render folders that have no tag yet; embedding the latter
// publishes them first (the tag is made under the hood, after the usual pre-flight).
function videoCombobox(blog, { entries, onEmbed, onCancel, onOpenChange }) {
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
  const embedBtn = h('button', { class: 'primary', icon: 'film', disabled: true }, 'Embed');
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
      preview.replaceChildren(h('div', { class: 'muted' }, scanning ? 'Looking for videos…' : entries.length ? 'Choose a video.' : 'No videos here yet. Make one at hls.webcli.app, publish it to your video repository, and it appears here.'));
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
    relabel(embedBtn, e && e.unpublished ? 'Publish and embed' : 'Embed');
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
    if (chosen && input.value !== label(chosen)) { chosen = null; embedBtn.disabled = true; relabel(embedBtn, 'Embed'); drawPreview(); }
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
    h('div', { class: 'actions' }, h('button', { icon: 'x', onclick: onCancel }, 'Cancel')),
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
        onCancel: () => done(null),
      });
      dlg.replaceChildren(h('h2', {}, 'Embed a video'), combo.root);
      combo.setEntries([...published, ...unpublished], { done: scanned });
      combo.focus();
    };
    const showPublish = (e) => dlg.replaceChildren(releaseView(blog, { target: e, back: showList, created: done }));

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

// Publishing a render that is already in a video repository: a folder made by hls.webcli.app (or ffmpeg) and committed there
// has no tag yet, and a tag is what a post embeds. The tag is created for you, never asked for by name, and the review
// screen says exactly what will be created before anything is. The blog app does not encode or upload video: a render
// is made and published elsewhere, and a post only refers to it.
function releaseView(blog, { back, created, target }) {
  const body = h('div');
  const status = h('div');
  const root = h('div', {}, h('h2', {}, 'Publish and embed'), h('p', { class: 'hint' }, `${target.name} is already in ${target.where}; it only needs a tag to be published.`), body, status);

  let failed = false; // the last run() ended in an error (already shown as a toast)
  const run = async (label, fn) => {
    failed = false;
    status.replaceChildren(...(label ? [progressLine(label)] : []));
    try {
      return await fn();
    } catch (e) {
      status.replaceChildren();
      failed = true;
      fail(e);
      return null;
    }
  };

  const confirm = (list, plan) => {
    const go = h('button', { class: 'primary', icon: 'git-commit' }, `Create tag ${plan.tag}`);
    go.addEventListener('click', async () => {
      go.disabled = true;
      const receipt = await run('Tagging…', () => executeRelease(gh, plan, {}));
      if (!receipt) {
        go.disabled = false;
        return;
      }
      created({ ref: `video:${list.key}/${plan.name}@v${plan.version}`, receipt });
    });
    body.replaceChildren(
      h('h3', {}, `Ready to create ${plan.tag}`),
      h('div', { class: 'preflight' }, describeRelease(plan).map((l) => h('div', {}, l))),
      h('p', { class: 'hint' }, 'Nothing has been uploaded. The tag is created and never moved.'),
      h('div', { class: 'actions' }, go, h('button', { onclick: () => { status.replaceChildren(); back(); } }, 'Back')),
    );
  };

  async function draw() {
    body.replaceChildren(progressLine('Checking the repository…'));
    let lists;
    try {
      lists = await videoRepositories(gh, blog);
    } catch (e) {
      body.replaceChildren(errBox(e));
      return;
    }
    const list = lists.find((l) => l.key === target.key) || lists[0];
    const plan = await run('', () => planTagRelease(gh, { where: target.where, name: target.name }));
    if (!plan) {
      body.replaceChildren();
      return;
    }
    confirm(list, plan);
  }

  root.append(h('div', { class: 'actions' }, h('button', { icon: 'arrow-left', onclick: back }, 'Embed a video')));
  draw();
  return root;
}

function releaseReceipt(r) {
  return toast({
    kind: 'success',
    title: `Created ${r.tag}`,
    message: 'The CDN can take a few minutes to serve a new tag, so the player may not load it straight away.',
    links: [...(r.commit ? [{ href: r.commit.url, text: `commit ${r.commit.sha.slice(0, 7)}` }] : []), { href: r.tagUrl, text: 'tag' }],
  });
}

// What a scheduled post promises, and what it does not.
function scheduleNote(s) {
  return [
    `Scheduled for ${s.at.replace('T', ' ')} ${s.zone || 'UTC (set a time zone in Settings to use yours)'}. It goes live not before then, and normally within the hour: the workflow runs hourly and GitHub may delay it.`,
    'Its source is public in a public repository until then: scheduled hides it from the site, not from GitHub.',
    s.extensionsRun ? 'Extensions are being run now and their output recorded, because the workflow that publishes it runs none.' : '',
    s.days > SCHEDULE_WARN_DAYS ? `That is ${Math.floor(s.days)} days away. GitHub turns scheduled workflows off after 60 days without activity in a public repository, so it may never publish unless the repository is touched before then.` : '',
    'Needs the schedule workflow (templates/schedule.yml) in the repository.',
  ].filter(Boolean).join(' ');
}

async function confirmPlan(plan) {
  await ensureCurrent(); // before the pre-flight, so a plan made by old scripts is not even offered
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
    // an import can be thousands of files: the list shows the first of them, the totals above it are for all
    const rows = [...plan.assetGroups.flatMap((g) => g.files.map((x) => ({ ...x, repo: g.repo }))), ...plan.changes.map((c) => ({ ...c, repo: plan.repo }))];
    const SHOWN = 300;
    dlg.replaceChildren(...[
      h('h2', {}, plan.removed ? `Delete this ${plan.kind === 'page' ? 'page' : 'post'}?` : 'Ready to send'),
      h('div', { class: 'preflight' }, describePlan(plan).map((l) => h('div', {}, l))),
      plan.headline ? h('div', { class: 'preflight' }, plan.headline.map((l) => h('div', {}, l))) : null,
      h('div', { class: 'files' }, rows.slice(0, SHOWN).map((c) => h('div', {}, `${c.action.padEnd(6)} ${c.repo}/${c.path}  ${fmtBytes(c.size)}`)), rows.length > SHOWN ? h('div', { class: 'muted' }, `… and ${rows.length - SHOWN} more files`) : null),
      plan.licences ? h('div', {}, h('h3', {}, 'Licences this blog will depend on'), h('div', { class: 'files' }, plan.licences.map((l) => h('div', {}, `${l.kind.padEnd(10)} ${l.name} ${l.version || ''}  ${l.licence}${l.repo ? `  ${l.repo}@${l.ref}` : '  (built in)'}`)))) : null,
      buildNote(plan),
      plan.schedule ? h('div', { class: 'caution' }, scheduleNote(plan.schedule)) : null,
      plan.related !== null && plan.related !== undefined ? h('div', { class: 'caution' }, `Related posts: ${plan.related.toLocaleString()} ${plan.related === 1 ? 'page changes' : 'pages change'} besides the post's own.`) : null,
      plan.unlisted && plan.unlisted.length ? h('div', { class: 'caution' }, `${plan.unlisted.length === 1 ? 'This post is' : `${plan.unlisted.length} published posts are`} not in ${plan.orderFile || 'the order list'}, so ${plan.unlisted.length === 1 ? 'it' : 'they'} will be added at the end, by date: ${plan.unlisted.join(', ')}. Add ${plan.unlisted.length === 1 ? 'it' : 'them'} to ${plan.orderFile || 'the list'} to place ${plan.unlisted.length === 1 ? 'it' : 'them'}.`) : null,
      plan.removed ? h('div', { class: 'caution' }, `"${plan.title}" is removed from the blog and from its index, listings, feed and search. The file stays in the repository's history, so a revert brings it back.`) : null,
      h('p', { class: 'hint' }, plan.mode === 'pr' ? 'This opens a pull request; the default branch is not changed.' : 'Nothing has been uploaded yet.'),
      h('div', { class: 'actions' }, h('button', { class: plan.removed ? 'primary danger' : 'primary', icon: 'git-commit', onclick: () => done(true) }, plan.mode === 'pr' ? 'Open pull request' : plan.removed ? 'Delete and push' : 'Commit and push'), h('button', { icon: 'x', onclick: () => done(false) }, 'Cancel')),
    ].filter(Boolean));
    dlg.addEventListener('cancel', () => done(false), { once: true }); // Esc (see chooseVideo for why not 'close')
    dlg.showModal();
  });
}

addEventListener('hashchange', route);
// the dates need moment; if it cannot load they are shown as written
loadMoment().catch(() => {}).then(() => finishOAuth()).then(() => refreshIfNeeded()).then(route);

// "About this post": the card beside the editor. What can be said without a server: the post's length, contents and outline, how it
// will look to search and sharing, where it lives, what links to what, and (asked of GitHub and of the live site when the page opens)
// its history and whether the live page is this version. Everything computed here is lib/post-stats.js.
import { compareLive, postStats, summariseHistory } from '../lib/post-stats.js';
import { loadIndexFull } from './read.js';
import { fmtBytes } from './net.js';
import { at } from '../lib/reporef.js';

const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// where: the blog's address (owner/repo[/folder]); repo: the plain owner/repo. h: the app's element helper. read(): { fields, ops, staged }. saved: { slug, status, date, text } of the post as it is in the repository,
// or null for a new one.
export function createStatsPanel({ h, gh, where, repo, folder, branch, blog, lock, kind, saved, hasPages, read, link }) {
  const word = kind === 'page' ? 'page' : 'post';
  const body = h('div', { class: 'card-body stats' });
  const el = h('div', { class: 'card stats-card' }, h('div', { class: 'card-header' }, `About this ${word}`), body);
  let index = { posts: [], pages: [], sequence: [] };
  const extra = { history: saved ? 'loading' : null, live: saved ? 'loading' : null };
  let timer = 0;

  const row = (label, ...kids) => h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, ...kids.filter((k) => k !== null && k !== undefined)));
  const flag = (text, cls) => h('span', { class: cls }, text);

  function draw() {
    const { fields, ops, staged } = read();
    const s = postStats({ ops, f: fields, blog, index, lock, staged, kind });
    const rows = [];
    rows.push(row('Length', s.words ? `${plural(s.words, 'word')} · ${s.minutes} min read` : 'Nothing written yet'));

    const c = s.counts;
    const bits = [];
    if (c.images) bits.push(plural(c.images, 'picture'));
    if (c.videos) bits.push(plural(c.videos, 'video'));
    if (c.tables) bits.push(plural(c.tables, 'table'));
    if (c.codeBlocks) bits.push(plural(c.codeBlocks, 'code block'));
    if (c.htmlBlocks) bits.push(plural(c.htmlBlocks, 'HTML block'));
    const nLinks = c.links.internal + c.links.external;
    if (nLinks) bits.push(`${plural(nLinks, 'link')} (${c.links.internal} inside the blog)`);
    rows.push(row('Contents', bits.length ? bits.join(' · ') : 'Text only'));
    if (s.imagesWithoutAlt) rows.push(row('Accessibility', flag(`${plural(s.imagesWithoutAlt, 'picture')} without alt text`, 'caution')));
    if (s.pictures.total) rows.push(row('Picture sizes', s.pictures.sized === s.pictures.total ? `all ${s.pictures.total} known: no layout shift` : flag(`${s.pictures.sized} of ${s.pictures.total} known; the others shift the page as they load (replace them, or run blog-webcli sizes)`, 'caution')));
    if (s.unpinned.length) rows.push(row('Pictures', flag(`${plural(s.unpinned.length, 'picture')} not in the images repository yet: ${s.unpinned.slice(0, 3).join(', ')}`, 'err')));
    if (s.brokenLinks.length) rows.push(row('Broken links', flag(s.brokenLinks.slice(0, 5).join(', ') + (s.brokenLinks.length > 5 ? '…' : ''), 'err'), ' point at a post or page that does not exist'));

    if (s.headings.length) {
      rows.push(row('Outline', h('ul', { class: 'outline' }, s.headings.slice(0, 12).map((x) => h('li', { style: `margin-left:${(x.level - 1) * 0.8}rem` }, x.text)), s.headings.length > 12 ? h('li', { class: 'muted' }, `… and ${s.headings.length - 12} more`) : null), s.extraH1 ? flag('The page title is already the page\'s H1; a second one in the text is usually a mistake.', 'caution') : null));
    }

    const t = s.seo.title;
    const d = s.seo.description;
    rows.push(row('Search title', `${t.length} characters`, t.state === 'long' ? flag(' · search engines cut it at about 60', 'caution') : t.state === 'missing' ? flag(' · add a title', 'caution') : null));
    rows.push(row('Description', d.state === 'missing' ? flag('none', 'caution') : `${d.length} characters${d.auto ? ' (from the first paragraph)' : ''}`, d.state === 'short' ? flag(' · short', 'caution') : d.state === 'long' ? flag(' · cut after about 160', 'caution') : null));
    rows.push(row('Share image', s.seo.shareImage ? 'yes' : flag('none: a shared link will show text only', 'caution')));
    rows.push(row('Search engines', s.seo.noindex ? 'kept out (noindex)' : s.seo.inSitemap ? 'in the sitemap' : fields.status === 'published' ? 'indexable, not in the sitemap' : 'not public yet'));

    if (s.address.url) {
      const a = s.address;
      rows.push(row('Address', fields.status === 'published' ? h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.url) : a.url, a.aliases.length ? h('div', { class: 'muted' }, `also ${a.aliases.map((x) => `/${x}/`).join(', ')}`) : null));
    }
    if (kind !== 'page') {
      if (s.neighbours) {
        const nb = (e) => (e ? h('a', { href: link(where, `&post=${e.slug}`) }, e.title) : '—');
        rows.push(row('Neighbours', h('div', {}, 'Newer: ', nb(s.neighbours.newer)), h('div', {}, 'Older: ', nb(s.neighbours.older))));
      }
      if (s.related.length) rows.push(row('Related', h('ul', { class: 'outline' }, s.related.map((e) => h('li', {}, h('a', { href: link(where, `&post=${e.slug}`) }, e.title))))));
      if (s.comments) rows.push(row('Comments', plural(s.comments, 'published comment')));
    }

    if (saved) {
      rows.push(row('History', historyText()));
      rows.push(row('Live page', liveText()));
    }
    body.replaceChildren(...rows);
  }

  function historyText() {
    const x = extra.history;
    if (x === 'loading') return flag('reading…', 'muted');
    if (!x || x.error) return flag('could not be read', 'muted');
    if (!x.count) return 'not committed yet';
    return h('div', {}, `${x.more ? `${x.count}+` : x.count} ${x.count === 1 ? 'edit' : 'edits'} by ${x.authors.slice(0, 3).join(', ')}`, h('div', { class: 'muted' }, `first ${day(x.first.date)} · last ${day(x.last.date)}: ${x.last.message}`));
  }

  function liveText() {
    const x = extra.live;
    if (x === 'loading') return flag('checking…', 'muted');
    if (!x || x.state === 'private') return flag(saved.status === 'published' ? 'could not be checked' : 'not public: nothing to check', 'muted');
    const size = x.bytes ? ` · ${fmtBytes(x.bytes)} of HTML` : '';
    const build = x.build ? h('div', { class: 'muted' }, `Pages build: ${x.build.status}${x.build.updated_at ? `, ${day(x.build.updated_at)}` : ''}`) : null;
    if (x.state === 'live') return h('div', {}, flag('this version is live', 'ok'), size, build);
    if (x.state === 'stale') return h('div', {}, flag('the live page is an older version', 'caution'), x.build && x.build.status !== 'built' ? ' (a build is in progress)' : ' (the latest build may not have finished, or has failed)', build);
    if (x.state === 'missing') return h('div', {}, flag('no page at this address yet', 'caution'), build);
    return h('div', {}, flag('the live page could not be compared', 'muted'), size, build);
  }

  async function load() {
    try {
      const full = await loadIndexFull(gh, where, branch, { blog });
      index = { posts: full.posts || [], pages: full.pages || [], sequence: full.sequence || [] };
    } catch {
      /* neighbours and related are left out */
    }
    draw();
    if (!saved) return;
    const path = at(folder, `${kind === 'page' ? 'pages' : 'posts'}/${saved.slug}.md`);
    const tasks = [
      gh.fileHistory(repo, path, branch).then((c) => { extra.history = summariseHistory(c); }, () => { extra.history = { error: true }; }),
      (async () => {
        if (saved.status !== 'published') {
          extra.live = { state: 'private' };
          return;
        }
        const s = postStats({ ops: [], f: { slug: saved.slug, date: saved.date, status: 'published' }, blog, kind });
        let state = { state: 'unknown', bytes: 0 };
        try {
          const res = await gh.net.fetchRemote(s.address.url.replace(/^http:/, 'https:')); // a Pages address is served over https even when blog.json says http
          state = compareLive({ status: res.status, html: res.ok ? res.text() : '' }, saved.text);
        } catch {
          /* a site that does not let other pages read it: reported as not comparable */
        }
        let build = null;
        if (hasPages) {
          try {
            build = await gh.pagesBuild(repo);
          } catch {
            /* no build record */
          }
        }
        extra.live = { ...state, build };
      })(),
    ];
    await Promise.all(tasks);
    draw();
  }

  draw();
  load();
  return { el, update: () => { clearTimeout(timer); timer = setTimeout(draw, 250); } };
}

// The WordPress import wizard (#import): one or more export files, or a live site's address -> a blog in a GitHub repository,
// text as markdown and pictures in an images folder. The pages of it are small; the work is in lib/wp-*.js and app/import.js.
//   1 Sources      choose export files (Tools → Export → All content) and/or give a site address
//   2 Blogs        what was found, and what each blog is called and where it goes
//   3 Pictures     bring the pictures across, convert the text, say what could not be kept
//   4 Commit       the repository, the usual pre-flight, one commit for the pictures and one for the blogs
import { Refusal } from '../lib/errors.js';
import { slugify } from '../lib/taxonomy.js';
import { planWp } from '../lib/wp-content.js';
import { parseRepoRef } from '../lib/reporef.js';
import { executeImport, fetchImages, planImport, readExport, readSite } from './import.js';

const STEPS = ['Sources', 'Blogs', 'Pictures', 'Commit'];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function createImportView({ h, nav, gh, net, link, fmtBytes, working, confirmPlan, sent, fail, toast, signInDialog, icon }) {
  // The wizard's state lives as long as the page does: signing in re-renders the screen, and everything read and fetched so far
  // (which can be a lot of pictures) must still be there when it comes back.
  const fresh = () => ({
    step: 1,
    sources: [], // { id, label, model, fields: { title, description, author }, folder }
    opts: { drafts: true, library: true },
    results: [], // per source: { source, job, out, failed }
    cancelled: false,
    repo: '',
    branch: '',
  });
  let st = fresh();
  let uid = 0;
  const root = h('div', { class: 'wizard' });
  const bar = h('progress', { max: 1, value: 0, 'aria-label': 'Progress' });
  const status = h('p', { class: 'hint', role: 'status' });
  let running = false;
  let startOver;
  let show;

  {
    const draw = () => root.replaceChildren(h('div', { class: 'wizard-head' }, h('h1', {}, 'Import from WordPress'), st.sources.length ? h('button', { type: 'button', icon: 'x', onclick: () => startOver() }, 'Start over') : null), stepper(), body());
    const stepper = () => h('ol', { class: 'steps' }, STEPS.map((s, i) => h('li', { class: i + 1 === st.step ? 'active' : i + 1 < st.step ? 'done' : '' }, h('span', { class: 'n' }, String(i + 1)), ` ${s}`)));
    const go = (n) => {
      st.step = n;
      draw();
    };
    const body = () => [sourcesStep, blogsStep, picturesStep, commitStep][st.step - 1]();
    const card = (title, ...kids) => h('div', { class: 'card' }, h('div', { class: 'card-header' }, title), h('div', { class: 'card-body' }, ...kids));
    const field = (label, el, hint) => h('div', {}, h('label', {}, label), el, hint ? h('div', { class: 'hint' }, hint) : null);

    // ---------- 1: sources ----------
    function addSource(model, label) {
      const title = model.title || label;
      const author = (() => {
        const names = model.posts.map((p) => model.authors[p.author] || p.author).filter(Boolean);
        return names.sort((a, b) => names.filter((x) => x === b).length - names.filter((x) => x === a).length)[0] || title;
      })();
      st.sources.push({ id: ++uid, label, model, fields: { title, description: model.description || '', author }, folder: '' });
      st.sources.forEach((s) => (s.folder = st.sources.length === 1 ? '' : s.folder || slugify(s.fields.title)));
    }

    function sourcesStep() {
      const list = h('ul', { class: 'src' }, st.sources.map((s) => h('li', {},
        h('b', {}, s.fields.title || s.label), ` · ${plural(s.model.posts.length, 'post')}, ${plural(s.model.pages.length, 'page')}, ${plural(s.model.media.length, 'media file')}`,
        h('span', { class: 'muted' }, ` (${s.label})`), ' ',
        h('button', { type: 'button', class: 'icon-btn', icon: 'x', title: 'Remove', 'aria-label': `Remove ${s.label}`, onclick: () => { st.sources = st.sources.filter((x) => x !== s); draw(); } }))));
      const file = h('input', { type: 'file', accept: '.xml,text/xml,application/xml', multiple: true, 'aria-label': 'WordPress export files' });
      file.addEventListener('change', async () => {
        for (const f of [...file.files]) {
          try {
            addSource(await working(`Reading ${f.name}…`, async () => readExport(await f.text())), f.name);
          } catch (e) {
            fail(e);
          }
        }
        draw();
      });
      const address = h('input', { placeholder: 'https://example.com', 'aria-label': 'WordPress site address' });
      const read = h('button', { type: 'button', icon: 'arrow-right', onclick: async () => {
        if (!address.value.trim()) return;
        try {
          const model = await working('Reading the site…', () => readSite(net, address.value));
          addSource(model, address.value.trim());
          draw();
        } catch (e) {
          fail(e);
        }
      } }, 'Read site');
      return h('div', {},
        card('Where the content is',
          h('p', {}, 'In WordPress choose ', h('b', {}, 'Tools → Export → All content'), ' and download the file. Choose it here; add one file for each blog. Posts, pages, drafts, tags, authors and the media library are read; comments and other plugins\' content are not.'),
          field('Export files (.xml)', file, 'The file is read in this browser and is not sent anywhere.'),
          h('p', { class: 'muted' }, 'or'),
          field('A live site\'s address', h('div', { class: 'row' }, address, read), 'Reads the site\'s public REST API: only published posts and pages, and only if the site lets other web pages read it. An export file always works and includes drafts.'),
        ),
        st.sources.length ? card('To import', list) : null,
        h('div', { class: 'actions' }, h('button', { class: 'primary', icon: 'arrow-right', disabled: !st.sources.length, onclick: () => go(2) }, 'Next: review')),
      );
    }

    // ---------- 2: blogs ----------
    function blogsStep() {
      const many = st.sources.length > 1;
      const cards = st.sources.map((s) => {
        const m = s.model;
        const drafts = m.posts.filter((p) => p.status === 'draft').length + m.pages.filter((p) => p.status === 'draft').length;
        const skipped = Object.entries(m.skipped).map(([k, n]) => `${n} ${k}`).join(', ');
        const inp = (key, attrs = {}) => {
          const el = h('input', { value: s.fields[key], ...attrs });
          el.addEventListener('input', () => { s.fields[key] = el.value; });
          return el;
        };
        const folder = h('input', { value: s.folder, placeholder: many ? 'folder name' : 'blank: the top of the repository' });
        folder.addEventListener('input', () => { s.folder = folder.value.trim().replace(/^\/+|\/+$/g, ''); });
        return card(s.fields.title || s.label,
          h('p', { class: 'muted' }, `${plural(m.posts.length - m.posts.filter((p) => p.status === 'draft').length, 'published post')}, ${plural(drafts, 'draft')}, ${plural(m.pages.length, 'page')}, ${plural(m.media.length, 'media file')}${skipped ? `; not imported: ${skipped}` : ''}`),
          h('div', { class: 'row' }, field('Title', inp('title')), field('Author', inp('author'))),
          h('div', { class: 'row' }, field('Description', inp('description'))),
          h('div', { class: 'row' }, field(many ? 'Folder in the repository' : 'Folder in the repository (optional)', folder, 'Each blog is a folder of one repository; its pictures go in an images folder beside them.')),
        );
      });
      const drafts = h('input', { type: 'checkbox', checked: st.opts.drafts });
      drafts.addEventListener('change', () => { st.opts.drafts = drafts.checked; });
      const library = h('input', { type: 'checkbox', checked: st.opts.library });
      library.addEventListener('change', () => { st.opts.library = library.checked; });
      return h('div', {},
        ...cards,
        card('Options',
          h('label', { class: 'check' }, drafts, ' Import drafts, scheduled and private posts (as drafts; nothing is published that was not)'),
          h('label', { class: 'check' }, library, ' Import every picture in the media library, not only the ones posts use'),
        ),
        h('div', { class: 'actions' }, h('button', { icon: 'arrow-left', onclick: () => go(1) }, 'Back'), h('button', { class: 'primary', icon: 'arrow-right', onclick: () => { if (!valid()) return; run(); } }, 'Next: bring the pictures across')),
      );
    }

    function valid() {
      const folders = new Set();
      for (const s of st.sources) {
        if (!s.fields.title.trim() || !s.fields.description.trim() || !s.fields.author.trim()) {
          fail(new Refusal('import-refused', 'Every blog needs a title, a description and an author.'));
          return false;
        }
        if (st.sources.length > 1 && !s.folder) {
          fail(new Refusal('import-refused', 'With more than one blog, each needs a folder of its own.'));
          return false;
        }
        if (s.folder && !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(s.folder)) {
          fail(new Refusal('import-refused', `"${s.folder}" is not a folder name (letters, digits, . _ - and / only).`));
          return false;
        }
        if (folders.has(s.folder)) {
          fail(new Refusal('import-refused', 'Two blogs have the same folder.'));
          return false;
        }
        folders.add(s.folder);
      }
      return true;
    }

    // ---------- 3: pictures ----------
    async function run() {
      st.step = 3;
      st.cancelled = false;
      st.results = [];
      running = true;
      draw();
      try {
        for (const s of st.sources) {
          const job = planWp(s.model, { today: new Date().toISOString().slice(0, 10), includeDrafts: st.opts.drafts, includeLibrary: st.opts.library });
          status.textContent = `${s.fields.title}: ${plural(job.images.length, 'picture')} to bring across…`;
          bar.max = Math.max(1, job.images.length);
          bar.value = 0;
          const { fetched, failed } = await fetchImages(net, job.images, {
            isCancelled: () => st.cancelled,
            onProgress: (p) => {
              bar.max = Math.max(1, p.total);
              bar.value = p.done;
              status.textContent = `${s.fields.title}: ${p.done} of ${p.total} pictures (${fmtBytes(p.bytes)}${p.failed ? `, ${p.failed} could not be read` : ''})`;
            },
          });
          if (st.cancelled) break;
          const out = job.finish(fetched);
          st.results.push({ source: s, job, out, failed });
        }
      } catch (e) {
        fail(e);
      }
      running = false;
      if (st.cancelled) return go(2);
      draw();
    }

    function picturesStep() {
      if (running || !st.results.length) {
        return h('div', {}, card('Bringing the pictures across', bar, status, h('p', { class: 'hint' }, 'They are read from the old site by this page, with no account and no cookies, and held in memory until you commit.')),
          h('div', { class: 'actions' }, h('button', { icon: 'x', onclick: () => { st.cancelled = true; status.textContent = 'Stopping…'; } }, 'Cancel')));
      }
      const cards = st.results.map(({ source, out, failed, job }) => {
        const s = out.summary;
        const byText = new Map();
        for (const n of out.notes) byText.set(n.text, [...(byText.get(n.text) || []), n.where]);
        const why = [...new Set(failed.values())];
        return card(source.fields.title,
          h('p', {}, h('b', {}, `${plural(s.posts, 'post')}, ${plural(s.drafts, 'draft')}, ${plural(s.pages, 'page')}`), ` converted to markdown; ${plural(s.images, 'picture')} (${fmtBytes(s.imageBytes)}) brought across.`),
          s.imagesFailed ? h('div', { class: 'caution' }, `${plural(s.imagesFailed, 'picture')} could not be brought across: ${why.slice(0, 3).join('; ')}. Where posts use them they stay linked to the old site, so nothing breaks while the old site is up. For every picture, use the command line importer (it is not limited by what a website allows): `, h('code', {}, 'node cli/blog.js import wp export.xml my-blog'), '.') : null,
          s.internalLinks ? h('p', { class: 'muted' }, `${plural(s.internalLinks, 'link')} between your posts now point at the new pages.`) : null,
          byText.size ? h('details', {}, h('summary', {}, `${plural(byText.size, 'thing')} to know about`), h('ul', { class: 'notes' }, [...byText].slice(0, 100).map(([text, where]) => h('li', {}, text, h('span', { class: 'muted' }, ` — ${where.slice(0, 3).join(', ')}${where.length > 3 ? ` and ${where.length - 3} more` : ''}`))))) : h('p', { class: 'muted' }, 'Nothing was flattened or dropped.'),
        );
      });
      return h('div', {}, ...cards,
        h('div', { class: 'actions' }, h('button', { icon: 'arrow-left', onclick: () => go(2) }, 'Back'), h('button', { class: 'primary', icon: 'arrow-right', onclick: () => go(4) }, 'Next: choose where it goes')));
    }

    // ---------- 4: commit ----------
    function commitStep() {
      const repo = h('input', { value: st.repo, placeholder: 'owner/repository', 'aria-label': 'Repository' });
      repo.addEventListener('input', () => { st.repo = repo.value.trim(); });
      const branch = h('input', { value: st.branch, placeholder: 'default branch', 'aria-label': 'Branch' });
      branch.addEventListener('input', () => { st.branch = branch.value.trim(); });
      const out = h('div', {});
      const send = h('button', { class: 'primary', icon: 'git-commit', onclick: async () => {
        if (!gh.token) return signInDialog();
        send.disabled = true;
        try {
          const where = parseRepoRef(st.repo).ref;
          const { repo: plain } = parseRepoRef(where);
          const info = await gh.repoInfo(plain);
          if (!(info.permissions && info.permissions.push)) throw new Refusal('import-refused', `Your token cannot write to ${plain}. Choose a repository you own, or give the token access to it.`);
          const target = st.branch || info.default_branch;
          const blogs = st.results.map(({ source, out: o }) => ({ folder: source.folder, fields: source.fields, files: o.files, assets: o.assets }));
          const plan = await working('Preparing the pre-flight…', () => planImport(gh, { where, branch: target, blogs }), { button: send });
          if (!(await confirmPlan(plan))) return;
          const receipt = await working('Committing…', () => executeImport(gh, plan), { button: send });
          sent(receipt, { title: 'Imported from WordPress' });
          out.replaceChildren(card('Done',
            h('p', {}, `${plan.headline[0]} are in ${plain}.`),
            h('ul', { class: 'src' }, plan.blogs.map((b) => h('li', {}, h('b', {}, b.title), ' ', nav('Open in the editor', `#repo=${b.folder ? `${plain}/${b.folder}` : plain}`)))),
            h('p', { class: 'hint' }, 'Turn on GitHub Pages for the repository (Settings → Pages) to publish it. Each blog has its own Settings screen here, where you can pick a theme.'),
          ));
        } catch (e) {
          fail(e);
        } finally {
          send.disabled = false;
        }
      } }, gh.token ? 'Review and commit…' : 'Sign in to commit');
      return h('div', {},
        card('Where it goes',
          h('p', {}, 'An existing repository of yours (it must have at least one commit). Each blog goes in its own folder; pictures go in an ', h('code', {}, 'images'), ' folder beside them. An existing blog is never replaced.'),
          h('div', { class: 'row' }, field('Repository', repo, st.sources.length > 1 ? 'owner/name, or owner/name/folder to put every blog below a folder' : 'owner/name, or owner/name/folder'), field('Branch', branch, 'Blank: the default branch')),
          h('p', { class: 'hint' }, 'Nothing has been uploaded so far. Pressing the button shows exactly what will be sent before anything is.'),
        ),
        out,
        h('div', { class: 'actions' }, h('button', { icon: 'arrow-left', onclick: () => go(3) }, 'Back'), send),
      );
    }

    // the screen: a way to begin again, and the step the person was on
    startOver = () => {
      st = fresh();
      draw();
    };
    show = draw;
  }
  return function importView() {
    show();
    return root;
  };
}

// Anonymous comments without a server (gates C1-C14): three exclusive modes, a sidecar with a closed key set, plain-text bodies,
// deterministic order, one renderer, an exact incremental publish, and a migration out of old imported post bodies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSite, validateBlog } from '../lib/blog.js';
import { parseComments, commentsSectionHtml, bodyHtml } from '../lib/comments.js';
import { liftComments } from '../lib/comments-lift.js';
import { prepareIncremental } from '../lib/incremental.js';
import { loadSite } from '../lib/live-render.js';
import { previewHtml } from '../lib/preview.js';
import { planWp } from '../lib/wp-content.js';
import { Refusal } from '../lib/errors.js';
import { parseWxr } from '../lib/wxr.js';
import { WXR } from './wp-fixtures.js';

const BASE = { title: 'T', description: 'D', author: 'Ann', domain: 'https://x.test/b', repo: 'me/b' };
const post = (slug, extra = '') => ({ path: `posts/${slug}.md`, text: `---\nslug: ${slug}\ntitle: "Post ${slug}"\ndate: 2026-01-0${slug.length}\nauthor: Ann\nstatus: published\n${extra}---\n\nWords of ${slug}.\n` });
const side = (slug, list) => ({ path: `comments/${slug}.json`, text: JSON.stringify({ comments: list }) });
const build = (comments, posts, more = {}) => buildSite({ blog: { ...BASE, ...(comments ? { comments } : {}), ...more }, posts, lock: {} });
const refused = (f) => assert.throws(f, (e) => e instanceof Refusal && e.code === 'bad-comments');
const C = (o) => ({ id: 'c1', name: 'Ada', date: '2026-11-09', body: 'Hello', ...o });

test('C1: modes are exclusive, off by default, and a bare src is the old script mode', () => {
  assert.equal(validateBlog(BASE).comments, undefined);
  assert.ok(validateBlog({ ...BASE, comments: { src: 'https://c.test/s.js' } }).comments);
  assert.ok(validateBlog({ ...BASE, comments: { mode: 'mailto', to: 'me@example.com' } }).comments);
  assert.throws(() => validateBlog({ ...BASE, comments: { mode: 'mailto', to: 'me@example.com', action: 'https://r.test/f' } }));
  assert.throws(() => validateBlog({ ...BASE, comments: { mode: 'form', action: 'https://r.test/f', src: 'https://c.test/s.js' } }));
  assert.throws(() => validateBlog({ ...BASE, comments: { mode: 'form', action: 'http://r.test/f' } }), 'https only');
  assert.throws(() => validateBlog({ ...BASE, comments: { mode: 'other' } }));
  const r = build({ src: 'https://c.test/s.js' }, [post('a')]);
  assert.match(r.files['a/index.html'], /<script[^>]+c\.test\/s\.js/);
});

const FORM = { mode: 'form', action: 'https://relay.test/f/abc', field: 'comment', nameField: 'name', hidden: { form: 'x' }, return: '_next', title: 'Leave a comment' };

test('C2, C3, C13: a form is plain HTML with no script; slug and return are the post\'s own; the page says where it goes', () => {
  const r = build(FORM, [post('abc')]);
  assert.deepEqual(r.errors, []);
  const page = r.files['abc/index.html'];
  const form = /<form[^>]*>[\s\S]*?<\/form>/.exec(page)?.[0] || '';
  assert.match(form, /method="post"/);
  assert.match(form, /action="https:\/\/relay\.test\/f\/abc"/);
  assert.match(form, /name="slug" value="abc"/);
  assert.match(form, /name="_next" value="https:\/\/x\.test\/b\/abc\/"/);
  assert.match(form, /name="comment"/);
  assert.ok(!/<script(?![^>]*ld\+json)/i.test(page), 'no executable script on the page');
  assert.match(page, /relay\.test/);
  assert.match(page, /published here if the author approves it/);
  assert.match(page, /No email address is collected or stored/);
  assert.match(page, /no live thread/);
});

test('C1: mailto is a link carrying the slug, with no third party', () => {
  const page = build({ mode: 'mailto', to: 'me@example.com' }, [post('abc')]).files['abc/index.html'];
  assert.match(page, /mailto:me@example\.com\?subject=[^"]*abc/);
  assert.ok(!/<script(?![^>]*ld\+json)|<form/i.test(page));
});

test('C14: a draft or scheduled post has no page, so no form and no comments', () => {
  const draft = { path: 'posts/dr.md', text: '---\nslug: dr\ntitle: "D"\ndate: 2026-01-01\nauthor: Ann\nstatus: draft\n---\n\nx\n' };
  const r = build(FORM, [post('abc'), draft, side('dr', [C()])]);
  assert.ok(!r.files['dr/index.html']);
  assert.ok(!Object.values(r.files).some((t) => typeof t === 'string' && t.includes('relay.test') && t.includes('value="dr"')));
});

test('C4: only id, name, date, body and reply_to are accepted', () => {
  assert.equal(parseComments(JSON.stringify({ comments: [C({ name: undefined })] }), 'x').length, 1);
  for (const k of ['email', 'ip', 'user_agent', 'provider_id']) refused(() => parseComments(JSON.stringify({ comments: [{ ...C(), [k]: 'x' }] }), 'x'));
  refused(() => parseComments(JSON.stringify({ comments: [C()], extra: 1 }), 'x'));
  refused(() => parseComments('not json', 'x'));
});

test('C5: anything matching an email address anywhere in the file is refused', () => {
  refused(() => parseComments(JSON.stringify({ comments: [C({ body: 'write to ada@example.com' })] }), 'x'));
  refused(() => parseComments(JSON.stringify({ comments: [C({ name: 'ada@example.com' })] }), 'x'));
});

test('C6: a body is escaped text with paragraph breaks only: no markup, no links, no markdown', () => {
  const html = bodyHtml('<b>hi</b> [a](https://e.test) https://spam.test/x\n\n*not italic* & <script>alert(1)</script>');
  assert.ok(!/<(b|a|em|script)\b/.test(html), html);
  assert.match(html, /&lt;b&gt;hi&lt;\/b&gt;/);
  assert.match(html, /https:\/\/spam\.test\/x/);
  assert.equal((html.match(/<p>/g) || []).length, 2);
  refused(() => parseComments(JSON.stringify({ comments: [C({ body: 'a\u0007b' })] }), 'x'));
  refused(() => parseComments(JSON.stringify({ comments: [C({ body: 'a\ud800b' })] }), 'x'));
  refused(() => parseComments(JSON.stringify({ comments: [C({ body: 'x'.repeat(6000) })] }), 'x'));
  const section = commentsSectionHtml(parseComments(JSON.stringify({ comments: [C({ body: '<img src=x onerror=1>' })] }), 'x'), {});
  assert.ok(!/<img/.test(section));
});

test('C7, C9: ids are authored; deleting one renumbers nothing; a bad reply_to is refused', () => {
  const three = [C({ id: 'c1' }), C({ id: 'c2', date: '2026-11-10', reply_to: 'c1' }), C({ id: 'c3', date: '2026-11-11', reply_to: 'c2' })];
  assert.equal(parseComments(JSON.stringify({ comments: three }), 'x').length, 3);
  const without = [three[0], three[2]];
  refused(() => parseComments(JSON.stringify({ comments: without }), 'x')); // c3 answers the deleted c2: the reply must be edited, ids stay
  assert.equal(parseComments(JSON.stringify({ comments: [three[0], { ...three[2], reply_to: 'c1' }] }), 'x')[1].id, 'c3');
  refused(() => parseComments(JSON.stringify({ comments: [C({ reply_to: 'nope' })] }), 'x'));
  refused(() => parseComments(JSON.stringify({ comments: [C({ reply_to: 'c1' })] }), 'x'));
  refused(() => parseComments(JSON.stringify({ comments: [C({ id: 'c1', date: '2026-11-12', reply_to: 'c2' }), C({ id: 'c2', date: '2026-11-13' })] }), 'x'));
  refused(() => parseComments(JSON.stringify({ comments: [C(), C()] }), 'x'));
  refused(() => parseComments(JSON.stringify({ comments: [C({ date: '2026-02-30' })] }), 'x'));
});

test('C8: oldest first, ties by id; any input order gives byte-identical output', () => {
  const list = [C({ id: 'c3', date: '2026-11-10' }), C({ id: 'c2' }), C({ id: 'c1' }), C({ id: 'c4', date: '2026-11-08', reply_to: undefined })];
  const a = build(FORM, [post('abc'), side('abc', list)]);
  const b = build(FORM, [side('abc', [...list].reverse()), post('abc')]);
  assert.deepEqual(a.errors, []);
  assert.equal(a.files['abc/index.html'], b.files['abc/index.html']);
  const ids = [...a.files['abc/index.html'].matchAll(/id="comment-(c\d)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['c4', 'c1', 'c2', 'c3']);
  assert.match(a.files['abc/index.html'], /Comments \(4\)/);
});

test('C12: the count is in the index; adding a comment publishes exactly what a full build gives', async () => {
  const posts = ['aa', 'bbb', 'cccc'].map((s) => post(s));
  const blog = { ...BASE, comments: FORM, pageSize: 2 };
  const before = buildSite({ blog, posts, lock: {} });
  assert.deepEqual(before.errors, []);
  const sidecar = side('bbb', [C()]);
  const after = buildSite({ blog, posts: [...posts, sidecar], lock: {} });
  assert.match(after.files['index/posts.json'], /"comments":\s*1/);
  assert.ok(!/"comments"/.test(before.files['index/posts.json']));
  const enc = new TextEncoder();
  const get = async (p) => (p === 'blog.json' ? enc.encode(JSON.stringify(blog)) : p === 'assets.lock.json' ? enc.encode('{}') : before.files[p] !== undefined ? enc.encode(before.files[p]) : null);
  const site = await loadSite(get, { anyBlog: true });
  const change = { ...posts[1], comments: sidecar.text };
  const prep = prepareIncremental({ site, change, lock: {}, slugs: new Set(['aa', 'bbb', 'cccc']), existing: new Set(Object.keys(before.files)), minPosts: 0 });
  assert.ok(!prep.reason, prep.reason);
  const res = prep.run({ texts: new Map(prep.need.slugs.map((s) => [s, posts.find((p) => p.path === `posts/${s}.md`).text])), files: new Map(prep.need.files.map((f) => [f, before.files[f]])) });
  const state = { ...before.files };
  for (const f of res.remove) delete state[f];
  Object.assign(state, res.files);
  const wrong = Object.keys(after.files).filter((f) => state[f] !== after.files[f]);
  assert.deepEqual(wrong, []);
  assert.ok(Object.keys(res.files).length < Object.keys(after.files).length, 'not a full rebuild');
});

test('C11: the generator and the preview draw the same comments section', async () => {
  const posts = [post('abc'), side('abc', [C(), C({ id: 'c2', name: undefined, date: '2026-11-10', reply_to: 'c1', body: 'one\n\ntwo' })])];
  const blog = { ...BASE, comments: FORM };
  const built = buildSite({ blog, posts, lock: {} });
  const page = built.files['abc/index.html'];
  const want = /<section class="comments comments-area"[\s\S]*?<\/section>/.exec(page)?.[0];
  assert.ok(want, 'section in the generated page');
  const enc = new TextEncoder();
  const get = async (p) => (p === 'blog.json' ? enc.encode(JSON.stringify(blog)) : p === 'assets.lock.json' ? enc.encode('{}') : built.files[p] !== undefined ? enc.encode(built.files[p]) : null);
  const site = await loadSite(get, { anyBlog: true });
  const pv = previewHtml(site, 'abc/index.html', { text: posts[0].text, comments: posts[1].text });
  assert.ok(pv.html.includes(want), 'preview draws the same section');
});

test('C10: the importer writes comments/<slug>.json, not the post body, with no email', () => {
  const job = planWp(parseWxr(WXR, { today: '2026-11-06' }), { today: '2026-11-06' });
  const plan = job.finish(new Map(job.images.map((im) => [im.url, null])));
  const sides = plan.files.filter((f) => /^comments\/.+\.json$/.test(f.path));
  assert.ok(sides.length >= 1, 'a sidecar');
  for (const s of sides) parseComments(s.text, s.path);
  for (const f of plan.files.filter((x) => /^posts\/.+\.md$/.test(x.path))) assert.ok(!/^## Comments/m.test(f.text), 'no comments in the body');
});

test('C10: a migration lifts the old "## Comments" section into a sidecar and leaves the post without it', () => {
  const old = `${post('abc').text}\n## Comments (3)\n\n**Ann** · 2026-01-02\n> First line.\n>\n> Second para.\n\n**Bob** · 2026-01-03 — replying to Ann\n> Mail bob@example.com\n\n**Anonymous** · 2026-01-04\n> Hi\n`;
  const r = liftComments(old);
  assert.equal(r.count, 3);
  assert.ok(!/Comments \(/.test(r.post));
  const list = parseComments(r.sidecar, 'x');
  assert.deepEqual(list.map((c) => c.id), ['c1', 'c2', 'c3']);
  assert.equal(list[1].reply_to, 'c1');
  assert.match(list[0].body, /First line\.\n\nSecond para\./);
  assert.ok(!/bob@example/.test(r.sidecar));
  assert.equal(liftComments('no comments here\n'), null);
  const built = build(FORM, [{ path: 'posts/abc.md', text: r.post }, { path: 'comments/abc.json', text: r.sidecar }]);
  assert.deepEqual(built.errors, []);
  assert.match(built.files['abc/index.html'], /Comments \(3\)/);
});

test('settings: comments by mail or relay round-trip through the form; one mode at a time', async () => {
  const { formToBlog, blogToForm } = await import('../lib/settings.js');
  const base = { ...BASE, comments: FORM };
  const same = formToBlog(base, blogToForm(base));
  assert.deepEqual(same.comments, FORM);
  const mail = formToBlog({ ...BASE }, { ...blogToForm(BASE), commentsMail: 'me@example.com' });
  assert.deepEqual(mail.comments, { mode: 'mailto', to: 'me@example.com' });
  assert.equal(formToBlog(base, { ...blogToForm(base), commentsAction: '' }).comments, undefined);
  assert.equal(formToBlog(base, { ...blogToForm(base), commentsAction: '', commentsSrc: 'https://c.test/s.js' }).comments.src, 'https://c.test/s.js');
});

// The address a blog is served at is GitHub's to say: read from its Pages settings, never typed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { detectAddress, executePlan, loadBlog, planInit, planSettings } from '../app/site.js';
import { addressFrom, defaultDomain, pagesRoot } from '../lib/init.js';
import { blogToForm } from '../lib/settings.js';
import { fakeGitHub } from './fake-github.js';

async function world({ pages = {}, blog = {} } = {}) {
  const bj = { title: 'T', description: 'd', author: 'A', domain: 'https://old.example/guess', repo: 'me/site/blog', theme: 'default', ...blog };
  const server = fakeGitHub({ 'me/site': { 'blog/blog.json': JSON.stringify(bj, null, 2) + '\n', '.nojekyll': '' }, 'me/empty': { 'README.md': 'x' }, 'me/me.github.io': { 'README.md': 'x' } }, { pages });
  await server.ready;
  return { server, gh: new GitHub(createNet(server.fetch), { token: 'github_pat_test' }) };
}

test('address: Pages address by convention, with a custom one from GitHub when there is one', () => {
  assert.equal(pagesRoot('me/site'), 'https://me.github.io/site');
  assert.equal(pagesRoot('Me/me.github.io'), 'https://Me.github.io', 'a user site is served at the root');
  assert.equal(defaultDomain('me/site/blog'), 'https://me.github.io/site/blog');
  assert.equal(addressFrom('me/site/blog', null), 'https://me.github.io/site/blog');
  assert.equal(addressFrom('me/site/blog', 'https://me.github.io/site/'), 'https://me.github.io/site/blog', 'trailing slash dropped');
  assert.equal(addressFrom('me/site', 'https://notes.example.com/'), 'https://notes.example.com', 'a custom domain is GitHub\'s to give');
  assert.equal(addressFrom('me/site/a/b', 'https://notes.example.com/'), 'https://notes.example.com/a/b');
  assert.equal(addressFrom('me/site/blog', 'http://notes.example.com/site/'), 'http://notes.example.com/site/blog', 'a custom domain without HTTPS enforced is reported as http: and is GitHub\'s truth');
  for (const bad of ['javascript:alert(1)', 'ftp://x.example/', 'data:text/html,x', 'not a url', '', 7]) assert.equal(addressFrom('me/site', bad), 'https://me.github.io/site', `ignores ${bad}`);
});

test('detect: Pages off, on and readable, on but unreadable', async () => {
  const off = await world();
  assert.deepEqual(await detectAddress(off.gh, 'me/site/blog'), { address: 'https://me.github.io/site/blog', live: false, exact: false, built: false, readable: true, settingsUrl: 'https://github.com/me/site/settings/pages' });
  const on = await world({ pages: { 'me/site': 'https://notes.example.com/' } });
  assert.deepEqual(await detectAddress(on.gh, 'me/site/blog'), { address: 'https://notes.example.com/blog', live: true, exact: true, built: true, readable: true, settingsUrl: 'https://github.com/me/site/settings/pages' });
  const building = await world({ pages: { 'me/site': 'building:https://me.github.io/site/' } });
  const b = await detectAddress(building.gh, 'me/site/blog');
  assert.deepEqual([b.live, b.exact, b.built], [true, true, false], 'on, but GitHub has not deployed it yet');
  const locked = await world({ pages: { 'me/site': 'forbidden' } });
  const d = await detectAddress(locked.gh, 'me/site/blog');
  assert.deepEqual([d.live, d.exact, d.readable], [true, false, false], 'on, but the token cannot read it: not claimed as exact');
});

test('creating a blog: the address is GitHub\'s, whatever the form says', async () => {
  const { gh, server } = await world({ pages: { 'me/empty': 'https://custom.example.org/' } });
  const plan = await planInit(gh, { repo: 'me/empty/journal', branch: 'main', fields: { title: 'J', description: 'd', author: 'a', domain: 'https://typed.example/wrong' } });
  await executePlan(gh, plan);
  assert.equal(JSON.parse(server.files('me/empty')['journal/blog.json']).domain, 'https://custom.example.org/journal');

  const off = await planInit(gh, { repo: 'me/me.github.io', branch: 'main', fields: { title: 'U', description: 'd', author: 'a', domain: 'https://typed.example/wrong' } });
  assert.equal(JSON.parse(off.changes.find((c) => c.path === 'blog.json').content).domain, 'https://me.github.io', 'Pages off: the convention, not what was typed');
});

test('settings: saving never takes an address from the form; GitHub\'s wins, else blog.json keeps what it had', async () => {
  const typed = (blog) => ({ ...blogToForm(blog), domain: 'https://typed.example/wrong', title: 'New title' });
  const save = async (w) => {
    const { blog } = await loadBlog(w.gh, 'me/site/blog', 'main');
    await executePlan(w.gh, await planSettings(w.gh, { repo: 'me/site/blog', branch: 'main', form: typed(blog) }));
    return JSON.parse(w.server.files('me/site')['blog/blog.json']);
  };
  const exact = await save(await world({ pages: { 'me/site': 'https://notes.example.com/' } }));
  assert.equal(exact.domain, 'https://notes.example.com/blog');
  assert.equal(exact.title, 'New title', 'the other settings still save');

  const off = await save(await world());
  assert.equal(off.domain, 'https://old.example/guess', 'nothing from GitHub: what was saved stays, not what was typed');

  const locked = await save(await world({ pages: { 'me/site': 'forbidden' } }));
  assert.equal(locked.domain, 'https://old.example/guess');
});

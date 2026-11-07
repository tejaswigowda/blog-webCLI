// A reader holds no token, so it reads from GitHub's raw host, which keeps every address for minutes. The address is spelled differently
// on (nearly) every read, so a file just published is read as it is now, and every spelling still names the same file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNet } from '../app/net.js';
import { GitHub, rawUrl } from '../app/github.js';
import { fakeGitHub } from './fake-github.js';

const canonical = (u) => decodeURIComponent(new URL(u).pathname);

test('raw reads: the address varies from read to read, and always names the same file', () => {
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const u = rawUrl('me/blog', undefined, 'index/posts.json');
    assert.equal(canonical(u), '/me/blog/HEAD/index/posts.json');
    assert.ok(u.startsWith('https://raw.githubusercontent.com/me/blog/'));
    assert.equal(new URL(u).search, '', 'no query string: the host ignores it');
    seen.add(u);
  }
  assert.ok(seen.size > 30, `${seen.size} different spellings in 60 reads`);
  // a branch is varied too; "/" and "." are never encoded
  assert.equal(canonical(rawUrl('me/blog', 'main', 'posts/a.b.md')), '/me/blog/main/posts/a.b.md');
  assert.ok(!/%2[Ef]/i.test(rawUrl('me/blog', 'main', 'posts/a.b.md')), 'structure is left alone');
  // anything outside letters, digits and . _ - / is sent as before
  assert.equal(rawUrl('me/blog', 'feature/x y', 'posts/é.md'), 'https://raw.githubusercontent.com/me/blog/feature%2Fx%20y/posts/%C3%A9.md');
});

test('raw reads: an anonymous read gets the file whatever the spelling', async () => {
  const server = fakeGitHub({ 'me/blog': { 'blog.json': '{"a":1}', 'index/posts.json': '{"posts":[]}', 'posts/a-b.md': 'text' } });
  await server.ready;
  const urls = [];
  const gh = new GitHub(createNet((u, o) => { urls.push(String(u)); return server.fetch(u, o); }));
  for (let i = 0; i < 20; i++) {
    assert.equal(await gh.readText('me/blog', 'index/posts.json'), '{"posts":[]}');
    assert.equal(await gh.readText('me/blog', 'posts/a-b.md', 'main'), 'text');
    assert.equal(await gh.readText('me/blog', 'nothing.md'), null);
  }
  assert.ok(new Set(urls.filter((u) => canonical(u).endsWith('posts.json'))).size > 5);
});

// app-build.json says which build of the editor this is (a digest of every script of app/ and lib/), so a tab that was opened before an
// update can tell, and send nothing. The file is generated: it is never stale here, and a commit is stopped by the guard before a request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appBuild } from '../cli/build-live.js';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { Refusal } from '../lib/errors.js';
import { fakeGitHub } from './fake-github.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('app-build.json is what app/ and lib/ build to', async () => {
  const have = await fs.readFile(path.join(root, 'app-build.json'), 'utf8');
  assert.equal(have, await appBuild(), 'run `node cli/build-live.js`');
  assert.match(JSON.parse(have).id, /^[0-9a-f]{16}$/);
});

test('a commit is stopped by the guard before anything is sent', async () => {
  const server = fakeGitHub({ 'me/b': { 'blog.json': '{}' } });
  await server.ready;
  const gh = new GitHub(createNet(server.fetch), { token: 'github_pat_test' });
  const head = await gh.headCommit('me/b', 'main');
  const before = server.state['me/b'].log.length;
  gh.beforeWrite = async () => { throw new Refusal('stale-app', 'reload'); };
  await assert.rejects(gh.commit('me/b', { branch: 'main', parent: head.sha, baseTree: head.treeSha, files: [{ path: 'a.txt', content: 'x' }], message: 'm' }), (e) => e instanceof Refusal && e.code === 'stale-app');
  assert.equal(server.state['me/b'].log.length, before, 'no request was made');
  gh.beforeWrite = async () => {};
  await gh.commit('me/b', { branch: 'main', parent: head.sha, baseTree: head.treeSha, files: [{ path: 'a.txt', content: 'x' }], message: 'm' });
  assert.equal(server.files('me/b')['a.txt'], 'x');
});

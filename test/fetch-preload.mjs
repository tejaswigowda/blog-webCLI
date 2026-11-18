// Preloaded into a CLI subprocess (node --import): replaces global fetch with an in-memory GitHub that
// holds a theme, so the CLI can be tested without the network or real repositories.
import path from 'node:path';
import { fakeGitHub } from './fake-github.js';
import { EX, readDirFiles } from './helpers.js';

const themeFiles = await readDirFiles(path.join(EX, 'theme-plain'));
const repos = { 'me/theme': themeFiles };
const server = fakeGitHub(repos, { tags: Object.fromEntries(Object.keys(repos).map((r) => [r, ['v1.0.0']])), aliases: Object.fromEntries(Object.keys(repos).map((r) => [r, { 'v1.0.0': 'main' }])) });
await server.ready;
globalThis.fetch = (url, init) => {
  if (String(url).startsWith('https://cdn.jsdelivr.net/gh/example/images@') || String(url).startsWith(`https://cdn.jsdelivr.net/gh/me/site@${'a'.repeat(40)}/images/`)) {
    if (init?.credentials !== 'omit') return Promise.resolve(new Response('credentials not omitted', { status: 403 }));
    const status = Number(process.env.TEST_ASSET_STATUS || 200);
    return Promise.resolve(new Response(status === 200 ? 'fixture image' : 'not found', { status, headers: { 'content-type': process.env.TEST_ASSET_HTML ? 'text/html' : 'image/png' } }));
  }
  return server.fetch(url, init);
};

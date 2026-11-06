// Preloaded into a CLI subprocess (node --import): replaces global fetch with an in-memory GitHub that
// holds a theme and extensions, so the CLI can be tested without the network or real repositories.
import path from 'node:path';
import { fakeGitHub } from './fake-github.js';
import { EX, readDirFiles } from './helpers.js';

const themeFiles = await readDirFiles(path.join(EX, 'theme-plain'));
const extFiles = await readDirFiles(path.join(EX, 'ext-reading-time'));
// An extension that would leave a marker on disk if anything ever executed its code.
const trapFiles = { ...extFiles, 'index.mjs': new TextEncoder().encode(`import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.TRAP_MARKER || '/tmp/trap-marker', 'RAN');\nexport const hooks = { 'post:html': (h) => h };`) };
const repos = { 'me/theme': themeFiles, 'me/ext': extFiles, 'me/trap': trapFiles };
const server = fakeGitHub(repos, { tags: Object.fromEntries(Object.keys(repos).map((r) => [r, ['v1.0.0']])), aliases: Object.fromEntries(Object.keys(repos).map((r) => [r, { 'v1.0.0': 'main' }])) });
await server.ready;
globalThis.fetch = (url, init) => server.fetch(url, init);

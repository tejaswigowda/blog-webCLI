// Preloaded into a CLI subprocess (node --import): replaces global fetch with an in-memory GitHub that
// holds a theme, so the CLI can be tested without the network or real repositories.
import path from 'node:path';
import { fakeGitHub } from './fake-github.js';
import { EX, readDirFiles } from './helpers.js';

const themeFiles = await readDirFiles(path.join(EX, 'theme-plain'));
const repos = { 'me/theme': themeFiles };
const server = fakeGitHub(repos, { tags: Object.fromEntries(Object.keys(repos).map((r) => [r, ['v1.0.0']])), aliases: Object.fromEntries(Object.keys(repos).map((r) => [r, { 'v1.0.0': 'main' }])) });
await server.ready;
globalThis.fetch = (url, init) => server.fetch(url, init);

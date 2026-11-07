// The registry of themes and extensions lives in its own repository (blog-registry), as static JSON; the app reads it by URL
// (app/config.js) and falls back to a bundled snapshot. This is the tooling between the two.
//   node cli/registry.js scaffold <dir>   write the registry repository's files (README, licence, validator, CI) into <dir>
//   node cli/registry.js check <dir>      validate <dir>/themes.json and <dir>/extensions.json; any bad entry fails
//   node cli/registry.js snapshot <dir>   write app/registry-snapshot.json from <dir> (what the app uses when it cannot reach it)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KINDS, parseRegistry } from '../lib/registry.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = path.join(root, 'app', 'registry-snapshot.json');

export async function readRegistry(dir, { strict = true } = {}) {
  const out = { version: 1 };
  const problems = [];
  for (const kind of Object.keys(KINDS)) {
    const text = await fs.readFile(path.join(dir, `${kind}.json`), 'utf8').catch(() => null);
    if (text === null) {
      problems.push(`${kind}.json is missing`);
      out[kind] = [];
      continue;
    }
    try {
      const { entries, rejected } = parseRegistry(kind, text);
      out[kind] = entries;
      for (const r of rejected) problems.push(`${kind}.json entry ${r.index}${r.name ? ` (${r.name})` : ''}: ${r.why}`);
    } catch (e) {
      problems.push(`${kind}.json: ${e.message}`);
      out[kind] = [];
    }
  }
  if (strict && problems.length) throw Object.assign(new Error(problems.join('\n')), { problems });
  return { registry: out, problems };
}

export const snapshotText = (registry) => `${JSON.stringify({ version: 1, $comment: 'The bundled copy of the registry (blog-registry): what the app lists when it cannot reach the registry. Written by `node cli/registry.js snapshot <registry-dir>`; never edit by hand.', themes: registry.themes, extensions: registry.extensions }, null, 2)}\n`;

const template = (f) => fs.readFile(path.join(root, 'templates', 'registry', f), 'utf8');

const MIT = (await fs.readFile(path.join(root, 'lib', 'LICENSE'), 'utf8')).replace(/\n$/, '\n');

export async function scaffold(dir) {
  await fs.mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
  const files = {
    'README.md': await template('README.md'),
    'validate.mjs': await template('validate.mjs'),
    'registry.js': await fs.readFile(path.join(root, 'lib', 'registry.js'), 'utf8'),
    'LICENSE': `The data files (themes.json, extensions.json) are dedicated to the public domain under CC0-1.0:\nhttps://creativecommons.org/publicdomain/zero/1.0/\n\nregistry.js is blog-webCLI's lib/registry.js, under the MIT licence:\n\n${MIT}`,
    '.github/workflows/validate.yml': await template('validate.yml'),
  };
  for (const [f, text] of Object.entries(files)) await fs.writeFile(path.join(dir, f), text);
  return Object.keys(files);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, dir] = process.argv.slice(2);
  if (!['scaffold', 'check', 'snapshot'].includes(cmd) || !dir) {
    console.error('usage: node cli/registry.js scaffold|check|snapshot <registry-dir>');
    process.exit(2);
  }
  try {
    if (cmd === 'scaffold') console.log(`wrote ${(await scaffold(path.resolve(dir))).join(', ')}`);
    if (cmd === 'check') {
      const { registry } = await readRegistry(path.resolve(dir));
      console.log(`ok: ${registry.themes.length} themes, ${registry.extensions.length} extensions`);
    }
    if (cmd === 'snapshot') {
      const { registry } = await readRegistry(path.resolve(dir));
      await fs.writeFile(SNAPSHOT, snapshotText(registry));
      console.log(`wrote app/registry-snapshot.json (${registry.themes.length} themes, ${registry.extensions.length} extensions)`);
    }
  } catch (e) {
    console.error(e.problems ? e.problems.join('\n') : e.message);
    process.exit(1);
  }
}

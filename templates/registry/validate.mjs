// Validates themes.json and extensions.json with the same rules the app applies when it reads them (registry.js).
import { readFile } from 'node:fs/promises';
import { KINDS, parseRegistry } from './registry.js';

let bad = 0;
for (const kind of Object.keys(KINDS)) {
  try {
    const { entries, rejected } = parseRegistry(kind, await readFile(new URL(`./${kind}.json`, import.meta.url), 'utf8'));
    for (const r of rejected) {
      console.error(`${kind}.json entry ${r.index}${r.name ? ` (${r.name})` : ''}: ${r.why}`);
      bad++;
    }
    console.log(`${kind}.json: ${entries.length} valid`);
  } catch (e) {
    console.error(`${kind}.json: ${e.message}`);
    bad++;
  }
}
process.exit(bad ? 1 : 0);

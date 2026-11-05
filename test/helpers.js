import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export async function corpus() {
  const dirs = [path.join(here, 'corpus'), path.join(here, '..', 'examples', 'blog', 'posts')];
  const out = [];
  for (const d of dirs) for (const f of (await fs.readdir(d)).sort()) if (f.endsWith('.md')) out.push({ name: f, text: await fs.readFile(path.join(d, f), 'utf8') });
  return out;
}

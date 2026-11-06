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

// ---- theme / extension fixtures ----
export async function readDirFiles(dir) {
  const out = {};
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out[path.relative(dir, p).split(path.sep).join('/')] = new Uint8Array(await fs.readFile(p));
    }
  };
  await walk(dir);
  return out;
}

export const EX = path.join(here, '..', 'examples');

// Test-only: runs a fixture extension in-process. The product never does this: the app's runner
// is the sandbox (app/sandbox.js), and the CLI and CI run nothing.
export const localRunner = async ({ extension, hook, ctx, input }) => {
  const mod = await import('data:text/javascript;base64,' + Buffer.from(extension.source).toString('base64'));
  return mod.hooks[hook](input, ctx);
};

// The only <script> a default page carries is JSON-LD, which is data and runs nothing; every gate that says "no
// script" means no executable one.
export const stripData = (html) => html.replace(/<script type="application\/ld\+json">[^<]*<\/script>\n?/g, '');

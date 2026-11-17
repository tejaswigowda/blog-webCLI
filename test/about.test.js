import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

test('About and both showcase tutorials match their authored markdown', () => {
  execFileSync(process.execPath, ['cli/build-about.js', '--check'], { cwd: root });
  assert.match(readFileSync(path.join(root, 'about/tutorials/index.html'), 'utf8'), /rebuild-lyceumshorts\.html/);
});

test('relocated guides, screenshots, downloads and public-page links all resolve without scripts', async () => {
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!file.endsWith('.html')) continue;
      const html = await readFile(file, 'utf8');
      assert.doesNotMatch(html, /<script\b|\son[a-z]+=/i, file);
      const base = new URL(path.relative(root, file), 'https://blog.webcli.app/');
      for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
        const url = new URL(match[1].replace(/&amp;/g, '&'), base);
        if (url.origin !== base.origin) continue;
        const target = path.join(root, decodeURIComponent(url.pathname));
        const info = await stat(target);
        if (info.isDirectory()) assert.ok((await stat(path.join(target, 'index.html'))).isFile(), `${file}: ${url.pathname}`);
      }
    }
  };
  await walk(path.join(root, 'about'));
});

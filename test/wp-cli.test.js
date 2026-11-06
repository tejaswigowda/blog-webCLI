// The command-line WordPress import: files in, files out; pictures fetched by Node, so whatever a site's CORS policy says.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PNG, WXR } from './wp-fixtures.js';

const run = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 1, 0, 72]);
const cli = (...args) => run('node', [path.join(root, 'cli', 'blog.js'), ...args]).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
const walk = async (dir, base = dir) => {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, base)));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
};

async function oldSite() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie, referer: req.headers.referer, auth: req.headers.authorization });
    const p = decodeURIComponent(req.url);
    if (p.endsWith('/cat.jpg') || p.endsWith('/My Unused Photo.JPG')) return res.writeHead(200).end(Buffer.from(PNG));
    if (p.endsWith('/dog.jpg')) return res.writeHead(200).end(Buffer.from(JPG));
    res.writeHead(404).end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, seen, origin: `http://127.0.0.1:${server.address().port}` };
}

test('cli import wp: an export file becomes a blog directory and an images directory that build', async () => {
  const site = await oldSite();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wp-cli-'));
  try {
    const xml = WXR.replaceAll('https://old.example.org', site.origin);
    await fs.writeFile(path.join(tmp, 'export.xml'), xml);
    const blog = path.join(tmp, 'blog');
    const r = await cli('import', 'wp', path.join(tmp, 'export.xml'), blog, '--repo', 'me/site/blog');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /3 pictures to fetch/);
    assert.match(r.stdout, /wrote 2 posts, 2 drafts, 2 pages and 3 pictures/);
    assert.match(r.stdout, /note: a table was flattened to lines of text/);
    assert.match(r.stdout, /not imported: 1 product/);
    assert.match(r.stdout, /next: commit and push the pictures/);

    assert.deepEqual(await walk(blog), ['blog.json', 'pages/about-us.md', 'pages/tags-wp.md', 'posts/hello-welcome.md', 'posts/not-ready.md', 'posts/second-post.md', 'posts/secret.md']);
    assert.deepEqual(await walk(path.join(tmp, 'images')), ['wp/2022/01/My-Unused-Photo.JPG', 'wp/2024/05/cat.jpg', 'wp/2024/06/dog.jpg'], 'the pictures sit beside a blog that has a folder of its own');
    const bj = JSON.parse(await fs.readFile(path.join(blog, 'blog.json'), 'utf8'));
    assert.equal(bj.repo, 'me/site/blog');
    assert.equal(bj.title, 'Ada & Friends');
    assert.equal(bj.domain, 'https://me.github.io/site/blog');
    assert.deepEqual(new Uint8Array(await fs.readFile(path.join(tmp, 'images', 'wp/2024/06/dog.jpg'))), JPG);

    // the requests carried nothing about the person importing
    assert.ok(site.seen.length >= 3);
    for (const s of site.seen) assert.ok(!s.cookie && !s.auth && !s.referer, JSON.stringify(s));

    // once the pictures are pushed they are pinned; then the blog builds and checks
    const lock = Object.fromEntries((await walk(path.join(tmp, 'images'))).map((f) => [`images/${f}`, 'a'.repeat(40)]));
    await fs.writeFile(path.join(blog, 'assets.lock.json'), JSON.stringify(lock));
    const built = await cli('build', blog);
    assert.equal(built.code, 0, built.stderr);
    assert.equal((await cli('check', blog)).code, 0);
    assert.match(await fs.readFile(path.join(blog, 'hello-welcome', 'index.html'), 'utf8'), /cat\.jpg/);

    // an import never replaces a blog
    const again = await cli('import', 'wp', path.join(tmp, 'export.xml'), blog, '--repo', 'me/site/blog');
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already has a blog\.json/);
  } finally {
    site.server.close();
    await fs.rm(tmp, { recursive: true });
  }
});

test('cli import wp: options, a blog at the top of a repository, and plain refusals', async () => {
  const site = await oldSite();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wp-cli-'));
  try {
    await fs.writeFile(path.join(tmp, 'export.xml'), WXR.replaceAll('https://old.example.org', site.origin));
    const blog = path.join(tmp, 'top');
    const r = await cli('import', 'wp', path.join(tmp, 'export.xml'), blog, '--repo', 'me/blog', '--no-drafts', '--no-library', '--domain', 'https://blog.example');
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await walk(path.join(blog, 'images')), ['wp/2024/05/cat.jpg', 'wp/2024/06/dog.jpg'], 'no library, and the pictures sit inside a blog at the top of a repository');
    assert.ok(!(await walk(blog)).some((f) => /not-ready|secret/.test(f)));
    assert.equal(JSON.parse(await fs.readFile(path.join(blog, 'blog.json'), 'utf8')).domain, 'https://blog.example');

    assert.match((await cli('import', 'wp', path.join(tmp, 'export.xml'), path.join(tmp, 'x'))).stderr, /--repo/);
    assert.match((await cli('import', 'nope', 'x')).stderr, /usage: blog-webcli import wp/);
    assert.match((await cli('import', 'wp', path.join(tmp, 'export.xml'), path.join(tmp, 'y'), '--repo', 'me/blog', '--bogus')).stderr, /unknown option --bogus/);
    await fs.writeFile(path.join(tmp, 'bad.xml'), '<html></html>');
    const bad = await cli('import', 'wp', path.join(tmp, 'bad.xml'), path.join(tmp, 'z'), '--repo', 'me/blog');
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /bad-wp-export/);
  } finally {
    site.server.close();
    await fs.rm(tmp, { recursive: true });
  }
});

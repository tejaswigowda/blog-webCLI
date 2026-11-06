// Gate X1: no third-party code executes when reading a published blog.
//
// A reader loads (a) a generated static page, or (b) the /blog/ reader. Neither may run code from
// a repository the author has not read. "Third-party code" can only arrive through a few doors:
// a <script>, an event handler, a javascript: URL, a stylesheet that loads more, an iframe that
// is not isolated, or our own code evaluating something it fetched. This file closes each door
// mechanically, so adding one later fails a test instead of relying on review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSiteWith } from '../lib/build-async.js';
import { loadExtension } from '../lib/extensions.js';
import { EX, localRunner, readDirFiles } from './helpers.js';
import { pinForExtension, extensionFilePaths } from '../lib/extensions.js';
import { filesDigest } from '../lib/pin.js';
import { loadTheme, pinFor, themeDigest, themeFilePaths } from '../lib/theme-pack.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- the generated pages ----------
async function configs() {
  const blog = JSON.parse(await fs.readFile(path.join(EX, 'blog', 'blog.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(EX, 'blog', 'assets.lock.json'), 'utf8'));
  const posts = await Promise.all(['static-hls-in-git', 'markdown-is-the-format'].map(async (s) => ({ path: `posts/${s}.md`, text: await fs.readFile(path.join(EX, 'blog', 'posts', `${s}.md`), 'utf8') })));
  const themeOf = async (dir) => {
    const files = await readDirFiles(path.join(EX, dir));
    const m = JSON.parse(new TextDecoder().decode(files['theme.json']));
    const pin = pinFor('me/theme', 'v1.0.0', m, themeDigest(files, themeFilePaths(m)));
    return { pin, theme: loadTheme(pin, files) };
  };
  const extFiles = await readDirFiles(path.join(EX, 'ext-reading-time'));
  const extManifest = JSON.parse(new TextDecoder().decode(extFiles['extension.json']));
  const extPin = pinForExtension('me/ext', 'v1.0.0', extManifest, filesDigest(extFiles, extensionFilePaths(extManifest), (m) => new Error(m)));
  const ext = loadExtension(extPin, extFiles);
  const plain = await themeOf('theme-plain');
  const classic = await themeOf('theme-classic');
  const base = { lock, posts };
  return [
    ['default', { ...base, blog: JSON.stringify(blog) }],
    ['native theme', { ...base, blog: JSON.stringify({ ...blog, theme: plain.pin }), theme: plain.theme }],
    ['classic theme', { ...base, blog: JSON.stringify({ ...blog, theme: classic.pin }), theme: classic.theme }],
    ['classic theme + extension', { ...base, blog: JSON.stringify({ ...blog, theme: classic.pin, extensions: [extPin] }), theme: classic.theme, extensions: [ext] }],
  ];
}

test('X1: a generated page has no script, no event handler, no foreign stylesheet, and only isolated frames', async () => {
  for (const [name, input] of await configs()) {
    const result = await buildSiteWith(input, localRunner);
    assert.deepEqual(result.errors, [], name);
    const pages = Object.entries(result.files).filter(([f]) => f.endsWith('.html'));
    assert.ok(pages.length >= 3, name);
    for (const [file, html] of pages) {
      const where = `${name}: ${file}`;
      const markup = html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
      assert.ok(!/<script\b/i.test(html), `${where}: <script>`);
      assert.ok(!/<noscript\b/i.test(html), `${where}: <noscript>`);
      assert.ok(!/\son[a-z]+\s*=/i.test(markup), `${where}: an event handler attribute`);
      assert.ok(!/javascript:|vbscript:/i.test(markup), `${where}: a script URL`);
      assert.ok(!/<link\b[^>]*rel=["']?(?:stylesheet|preload|modulepreload|prefetch|import)/i.test(html), `${where}: a linked resource`);
      assert.ok(!/<(?:object|embed|applet|base|meta[^>]*http-equiv)/i.test(markup), `${where}: an embedding or redirecting element`);
      assert.ok(!/@import/i.test(html), `${where}: @import`);
      assert.ok(!/<form\b/i.test(markup), `${where}: a form`);
      // every frame is isolated: sandbox="allow-scripts" exactly, no allow-same-origin, no srcdoc
      for (const m of markup.matchAll(/<iframe\b[^>]*>/gi)) {
        assert.match(m[0], /\ssandbox="allow-scripts"(?=[\s>])/, `${where}: ${m[0].slice(0, 80)}`);
        assert.ok(!/allow-same-origin|allow-top-navigation|allow-popups|allow-forms|srcdoc/i.test(m[0]), `${where}: a frame with extra privileges`);
        assert.match(m[0], /\ssrc="https:\/\//, `${where}: a frame that is not https`);
      }
      // the only <meta> are the ones the generator writes; the only <link> are canonical, the feed, and prev/next to
      // another page of the same blog (a relative address, so it cannot name another site)
      for (const m of html.matchAll(/<link\b[^>]*>/gi)) assert.match(m[0], /rel="(?:canonical|alternate)"|rel="(?:prev|next)" href="\.\.\/[a-z0-9-]+\/"/, `${where}: ${m[0]}`);
    }
    // the stylesheet itself loads nothing but https assets and small inline data
    for (const m of (result.files['index.html'].match(/<style>[\s\S]*?<\/style>/) || [''])[0].matchAll(/url\(\s*["']?([^"')]+)/g)) assert.match(m[1], /^(https:\/\/|data:image\/|#)/, `${name}: url(${m[1].slice(0, 50)})`);
  }
});

// ---------- the code that runs when a blog is read ----------
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

async function graph(entry) {
  const seen = new Map();
  const walk = async (file) => {
    if (seen.has(file)) return;
    const src = await fs.readFile(file, 'utf8');
    seen.set(file, src);
    for (const m of src.matchAll(IMPORT)) {
      const spec = m[1] || m[2];
      if (spec.startsWith('.')) await walk(path.resolve(path.dirname(file), spec));
      else if (!spec.startsWith('node:')) throw new Error(`${path.relative(root, file)} imports the package "${spec}"; the product has no dependencies`);
    }
  };
  await walk(path.join(root, entry));
  return seen;
}

// Ways code can be made out of data. None may appear in anything reachable from a reader.
const EVALUATORS = [
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\b|\bFunction\s*\(/, 'Function()'],
  [/\bimport\s*\(/, 'dynamic import()'],
  [/\bnew\s+(?:Shared)?Worker\b|\bimportScripts\b/, 'a Worker'],
  [/createElement\(\s*['"]script['"]/i, 'creating a <script>'],
  [/\.(?:src|href)\s*=[^=]/, 'assigning a src/href (script loading)'],
  [/document\.write\b/, 'document.write'],
  [/setTimeout\(\s*['"`]|setInterval\(\s*['"`]/, 'setTimeout/setInterval with a string'],
  [/\.srcdoc\b|createContextualFragment/, 'srcdoc / contextual fragment'],
];

const stripCommentsAndStrings = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('X1: nothing reachable from the /blog/ reader can run code it fetched', async () => {
  const files = await graph('blog/reader.js');
  const rel = [...files.keys()].map((f) => path.relative(root, f)).sort();
  // the doors that lead to third-party code are not even in the graph
  for (const forbidden of ['app/sandbox.js', 'app/sandbox-frame.js', 'app/packs.js', 'app/editor.js', 'app/app.js']) assert.ok(!rel.includes(forbidden), `${forbidden} is reachable from the reader: ${rel.join(', ')}`);
  assert.ok(rel.includes('lib/contracts.js') && rel.includes('app/reader-core.js'), 'the graph walk found the reader\'s modules');
  for (const [file, src] of files) {
    const code = stripCommentsAndStrings(src);
    for (const [re, what] of EVALUATORS) assert.ok(!re.test(code), `${path.relative(root, file)} uses ${what}`);
  }
  // and the page that hosts it
  const html = await fs.readFile(path.join(root, 'blog', 'index.html'), 'utf8');
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  const directive = (n) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(n + ' ')) || '').slice(n.length + 1);
  assert.equal(directive('script-src'), "'self'", 'scripts only from this origin: no inline, no eval, no remote');
  assert.equal(directive('default-src'), "'none'");
  assert.ok(!/unsafe-eval|unsafe-inline/.test(directive('script-src')));
  assert.equal(directive('connect-src'), 'https://api.github.com https://raw.githubusercontent.com', 'it can only read from GitHub');
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'no inline script in the reader page');
  assert.equal([...html.matchAll(/<script\b[^>]*>/g)].length, 1);
});

test('X1: the generator and the CLI contain no evaluator and never import the sandbox', async () => {
  for (const entry of ['lib/blog.js', 'lib/build-async.js', 'cli/blog.js']) {
    const files = await graph(entry);
    const rel = [...files.keys()].map((f) => path.relative(root, f));
    assert.ok(!rel.includes('app/sandbox.js') && !rel.includes('app/sandbox-frame.js'), `${entry} reaches the sandbox`);
    for (const [file, src] of files) {
      const code = stripCommentsAndStrings(src);
      for (const [re, what] of EVALUATORS.filter(([, w]) => w !== 'assigning a src/href (script loading)')) assert.ok(!re.test(code), `${path.relative(root, file)} (from ${entry}) uses ${what}`);
    }
  }
});

test('X1: the only place a Worker or a dynamic import exists is the sandbox frame', async () => {
  const hits = [];
  const walk = async (dir) => {
    for (const e of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', 'vendor', 'test', 'examples', '.git'].includes(e.name)) continue;
        await walk(p);
      } else if (/\.(?:m?js)$/.test(e.name)) {
        const code = stripCommentsAndStrings(await fs.readFile(path.join(root, p), 'utf8'));
        if (/\bnew\s+Worker\b|\bimportScripts\b|\beval\s*\(|\bnew\s+Function\b/.test(code)) hits.push(p);
      }
    }
  };
  for (const d of ['lib', 'app', 'blog', 'cli']) await walk(d);
  assert.deepEqual(hits.sort(), ['app/sandbox-frame.js'], 'Workers are created in exactly one file, inside the sandboxed frame');
});

test('X1: the editor and reader pages keep a CSP with no inline script and no eval', async () => {
  const csp = (html) => /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  const app = csp(await fs.readFile(path.join(root, 'index.html'), 'utf8'));
  assert.ok(/script-src 'self'(;|$)/.test(app) && !/unsafe-eval/.test(app));
  const frame = csp(await fs.readFile(path.join(root, 'app', 'sandbox-frame.html'), 'utf8'));
  for (const piece of ["default-src 'none'", "connect-src 'none'", "worker-src blob:", "frame-src 'none'", "object-src 'none'"]) assert.ok(frame.includes(piece), piece);
  assert.ok(!/unsafe-eval|unsafe-inline/.test(frame));
  assert.ok(!/https?:/.test(frame), 'the sandbox frame may load nothing from anywhere');
});

test('X1: the sandbox is created sandbox="allow-scripts" and is handed data, never a token or a URL', async () => {
  const src = await fs.readFile(path.join(root, 'app', 'sandbox.js'), 'utf8');
  assert.match(src, /SANDBOX_ATTRIBUTE = 'allow-scripts'/);
  assert.ok(!/allow-same-origin/.test(src.replace(/\/\/.*$/gm, '')), 'allow-same-origin is never set');
  const post = /postMessage\(\{([^}]*)\}/.exec(src)[1];
  assert.equal(post.replace(/\s/g, ''), "type:'run',id,source,hook,input,ctx", 'the message carries data only');
  assert.ok(!/token|localStorage|sessionStorage|Authorization/i.test(src.replace(/\/\/.*$/gm, '')), 'the sandbox host never touches credentials');
  const frame = await fs.readFile(path.join(root, 'app', 'sandbox-frame.js'), 'utf8');
  assert.ok(!/token|Authorization/i.test(frame.replace(/\/\/.*$/gm, '')));
});

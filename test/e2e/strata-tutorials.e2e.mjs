import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromePath, launch, openPage } from './cdp.mjs';
import { mdToDelta } from '../../lib/markdown.js';
import { splitFile } from '../../lib/frontmatter.js';
import { parseHtml } from '../../lib/html-tree.js';
import { decodeHtml } from '../../lib/html-entities.js';
import { fakeGitHub } from '../fake-github.js';
import { createNet } from '../../app/net.js';
import { GitHub } from '../../app/github.js';
import { planChange } from '../../app/site.js';
import { serve } from '../../cli/serve.js';
import { LYCEUM_TUTORIALS } from '../../cli/lyceum-tutorial-primitives.mjs';

const checkout = process.env.STRATA_CHECKOUT;
const skip = !checkout ? 'Set STRATA_CHECKOUT to the migrated Strata checkout' : !chromePath() ? 'Chrome is not installed' : false;
const folder = 'docs/about/tutorials';
const before = process.env.STRATA_BASE_REF || '7b4f81db1b13712a58b85cd112cb4171e8e45d5a';
const original = (name) => execFileSync('git', ['-C', checkout, 'show', `${before}:${folder}/${name}`], { encoding: 'utf8' });
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.svg': 'image/svg+xml' };
const until = async (page, expr) => {
  for (let i = 0; i < 150; i++) {
    if (await page.evaluate(`Boolean(${expr})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${expr}`);
};
const codeBlocks = (html) => {
  const found = [];
  const text = (node) => typeof node === 'string' ? decodeHtml(node) : node.children.map(text).join('');
  const visit = (node) => {
    if (typeof node === 'string') return;
    if (node.tag === 'pre') found.push(text(node).replace(/\n$/, ''));
    for (const child of node.children) visit(child);
  };
  visit(parseHtml(html));
  return found;
};

test('Lyceum tutorials round-trip through real Quill with editable code and figures', { skip, timeout: 120000 }, async () => {
  const server = await serve(path.resolve(new URL('../../', import.meta.url).pathname));
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${server.address().port}/index.html`);
    await page.evaluate(`(async () => {
      const { createEditor } = await import('/app/editor.js');
      const host = document.createElement('div');
      document.body.append(host);
      window.__tutorialEditor = await createEditor(host, { onImage:()=>{}, onVideo:()=>{}, chooseImage:()=>{} });
    })()`);
    for (const slug of LYCEUM_TUTORIALS) {
      const file = await readFile(path.join(checkout, folder, 'pages', `${slug}.md`), 'utf8');
      const body = splitFile(file).body;
      const delta = mdToDelta(body);
      const expectedCode = (body.match(/^```javascript$/gm) || []).length;
      const expectedFigures = delta.ops.filter((op) => op.insert?.htmlblock?.startsWith('<figure>\n<img ')).length;
      const actual = await page.evaluate(`(async () => {
        const { deltaToMarkdownChecked } = await import('/lib/markdown.js');
        const q = window.__tutorialEditor;
        q.setContents(${JSON.stringify(delta)}, 'api');
        const saved = deltaToMarkdownChecked(q.getContents()).md;
        const figures = [...q.root.querySelectorAll('.ql-htmlblock')].filter(n => n.querySelector('.blk-edit')?.textContent === 'Edit widget');
        return { same:saved === ${JSON.stringify(body)}, figures:figures.filter(n => n.getAttribute('data-htmlblock').startsWith('<figure>\\n<img ')).length, code:q.root.querySelectorAll('.ql-code-block').length };
      })()`);
      assert.equal(actual.same, true, `${slug}: Quill changed the source`);
      assert.equal(actual.figures, expectedFigures, `${slug}: figure widgets`);
      assert.ok(actual.code >= expectedCode, `${slug}: code blocks`);
    }
  } finally {
    await chrome.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Strata complete migration: every old URL, layout, search, source and normal editor publishing', { skip, timeout: 180000 }, async () => {
  const inventory = JSON.parse(await readFile(new URL('../../docs/strata-tutorial-inventory.json', import.meta.url), 'utf8'));
  const config = JSON.parse(await readFile(path.join(checkout, folder, 'blog.json'), 'utf8'));
  const ref = config.theme.ref;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = url.pathname;
    const baseline = file.startsWith('/__baseline__/');
    try {
      let data = baseline ? Buffer.from(original(file.split('/').at(-1))) :
        await readFile(path.join(checkout, 'docs', file === '/about/tutorials/' ? '/about/tutorials/index.html' : file));
      if (file.endsWith('.html') || file.endsWith('/')) {
        let html = data.toString();
        if (baseline) html = html.replace('<head>', '<head><base href="/about/tutorials/">');
        html = html.replaceAll(`https://cdn.jsdelivr.net/gh/tejaswigowda/strata-editor@${ref}/docs/about/tutorials/`, '/about/tutorials/');
        // Layout checks should not start ten heavy WebGL editors.
        html = html.replace(/(<iframe\b[^>]*\bsrc=")[^"]*/g, '$1about:blank');
        data = Buffer.from(html);
      }
      res.writeHead(200, { 'content-type': mime[path.extname(file)] || (file.endsWith('/') ? 'text/html' : 'application/octet-stream') });
      res.end(data);
    } catch (error) {
      res.writeHead(404);
      res.end(error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `${origin}/about/tutorials/index.html`);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await page.send('Emulation.setScriptExecutionDisabled', { value: true });
    await page.send('Page.navigate', { url: `${origin}/about/tutorials/a-plus-b-cubed.html` });
    await until(page, "location.pathname.endsWith('/a-plus-b-cubed.html') && !!document.querySelector('pre code .hljs-keyword') && !!document.querySelector('link[rel=stylesheet]')?.sheet");
    const contrast = await page.evaluate(`(() => {
      const luminance = color => {
        const values = color.match(/\\d+/g).slice(0,3).map(Number).map(v => {
          v /= 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
        return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
      };
      const pre = document.querySelector('pre code .hljs-keyword').closest('pre');
      const bg = luminance(getComputedStyle(pre).backgroundColor);
      return ['.hljs-keyword', '.hljs-string'].map(s => {
        const fg = luminance(getComputedStyle(document.querySelector('pre code ' + s)).color);
        return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
      });
    })()`);
    assert.ok(contrast.every((ratio) => ratio >= 4.5), `static code must be readable on the dark tutorial theme: ${contrast}`);
    await page.send('Emulation.setScriptExecutionDisabled', { value: false });
    await page.send('Emulation.setEmulatedMedia', { features: [] });
    const measure = `(() => {
      const main = document.querySelector('main');
      const heading = [...main.querySelectorAll('h1')].find((n) => n.getBoundingClientRect().height);
      const para = main.querySelector('.tagline');
      const style = (node) => {const s=getComputedStyle(node); const r=node.getBoundingClientRect();return {font:s.fontSize,color:s.color,width:Math.round(r.width),left:Math.round(r.left)};};
      return {main:style(main),heading:style(heading),para:para&&style(para),background:getComputedStyle(document.body).backgroundColor};
    })()`;
    for (const { url } of inventory) {
      const name = new URL(url).pathname.split('/').at(-1);
      const response = await fetch(`${origin}/about/tutorials/${name}`, { redirect: 'manual' });
      assert.equal(response.status, 200, name);
      const html = await response.text();
      assert.doesNotMatch(html, /http-equiv="refresh"/i);
      assert.deepEqual(codeBlocks(html), codeBlocks(original(name)), `${name}: code changed`);
      for (const tag of ['table', 'figure', 'details']) {
        const pattern = new RegExp(`<${tag}\\b`, 'g');
        assert.equal((html.match(pattern) || []).length, (original(name).match(pattern) || []).length, `${name}: ${tag} count`);
      }
      await page.send('Page.navigate', { url: `${origin}/__baseline__/${name}` });
      await until(page, `location.pathname === '/__baseline__/${name}' && document.readyState === 'complete' && document.querySelector('main h1')`);
      const previous = await page.evaluate(measure);
      await page.send('Page.navigate', { url: `${origin}/about/tutorials/${name}` });
      await until(page, `location.pathname === '/about/tutorials/${name}' && document.readyState === 'complete' && document.querySelector('main h1') && !!document.querySelector('link[rel=stylesheet]')?.sheet`);
      const current = await page.evaluate(measure);
      assert.deepEqual(current, previous, `${name}: layout changed`);
      const sourceName = name === 'index.html' ? 'home' : name.slice(0, -5);
      const source = await readFile(path.join(checkout, folder, 'pages', `${sourceName}.md`), 'utf8');
      const delta = mdToDelta(splitFile(source).body);
      assert.ok(delta.ops.some(({ attributes }) => attributes?.header === 1), `${name}: title is not native`);
      if (name === 'makeshort.html') {
        assert.match(html, /<video[^>]*controls preload="metadata"/);
        assert.match(html, /https:\/\/strataeditor.dev\/about\/tutorials\/demos\/pyth.mp4/);
      }
      const frames = original(name).match(/<iframe\b/g) || [];
      assert.equal((html.match(/sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"/g) || []).length, frames.length, name);
      if (frames.length) assert.ok(await page.evaluate(`(() => {
        const embed = document.querySelector('.wc-embed');
        const frame = embed.querySelector('iframe').getBoundingClientRect();
        const link = embed.querySelector('a').getBoundingClientRect();
        return Math.abs(frame.right-link.right) < 1;
      })()`), `${name}: embed fallback is not right-aligned`);
    }
    await page.send('Page.navigate', { url: `${origin}/about/tutorials/index.html` });
    await until(page, "document.querySelector('input[type=search]')");
    assert.equal(await page.evaluate("document.querySelectorAll('#list .card').length"), 27);
    await page.evaluate("(() => {const box=document.querySelector('input[type=search]');box.value='GIS-grounded';box.dispatchEvent(new Event('input'));})()");
    assert.equal(await page.evaluate("document.querySelectorAll('#list .card:not([hidden])').length"), 1);
    assert.match(await page.evaluate("document.querySelector('#list .card:not([hidden])').textContent"), /GIS-grounded/);
    const point = await page.evaluate(`(() => {
      const card = document.querySelector('#list .card:not([hidden])');
      const link = card.querySelector('h3 a:not(.anchor)');
      link.href = ${JSON.stringify(origin)} + new URL(link.href).pathname;
      card.scrollIntoView({block:'start',behavior:'instant'});
      const rect = card.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + 20;
      return {x, y, href:document.elementFromPoint(x,y)?.closest('a')?.href};
    })()`);
    assert.equal(point.href, `${origin}/about/tutorials/gis-walkway-shade.html`, 'The card thumbnail must open the tutorial, not its heading anchor');
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await until(page, "location.pathname === '/about/tutorials/gis-walkway-shade.html' && !!document.querySelector('h1')");

    const files = {};
    for (const { url } of inventory) {
      const name = new URL(url).pathname.split('/').at(-1);
      const slug = name === 'index.html' ? 'home' : name.slice(0, -5);
      for (const file of [name, `pages/${slug}.md`]) files[`${folder}/${file}`] = await readFile(path.join(checkout, folder, file), 'utf8');
    }
    for (const file of ['blog.json', 'assets.lock.json', 'index/posts.json', 'theme/theme.json', 'theme/tutorials.css', 'theme/skeleton.html']) files[`${folder}/${file}`] = await readFile(path.join(checkout, folder, file), 'utf8');
    files['docs/index.html'] = 'Strata editor: do not touch';
    const fake = fakeGitHub({ 'tejaswigowda/strata-editor': files }, { aliases: { 'tejaswigowda/strata-editor': { [ref]: 'main' } } });
    await fake.ready;
    const gh = new GitHub(createNet(fake.fetch), { token: 'github_pat_test' });
    const target = `${folder}/pages/animate-a-character.md`;
    const text = files[target];
    const plan = await planChange(gh, { repo: config.repo, branch: 'main', slug: 'animate-a-character', text, kind: 'page' });
    assert.ok(plan.changes.every((change) => change.path.startsWith(`${folder}/`)));
    assert.ok(!plan.changes.some((change) => change.path === 'docs/index.html'));
    assert.ok(!plan.changes.some((change) => change.path.endsWith('/animate-a-character/index.html')));
    const edited = await planChange(gh, { repo: config.repo, branch: 'main', slug: 'animate-a-character', text: text.replace('# Animate a finished character', '# Animate an editable character'), kind: 'page' });
    assert.ok(edited.changes.some((change) => change.path === `${folder}/animate-a-character.html` && change.content.includes('Animate an editable character')));
  } finally {
    chrome.close();
    server.close();
  }
});

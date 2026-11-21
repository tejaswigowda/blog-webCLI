// End to end, in real Chrome, against an in-memory GitHub: tables and raw HTML blocks in the editor. They are inserted from the
// toolbar, edited in a dialog, drawn without ever becoming markup in the editor (which holds the token), refused when they
// could run anything, and saved as markdown the generator reads back.
// Run with: npm run test:e2e   (skips itself when Chrome is not installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../../cli/serve.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skip = chromePath() ? false : 'Chrome is not installed (set CHROME=/path/to/chrome)';
const BLOG = JSON.stringify({ title: 'T', description: 'd', author: 'A', domain: 'https://example.github.io/blog', repo: 'example/blog', theme: 'default' });

async function site({ blog = BLOG, files = {} } = {}) {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-blocks-'));
  for (const d of ['app', 'lib', 'blog', 'vendor']) await cp(path.join(root, d), path.join(copy, d), { recursive: true });
  await cp(path.join(root, 'index.html'), path.join(copy, 'index.html'));
  await mkdir(path.join(copy, 'test'));
  await cp(path.join(root, 'test', 'fake-github.js'), path.join(copy, 'test', 'fake-github.js'));
  const contents = { 'blog.json': blog, ...files };
  await writeFile(path.join(copy, 'data.js'), `export const data = ${JSON.stringify({ 'example/blog': Object.fromEntries(Object.entries(contents).map(([name, text]) => [name, Buffer.from(text).toString('base64')])) })};\n`);
  return copy;
}

test('declared counters insert in Quill and preview resolved numbers', { skip, timeout: 90000 }, async () => {
  const blog = JSON.stringify({ ...JSON.parse(BLOG), schemaVersion: 2, minGeneratorVersion: '0.5.1' });
  const body = '## First\n\nSecond\n';
  const source = `---\nslug: demo\ntitle: Demo\nstatus: draft\n---\n\n${body}`;
  const web = await serve(await site({ blog, files: { 'pages/demo.md': source } }));
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
    await until(page, "document.querySelector('#top button')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);
    await clickText(page, '#top button', 'Sign in');
    await fill(page, 'dialog input[name=token]', `github_pat_${'b'.repeat(30)}`);
    await clickText(page, 'dialog button', 'Sign in');
    await until(page, "(document.querySelector('#top .signed') || {}).title === 'Signed in as tester'");
    await page.evaluate("location.hash = '#repo=example/blog&editpage=demo'; 0");
    try {
      await until(page, "document.querySelector('.ql-editor') && document.querySelector('.ql-counter')");
      await fill(page, 'textarea[aria-label=Counters]', 'step: { start: 5, style: decimal }');
    } catch (error) {
      throw new Error(`${error.message}: ${await page.evaluate("document.querySelector('#view').innerText.slice(0,1000)")} ${JSON.stringify(await page.evaluate('window.__alerts'))}`);
    }
    const original = await page.evaluate(`(async () => {
      const { deltaToMarkdownChecked } = await import('/lib/markdown.js');
      window.__q = Quill.find(document.querySelector('.ql-container'));
      return deltaToMarkdownChecked(__q.getContents(), { counters: true }).md;
    })()`);
    assert.equal(original, body);
    await page.evaluate("__q.setSelection(__q.getLength() - 1, 0); document.querySelector('button.ql-counter').click()");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    assert.equal(await page.evaluate("document.querySelector('dialog select[aria-label=Counter]').value"), 'step');
    await clickText(page, 'dialog.blk-dialog button', 'Insert');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('details.more span.wc-count-step')].map(e => e.textContent)"), ['5']);
    await page.evaluate("__q.setSelection(__q.getLength() - 1, 0); document.querySelector('button.ql-counter').click()");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    await clickText(page, 'dialog.blk-dialog button', 'Insert');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('details.more span.wc-count-step')].map(e => e.textContent)"), ['5', '6']);
    await clickText(page, '#view button', 'Save draft');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    await clickText(page, 'dialog button', 'Commit and push');
    await until(page, "document.querySelector('.toast.success')", 30000);
    assert.equal(await page.evaluate("__q.getContents().ops.filter(op => op.insert?.counter).length"), 2);
    const saved = (await page.evaluate("window.__fake.files('example/blog')"))['pages/demo.md'];
    assert.match(saved, /counters:\n  step: \{ start: 5, style: decimal \}/);
    assert.equal((saved.match(/<span class="wc-count-step"><\/span>/g) || []).length, 2);
    assert.deepEqual(await page.evaluate('window.__alerts'), []);
  } finally {
    await chrome.close();
    await new Promise((resolve) => web.close(resolve));
  }
});
const INSTALL = `
  const m = await import('/test/fake-github.js');
  const { data } = await import('/data.js');
  const dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const repos = Object.fromEntries(Object.entries(data).map(([r, f]) => [r, Object.fromEntries(Object.entries(f).map(([p, b]) => [p, dec(b)]))]));
  const fake = m.fakeGitHub(repos);
  await fake.ready;
  window.__fake = fake;
  const real = window.fetch.bind(window);
  window.fetch = (u, o) => (new URL(u, location.href).origin === location.origin ? real(u, o) : fake.fetch(u, o));
  window.__alerts = [];
  window.addEventListener('unhandledrejection', (e) => window.__alerts.push('rejection: ' + (e.reason && e.reason.stack || e.reason)));
  window.addEventListener('error', (e) => window.__alerts.push('error: ' + e.message));
  window.alert = (m) => window.__alerts.push(String(m));
`;
const until = async (page, expr, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(`Boolean(${expr})`)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const clickText = (page, selector, text) => page.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(text)}); el.click(); })()`);
const fill = (page, selector, value) => page.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);

test('a captioned figure opens as an editable widget without losing rich figures', { skip, timeout: 90000 }, async () => {
  const web = await serve(await site());
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
    const result = await page.evaluate(`(async () => {
      const { readWidget } = await import('/app/widgets.js');
      const { widgetHtml } = await import('/lib/widget-markup.js');
      const original = widgetHtml({ type:'figure-caption', image:'https://example.com/a.png', alt:'Example', caption:'First caption' });
      return { widget:readWidget(original), rich:readWidget(original.replace('First caption','<em>First</em> caption')) };
    })()`);
    assert.equal(result.widget.type, 'figure-caption');
    assert.equal(result.widget.caption, 'First caption');
    assert.equal(result.rich, null);
    await until(page, "document.querySelector('#top button')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);
    await clickText(page, '#top button', 'Sign in');
    await fill(page, 'dialog input[name=token]', `github_pat_${'b'.repeat(30)}`);
    await clickText(page, 'dialog button', 'Sign in');
    await until(page, "(document.querySelector('#top .signed') || {}).title === 'Signed in as tester'");
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    await page.evaluate(`(async () => {
      const { widgetHtml } = await import('/lib/widget-markup.js');
      const q = Quill.find(document.querySelector('.ql-container'));
      q.setContents({ops:[{insert:{htmlblock:widgetHtml({type:'figure-caption',image:'https://example.com/a.png',alt:'Example',caption:'First caption'})}},{insert:'\\n'}]});
      document.querySelector('.ql-editor .blk-edit').click();
    })()`);
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    assert.equal(await page.evaluate("document.querySelector('dialog select[aria-label=\"Widget type\"]').value"), 'figure-caption');
    await fill(page, 'dialog input[aria-label="Figure caption"]', 'New caption');
    await clickText(page, 'dialog.blk-dialog button', 'Apply');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    assert.match(await page.evaluate("document.querySelector('.ql-editor .ql-htmlblock').getAttribute('data-htmlblock')"), /New caption/);
    assert.deepEqual(await page.evaluate('window.__alerts'), []);
  } finally {
    await chrome.close();
    await new Promise((resolve) => web.close(resolve));
  }
});

test('code widget inserts and edits fenced code without executing it', { skip, timeout: 90000 }, async () => {
  const web = await serve(await site());
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
    await until(page, "document.querySelector('#top button')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);
    await clickText(page, '#top button', 'Sign in');
    await fill(page, 'dialog input[name=token]', `github_pat_${'b'.repeat(30)}`);
    await clickText(page, 'dialog button', 'Sign in');
    await until(page, "(document.querySelector('#top .signed') || {}).title === 'Signed in as tester'");
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    await page.evaluate("window.__q = Quill.find(document.querySelector('.ql-container')); __q.setText('Keep this paragraph.\\nAfter.\\n'); __q.getModule('history').clear(); __q.setSelection(5, 0); document.querySelector('button.ql-codewidget').click()");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    await page.evaluate(`(() => { const s = document.querySelector('dialog select[aria-label="Code language"]'); s.value = 'javascript'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    const code = 'const x = "<img onerror=alert(1)>";\n\n  x++;\n';
    await fill(page, 'dialog textarea[aria-label=Code]', code);
    assert.equal(await page.evaluate("document.querySelector('dialog .hl-pre').textContent"), code + '\n');
    assert.ok(await page.evaluate("document.querySelector('dialog .hl-pre .hljs-keyword')"));
    assert.equal(await page.evaluate("document.querySelectorAll('dialog .hl-pre img, dialog .hl-pre script').length"), 0);
    await clickText(page, 'dialog button', 'Apply');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    assert.ok((await page.evaluate('__q.getText()')).includes('Keep this paragraph.\nAfter.\n'));
    await page.evaluate("__q.getModule('history').undo()");
    assert.equal(await page.evaluate('__q.getText()'), 'Keep this paragraph.\nAfter.\n');
    await page.evaluate("__q.getModule('history').redo(); __q.setSelection(0, 0)");
    await page.evaluate("document.querySelector('button.ql-codewidget').click()");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    assert.equal(await page.evaluate("document.querySelector('dialog textarea[aria-label=Code]').value"), code);
    assert.equal(await page.evaluate("document.querySelector('dialog select[aria-label=\"Code language\"]').value"), 'javascript');
    await fill(page, 'dialog textarea[aria-label=Code]', '```\nnot representable');
    assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog button.primary').disabled"), true, await page.evaluate("document.querySelector('dialog.blk-dialog .blk-msg').textContent"));
    await fill(page, 'dialog textarea[aria-label=Code]', code);
    await page.evaluate(`(() => { const s = document.querySelector('dialog select[aria-label="Code language"]'); s.value = ''; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    assert.equal(await page.evaluate("document.querySelectorAll('dialog .hl-pre .hljs-keyword').length"), 0);
    await clickText(page, 'dialog button', 'Apply');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    await page.evaluate("document.querySelector('button.ql-codewidget').click()");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    assert.equal(await page.evaluate("document.querySelector('dialog select[aria-label=\"Code language\"]').value"), '', await page.evaluate("document.querySelector('dialog input[aria-label=\"Custom code language\"]').value"));
    assert.equal(await page.evaluate("document.querySelector('dialog textarea[aria-label=Code]').value"), code);
    await page.evaluate(`(() => { const s = document.querySelector('dialog select[aria-label="Code language"]'); s.value = '__custom__'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await fill(page, 'dialog input[aria-label="Custom code language"]', 'plain');
    assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog button.primary').disabled"), true, await page.evaluate("document.querySelector('dialog.blk-dialog .blk-msg').textContent"));
    await fill(page, 'dialog input[aria-label="Custom code language"]', 'my-language');
    assert.match(await page.evaluate("document.querySelector('dialog .hint').textContent"), /without highlighting/);
    await clickText(page, 'dialog button', 'Apply');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    await fill(page, '#view input[placeholder=Title]', 'Code post');
    await fill(page, '#view input[placeholder^="set once"]', 'code-post');
    await clickText(page, '#view button', 'Save draft');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    await clickText(page, 'dialog button', 'Commit and push');
    await until(page, "document.querySelector('.toast.success')", 30000);
    const saved = (await page.evaluate("window.__fake.files('example/blog')"))['posts/code-post.md'];
    assert.ok(saved.includes('```my-language\n' + code + '\n```'), saved);
    assert.ok(saved.includes('Keep this paragraph.\n\nAfter.'), saved);
    await page.evaluate("location.hash = '#repo=example/blog&edit=code-post'; 0");
    await until(page, "document.querySelector('.ql-editor .ql-code-block')");
    await page.evaluate("document.querySelector('.ql-editor .ql-code-block').click(); document.querySelector('button.ql-codewidget').click()");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    assert.equal(await page.evaluate("document.querySelector('dialog input[aria-label=\"Custom code language\"]').value"), 'my-language');
    assert.equal(await page.evaluate("document.querySelector('dialog textarea[aria-label=Code]').value"), code);
    await fill(page, 'dialog textarea[aria-label=Code]', 'discarded');
    await clickText(page, 'dialog.blk-dialog button', 'Cancel');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    await page.evaluate("document.querySelector('button.ql-codewidget').click()");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    assert.equal(await page.evaluate("document.querySelector('dialog textarea[aria-label=Code]').value"), code);
    await clickText(page, 'dialog.blk-dialog button', 'Cancel');
    assert.deepEqual(await page.evaluate('window.__alerts'), []);
  } finally {
    await chrome.close();
    await new Promise((resolve) => web.close(resolve));
  }
});

test('tables and HTML blocks: inserted, edited, drawn as data, refused when unsafe, saved as readable markdown', { skip, timeout: 180000 }, async () => {
  const web = await serve(await site());
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
    await until(page, "document.querySelector('#top button')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);
    await clickText(page, '#top button', 'Sign in');
    await fill(page, 'dialog input[name=token]', `github_pat_${'b'.repeat(30)}`);
    await clickText(page, 'dialog button', 'Sign in');
    await until(page, "(document.querySelector('#top .signed') || {}).title === 'Signed in as tester'");
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    assert.equal(await page.evaluate("document.querySelector('.ql-mdtable').title + ' / ' + document.querySelector('.ql-htmlblock').title"), 'Insert a table / Insert an HTML block');

    // a table: the dialog starts with a 2 x 2 grid
    await page.evaluate("document.querySelector('.ql-editor').focus(); document.execCommand('insertText', false, 'Before.'); document.querySelector('button.ql-mdtable').click(); 0");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    assert.equal(await page.evaluate("document.querySelectorAll('dialog.blk-dialog input[data-r]').length"), 6);
    await fill(page, 'dialog input[data-r="-1"][data-c="0"]', 'Name');
    await fill(page, 'dialog input[data-r="-1"][data-c="1"]', 'Price');
    await fill(page, 'dialog input[data-r="0"][data-c="0"]', '**Apple** | pie');
    await fill(page, 'dialog input[data-r="0"][data-c="1"]', '3');
    await page.evaluate("(() => { const s = document.querySelector('dialog select[data-c=\"1\"]'); s.value = 'right'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await clickText(page, 'dialog button', '+ Row');
    await fill(page, 'dialog input[data-r="2"][data-c="0"]', '<script>alert(1)</script>');
    await clickText(page, 'dialog button', 'Apply');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    // drawn as a table made of text, not markup
    assert.equal(await page.evaluate("document.querySelectorAll('.ql-editor .ql-mdtable table th').length"), 2);
    assert.equal(await page.evaluate("document.querySelector('.ql-editor .ql-mdtable tbody td strong').textContent"), 'Apple');
    assert.equal(await page.evaluate("document.querySelectorAll('.ql-editor script').length"), 0, 'a cell is text');
    assert.match(await page.evaluate("document.querySelector('.ql-editor .ql-mdtable').innerText"), /<script>alert\(1\)<\/script>/);

    // an HTML block that could run anything cannot be applied, and says why
    await page.evaluate("document.querySelector('.ql-editor').focus(); document.querySelector('button.ql-htmlblock').click(); 0");
    await until(page, "document.querySelector('dialog.blk-dialog[open] textarea')");
    for (const [src, why] of [['<img src=x onerror=alert(1)>', /onerror/], ['<script>alert(1)</script>', /script/], ['<a href="javascript:alert(1)">x</a>', /scheme/], ['<div><p>x</p>', /never closed/]]) {
      await fill(page, 'dialog textarea', src);
      assert.equal(await page.evaluate("[...document.querySelectorAll('dialog.blk-dialog button')].find((b) => b.textContent === 'Apply').disabled"), true, src);
      assert.match(await page.evaluate("document.querySelector('dialog.blk-dialog .blk-msg').textContent"), why, src);
    }
    await fill(page, 'dialog textarea', '<div class="note">\n\n  <p>Hello <b>there</b></p>\n\n</div>\n');
    assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog .blk-msg').textContent"), '');
    await clickText(page, 'dialog button', 'Apply');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    assert.equal(await page.evaluate("document.querySelector('.ql-editor .ql-htmlblock pre').textContent"), '<div class="note">\n  <p>Hello <b>there</b></p>\n</div>', 'blank lines removed, shown as source');
    assert.equal(await page.evaluate("document.querySelectorAll('.ql-editor .ql-htmlblock b, .ql-editor .ql-htmlblock p').length"), 0, 'an HTML block is shown as its source, never as markup');
    assert.ok(await page.evaluate("document.querySelectorAll('.ql-htmlblock pre .tk-se').length > 0"), 'HTML tags are highlighted within Quill');
    assert.ok(await page.evaluate("document.querySelectorAll('.ql-htmlblock pre .tk-pr').length > 0"), 'HTML attribute names are highlighted within Quill');
    assert.ok(await page.evaluate("document.querySelectorAll('.ql-htmlblock pre .tk-st').length > 0"), 'HTML values are highlighted within Quill');
    assert.equal(await page.evaluate("new Set(['.tk-se','.tk-pr','.tk-st'].map(s => getComputedStyle(document.querySelector('.ql-htmlblock pre ' + s)).color)).size"), 3, 'tags, attribute names and values have visibly distinct colours');
    await page.evaluate("document.querySelector('.ql-editor .ql-htmlblock .blk-edit').click()");
    await until(page, "document.querySelector('dialog.blk-dialog[open] .hl-wrap')");
    assert.equal(await page.evaluate("document.querySelector('dialog .hl-pre').textContent"), await page.evaluate("document.querySelector('dialog textarea').value + '\\n'"), 'highlighted HTML editing uses the exact textarea value');
    const scroll = await page.evaluate(`(() => {
      const area = document.querySelector('dialog textarea');
      area.value = '<div>\\n' + Array.from({length:40}, (_,i) => '<p title="' + 'x'.repeat(180) + '">Row ' + i + '</p>').join('\\n') + '\\n</div>';
      area.dispatchEvent(new Event('input',{bubbles:true}));
      area.scrollTop = 100; area.scrollLeft = 80;
      area.dispatchEvent(new Event('scroll'));
      area.value += ' ';
      area.dispatchEvent(new Event('input',{bubbles:true}));
      const pre = document.querySelector('dialog .hl-pre');
      return {top:area.scrollTop,left:area.scrollLeft,mirrorTop:pre.scrollTop,mirrorLeft:pre.scrollLeft,inert:!pre.querySelector('div,p,script,img'),font:getComputedStyle(area).font,mirrorFont:getComputedStyle(pre).font};
    })()`);
    assert.ok(scroll.top > 0 && scroll.left > 0, 'long HTML source scrolls on both axes');
    assert.equal(scroll.top, scroll.mirrorTop, 'vertical highlighting stays aligned after typing');
    assert.equal(scroll.left, scroll.mirrorLeft, 'horizontal highlighting stays aligned after typing');
    assert.equal(scroll.font, scroll.mirrorFont, 'textarea and highlighted mirror share font metrics');
    assert.equal(scroll.inert, true, 'highlighted source never becomes authored elements');
    await clickText(page, 'dialog.blk-dialog button', 'Cancel');
    await until(page, "!document.querySelector('dialog.blk-dialog')");

    // edit the table again from its button
    await page.evaluate("document.querySelector('.ql-editor .ql-mdtable .blk-edit').click(); 0");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    assert.equal(await page.evaluate("document.querySelector('dialog input[data-r=\"0\"][data-c=\"0\"]').value"), '**Apple** | pie');
    await fill(page, 'dialog input[data-r="2"][data-c="0"]', 'plain');
    await clickText(page, 'dialog button', 'Apply');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    assert.equal(await page.evaluate("document.querySelectorAll('.ql-editor .ql-mdtable').length"), 1, 'edited in place, not duplicated');

    // save: readable markdown, no Delta
    await fill(page, '#view input[placeholder=Title]', 'With blocks');
    await fill(page, '#view input[placeholder^="set once"]', 'with-blocks');
    await clickText(page, '#view button', 'Save draft');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    await clickText(page, 'dialog button', 'Commit and push');
    await until(page, "!document.querySelector('dialog[open]')", 30000);
    await until(page, "document.querySelector('.toast.success')");
    const saved = (await page.evaluate("window.__fake.files('example/blog')"))['posts/with-blocks.md'];
    // (the second block went in where the cursor was, which is before the first)
    assert.match(saved, /\n\nBefore\.\n\n<div class="note">\n  <p>Hello <b>there<\/b><\/p>\n<\/div>\n\n\| Name \| Price \|\n\| --- \| ---: \|\n\| \*\*Apple\*\* \\\| pie \| 3 \|\n\|  \|  \|\n\| plain \|  \|\n$/);
    assert.doesNotMatch(saved, /mdtable|htmlblock|"ops"/);
    assert.deepEqual(await page.evaluate('window.__alerts'), []);

    // and it reads back: reopening the post draws the same blocks
    await page.evaluate("location.hash = '#repo=example/blog&edit=with-blocks'; 0");
    await until(page, "document.querySelector('.ql-editor .ql-mdtable') && document.querySelector('.ql-editor .ql-htmlblock')");
    assert.equal(await page.evaluate("document.querySelectorAll('.ql-editor .ql-mdtable tbody tr').length"), 3);

    await page.evaluate("document.querySelector('.ql-editor').focus(); document.querySelector('button.ql-slideshow').click(); 0");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    assert.equal(await page.evaluate("document.querySelectorAll('dialog .blk-slide').length"), 2, 'one accordion per slide');
    assert.equal(await page.evaluate("document.querySelectorAll('dialog .blk-slide[open]').length"), 1, 'only the first slide starts expanded');
    for (const width of [1280, 390]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 650, deviceScaleFactor: 1, mobile: false });
      const layout = await page.evaluate(`(() => {
        const dlg = document.querySelector('dialog.blk-dialog');
        dlg.scrollTop = 0;
        const box = n => {const r = n.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};};
        const pairs = ['image','heading','caption','link label'].map(field => ({
          input:box(dlg.querySelector('input[aria-label="Slide 1 ' + field + '"]')),
          animation:box(dlg.querySelector('select[aria-label="Slide 1 ' + field + ' animation"]')),
        }));
        const actions = [...dlg.querySelectorAll('.blk-dialog-header button')];
        const before = actions.map(box);
        dlg.scrollTop = dlg.scrollHeight;
        return {pairs,before,after:actions.map(box),dialog:box(dlg),scrolled:dlg.scrollTop,overflow:dlg.scrollWidth > dlg.clientWidth + 1};
      })()`);
      for (const pair of layout.pairs) {
        assert.ok(Math.abs(pair.input.top - pair.animation.top) <= 1, `${width}: input and animation share a row`);
        assert.ok(pair.animation.left >= pair.input.right, `${width}: animation is beside its input`);
      }
      assert.equal(layout.overflow, false, `${width}: no horizontal overflow`);
      assert.ok(layout.scrolled > 0, `${width}: long dialog actually scrolls`);
      for (const [i, button] of layout.after.entries()) {
        assert.ok(Math.abs(button.top - layout.before[i].top) <= 1, `${width}: actions stay sticky while scrolling`);
        assert.ok(button.top >= layout.dialog.top && button.bottom < layout.dialog.bottom, `${width}: actions remain visible`);
      }
      assert.ok((layout.after[0].left + layout.after[1].right) / 2 > (layout.dialog.left + layout.dialog.right) / 2, `${width}: action group is right-aligned`);
      assert.ok(layout.after[0].top < layout.dialog.top + 32, `${width}: Apply stays at the top`);
      assert.ok(layout.after[1].right > layout.dialog.right - 40, `${width}: Cancel is at the right edge`);
    }
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.evaluate("document.querySelector('dialog.blk-dialog').scrollTop = 0");
    await page.evaluate("document.querySelectorAll('dialog .blk-slide summary')[1].click()");
    await until(page, "document.querySelectorAll('dialog .blk-slide')[1].open && !document.querySelectorAll('dialog .blk-slide')[0].open");
    await page.evaluate("document.querySelector('dialog .blk-slide summary').click()");
    await until(page, "document.querySelector('dialog .blk-slide').open");
    assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog button.primary').disabled"), true);
    assert.equal(await page.evaluate("document.querySelector('select[aria-label=\"Slide 1 animation\"]').value"), 'fadeIn');
    for (const i of [1, 2]) {
      await fill(page, `dialog input[aria-label="Slide ${i} image"]`, `https://example.com/${i}.jpg`);
      await fill(page, `dialog input[aria-label="Slide ${i} alternative text"]`, `Boat ${i}`);
      await fill(page, `dialog input[aria-label="Slide ${i} heading"]`, `Platform ${i}`);
    }
    assert.equal(await page.evaluate("document.querySelector('dialog .blk-slide summary').textContent"), 'Slide 1: Platform 1', 'slide summaries update while typing');
    await fill(page, 'dialog input[aria-label="Slide 1 caption"]', '<script>not executable</script>');
    await fill(page, 'dialog input[aria-label="Slide 1 link label"]', 'Products');
    assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog button.primary').disabled"), true, 'a label requires its address');
    await fill(page, 'dialog input[aria-label="Slide 1 link address"]', './products/');
    await page.evaluate("for (const [i, value] of [[1, 'fadeInUp'], [2, 'none']]) { const select = document.querySelector('select[aria-label=\"Slide ' + i + ' animation\"]'); select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }");
    await page.evaluate("for (const [field, value] of [['image', 'zoomIn'], ['heading', 'fadeInDown'], ['caption', 'fadeInLeft'], ['link label', 'bounceIn']]) { const select = document.querySelector('select[aria-label=\"Slide 1 ' + field + ' animation\"]'); select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }");
    await clickText(page, 'dialog button', '+ Slide');
    assert.equal(await page.evaluate("document.querySelector('dialog .blk-slide[open] summary').textContent"), 'Slide 3', 'new slides open automatically');
    assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog button.primary').disabled"), true);
    await page.evaluate("document.querySelector('button[aria-label=\"Remove slide 3\"]').click(); document.querySelector('button[aria-label=\"Move slide 2 up\"]').click(); 0");
    assert.equal(await page.evaluate("document.querySelector('input[aria-label=\"Slide 1 heading\"]').value"), 'Platform 2');
    assert.equal(await page.evaluate("document.querySelector('dialog .blk-slide[open] summary').textContent"), 'Slide 1: Platform 2', 'moved slides stay expanded with their content');
    await clickText(page, 'dialog button', 'Apply');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    await clickText(page, '.ql-editor button.blk-edit', 'Edit slideshow');
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    assert.equal(await page.evaluate("document.querySelector('input[aria-label=\"Slide 2 heading\"]').value"), 'Platform 1');
    assert.equal(await page.evaluate("document.querySelector('select[aria-label=\"Slide 1 animation\"]').value"), 'none');
    assert.equal(await page.evaluate("document.querySelector('select[aria-label=\"Slide 2 animation\"]').value"), 'fadeInUp');
    for (const [field, value] of [['image', 'zoomIn'], ['heading', 'fadeInDown'], ['caption', 'fadeInLeft'], ['link label', 'bounceIn']]) {
      assert.equal(await page.evaluate(`document.querySelector('select[aria-label="Slide 2 ${field} animation"]').value`), value, 'element choices survive reordering and reopening');
    }
    assert.equal(await page.evaluate("document.querySelector('input[aria-label=\"Slide 2 link address\"]').value"), './products/');
    await clickText(page, 'dialog button', 'Apply');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    await clickText(page, '#view button', 'Save draft');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    await clickText(page, 'dialog button', 'Commit and push');
    await until(page, "!document.querySelector('dialog[open]')", 30000);
    await until(page, "(window.__fake.files('example/blog')['posts/with-blocks.md'] || '').includes('webcli-slideshow')", 30000);
    const withSlides = (await page.evaluate("window.__fake.files('example/blog')"))['posts/with-blocks.md'];
    assert.match(withSlides, /<section class="webcli-slideshow"/);
    assert.match(withSlides, /&lt;script&gt;not executable&lt;\/script&gt;/);
    assert.match(withSlides, /webcli-animate-none/);
    assert.match(withSlides, /webcli-animate-fadeInUp/);
    assert.match(withSlides, /<a class="webcli-animate-bounceIn" href="\.\/products\/">Products<\/a>/);
    assert.ok(withSlides.indexOf('<h2>Platform 2</h2>') < withSlides.indexOf('<h2 class="webcli-animate-fadeInDown">Platform 1</h2>'));
    assert.equal(await page.evaluate("document.querySelectorAll('.ql-editor script').length"), 0);
    assert.deepEqual(await page.evaluate('window.__alerts'), []);
  } finally {
    chrome.close();
    web.close();
  }
});

test('CSS class groups: whole-block selection, cancellation, undo and saved HTML source', { skip, timeout: 90000 }, async () => {
  const web = await serve(await site());
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
    await until(page, "document.querySelector('#top button')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);
    await clickText(page, '#top button', 'Sign in');
    await fill(page, 'dialog input[name=token]', `github_pat_${'b'.repeat(30)}`);
    await clickText(page, 'dialog button', 'Sign in');
    await until(page, "(document.querySelector('#top .signed') || {}).title === 'Signed in as tester'");
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    await page.evaluate(`(() => {
      window.__q = Quill.find(document.querySelector('.ql-container'));
      __q.setContents({ ops: [
        { insert: 'Before.\\nStep 1' }, { insert: '\\n', attributes: { header: 3 } },
        { insert: 'Get ' }, { insert: 'a quote', attributes: { bold: true, link: './contact/' } },
        { insert: '.\\nAfter.\\n' }
      ] });
      __q.getModule('history').clear();
      window.__original = __q.getContents();
      __q.setSelection(10, 9);
      document.querySelector('button.ql-cssclasses').click();
    })()`);
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    for (const value of ['.order-step', 'bad" onclick="x']) {
      await fill(page, 'dialog input[aria-label="CSS classes"]', value);
      assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog button.primary').disabled"), true);
      assert.match(await page.evaluate("document.querySelector('dialog .blk-msg').textContent"), /class names/);
    }
    await fill(page, 'dialog input[aria-label="CSS classes"]', 'order-step featured');
    await clickText(page, 'dialog.blk-dialog button', 'Cancel');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    assert.deepEqual(await page.evaluate('__q.getContents()'), await page.evaluate('__original'));

    await page.evaluate("document.querySelector('button.ql-cssclasses').click(); 0");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    await fill(page, 'dialog input[aria-label="CSS classes"]', 'order-step featured');
    await clickText(page, 'dialog button', 'Apply');
    await until(page, "document.querySelector('.ql-editor .ql-htmlblock')");
    const src = '<div class="order-step featured">\n<h3>Step 1</h3>\n<p>Get <a href="./contact/"><strong>a quote</strong></a>.</p>\n</div>';
    assert.equal(await page.evaluate("document.querySelector('.ql-htmlblock pre').textContent"), src, 'partial selection expands to both complete blocks');
    assert.equal(await page.evaluate("document.querySelectorAll('.ql-editor .order-step').length"), 0, 'group is source, never executed markup');
    assert.equal(await page.evaluate('__q.getText()'), 'Before.\nAfter.\n', 'surrounding blocks are untouched');
    await page.evaluate("__q.getModule('history').undo()");
    assert.deepEqual(await page.evaluate('__q.getContents()'), await page.evaluate('__original'), 'one undo restores rich text and formatting');
    await page.evaluate("__q.getModule('history').redo()");

    assert.equal(await page.evaluate("document.querySelector('.blk-classes input').value"), 'order-step featured');
    for (const [value, why] of [['bad" onclick="x', /class names/], ['wc-colums', /wc-columns/], ['wc-columns', /wc-col/]]) {
      await fill(page, '.blk-classes input', value);
      await clickText(page, '.blk-classes button', 'Apply classes');
      assert.match(await page.evaluate("document.querySelector('.blk-class-error').textContent"), why);
      assert.equal(await page.evaluate("document.querySelector('.ql-editor .ql-htmlblock').getAttribute('data-htmlblock')"), src, 'invalid class edit does not touch the document');
    }
    await fill(page, '.blk-classes input', 'order-step featured boxed');
    await page.evaluate(`(() => {
      window.__classTyping = 0;
      __q.root.addEventListener('keydown', () => { window.__classTyping++; });
      const input = document.querySelector('.blk-classes input');
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    })()`);
    assert.equal(await page.evaluate('__classTyping'), 0, 'class field keystrokes do not reach Quill keyboard shortcuts');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const styled = src.replace('order-step featured', 'order-step featured boxed');
    await until(page, `document.querySelector('.ql-editor .ql-htmlblock').getAttribute('data-htmlblock') === ${JSON.stringify(styled)}`);
    assert.equal(await page.evaluate("document.querySelector('.ql-editor .ql-htmlblock pre').textContent"), styled);
    assert.equal(await page.evaluate('__q.getText()'), 'Before.\nAfter.\n');
    await page.evaluate("__q.getModule('history').undo()");
    assert.equal(await page.evaluate("document.querySelector('.ql-editor .ql-htmlblock').getAttribute('data-htmlblock')"), src, 'one undo restores the old classes and source');

    // At a selection ending exactly at the next block's start, that next block must stay outside.
    await page.evaluate("__q.getModule('history').undo()");
    assert.deepEqual(await page.evaluate('__q.getContents()'), await page.evaluate('__original'));
    await page.evaluate("__q.setSelection(8, __q.getText().indexOf('After.') - 8); document.querySelector('button.ql-cssclasses').click(); 0");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    await fill(page, 'dialog input[aria-label="CSS classes"]', 'order-step featured');
    assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog .blk-msg').textContent"), '');
    await clickText(page, 'dialog button', 'Apply');
    await until(page, "!document.querySelector('dialog.blk-dialog')");
    assert.equal(await page.evaluate("document.querySelector('.ql-htmlblock pre').textContent"), src);

    // A caret (no selection) groups just its current paragraph.
    await page.evaluate("__q.setSelection(0, 0); 0");
    assert.deepEqual(await page.evaluate('__q.getSelection()'), { index: 0, length: 0 });
    await page.evaluate("document.querySelector('button.ql-cssclasses').click(); 0");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    await fill(page, 'dialog input[aria-label="CSS classes"]', 'intro');
    await clickText(page, 'dialog button', 'Apply');
    assert.equal(await page.evaluate("document.querySelector('.ql-htmlblock pre').textContent"), '<div class="intro">\n<p>Before.</p>\n</div>');
    await page.evaluate("__q.getModule('history').undo()");

    await fill(page, '.blk-classes input', '');
    await clickText(page, '.blk-classes button', 'Apply classes');
    assert.equal(await page.evaluate("document.querySelector('.ql-editor .ql-htmlblock').getAttribute('data-htmlblock')"), src.replace(' class="order-step featured"', ''), 'clearing classes removes only the outer class attribute');
    await page.evaluate("__q.getModule('history').undo()");
    await fill(page, '.blk-classes input', 'order-step featured boxed');
    await clickText(page, '.blk-classes button', 'Apply classes');
    for (const width of [1280, 390]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const bounds = await page.evaluate(`(() => {
        const bar = document.querySelector('.ql-editor .blk-bar');
        const rect = bar.getBoundingClientRect();
        return { width: innerWidth, right: rect.right, input: bar.querySelector('input').getBoundingClientRect().width, scroll: bar.scrollWidth, client: bar.clientWidth };
      })()`);
      assert.ok(bounds.input > 60 && bounds.scroll <= bounds.client + 1 && bounds.right <= bounds.width, `${width}: class input fits without horizontal overflow`);
    }

    await fill(page, '#view input[placeholder=Title]', 'Class groups');
    await fill(page, '#view input[placeholder^="set once"]', 'class-groups');
    await clickText(page, '#view button', 'Save draft');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    await clickText(page, 'dialog button', 'Commit and push');
    await until(page, "document.querySelector('.toast.success')", 30000);
    const saved = (await page.evaluate("window.__fake.files('example/blog')"))['posts/class-groups.md'];
    assert.ok(saved.includes(`Before.\n\n${styled}\n\nAfter.\n`));
    await page.evaluate("location.hash = '#repo=example/blog&edit=class-groups'; 0");
    await until(page, "document.querySelector('.ql-editor .ql-htmlblock')");
    assert.equal(await page.evaluate("document.querySelector('.ql-htmlblock pre').textContent"), styled);
    assert.equal(await page.evaluate("document.querySelector('.blk-classes input').value"), 'order-step featured boxed');
    await clickText(page, '.ql-editor button.blk-edit', 'Edit HTML');
    await until(page, "document.querySelector('dialog.blk-dialog[open] textarea')");
    assert.equal(await page.evaluate("document.querySelector('dialog textarea').value"), styled);
    await clickText(page, 'dialog.blk-dialog button', 'Cancel');
    assert.deepEqual(await page.evaluate('window.__alerts'), []);
  } finally {
    chrome.close();
    web.close();
  }
});

test('slideshow player: autoplay, pause, controls, reduced motion and cleanup in a real browser', { skip, timeout: 60000 }, async () => {
  const web = await serve(root);
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
    await until(page, "document.querySelector('#top button')");
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await page.evaluate(`(async () => {
      const { slideshowHtml } = await import('/lib/slideshow.js');
      const { THEME_DEFAULT } = await import('/lib/theme.js');
      const style = document.createElement('style');
      style.textContent = THEME_DEFAULT;
      document.head.append(style);
      window.__player = await import('/lib/slideshow-player.js');
      const html = slideshowHtml([1, 2, 3].map(n => ({ image: 'https://example.com/' + n + '.jpg', alt: 'Boat ' + n, title: 'Slide ' + n, text: 'Caption ' + n, label: 'Products', url: './products/', animation: [undefined, 'fadeInUp', 'none'][n - 1], ...(n === 3 ? { imageAnimation: 'fadeIn', titleAnimation: 'fadeInDown', textAnimation: 'fadeInLeft', labelAnimation: 'zoomIn' } : {}) })));
      document.body.innerHTML = html;
      window.__timers = new Map();
      let id = 0;
      window.setTimeout = (fn, delay) => { window.__timers.set(++id, { fn, delay }); return id; };
      window.clearTimeout = id => window.__timers.delete(id);
      window.__tick = () => { const tasks = [...window.__timers.values()]; window.__timers.clear(); tasks.forEach(t => t.fn()); };
      window.__cleanup = window.__player.mountSlideshows(document);
      window.__player.mountSlideshows(document);
    })()`);
    const active = () => page.evaluate("document.querySelector('figure:not([hidden]) h2').textContent");
    assert.equal(await page.evaluate("document.querySelectorAll('.webcli-slide-controls').length"), 1);
    assert.equal(await page.evaluate("getComputedStyle(document.querySelector('figure:not([hidden])')).animationName"), 'fadeIn', 'legacy slides default to fade in');
    const opacity = await page.evaluate("(() => { const el = document.querySelector('figure:not([hidden])'); const animation = el.getAnimations()[0]; animation.pause(); animation.currentTime = 500; return Number(getComputedStyle(el).opacity); })()");
    assert.ok(opacity > 0 && opacity < 1, 'the vendored CSS produces an actual fade, not just class names');
    assert.equal(await page.evaluate("[...window.__timers.values()].map(t => t.delay).join()"), '6000');
    await page.evaluate('window.__tick()');
    assert.equal(await active(), 'Slide 2');
    assert.equal(await page.evaluate("getComputedStyle(document.querySelector('figure:not([hidden])')).animationName"), 'fadeInUp');
    await page.evaluate("document.querySelector('section').dispatchEvent(new Event('pointerenter'))");
    assert.equal(await page.evaluate('window.__timers.size'), 0);
    await page.evaluate("document.querySelector('section').dispatchEvent(new Event('pointerleave'))");
    assert.equal(await page.evaluate('window.__timers.size'), 1);
    const box = await page.evaluate("(() => { const r = document.querySelector('[aria-label=\"Pause slideshow\"]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()");
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, ...box, button: 'left', clickCount: 1 });
    assert.equal(await page.evaluate("document.querySelector('[aria-label=\"Play slideshow\"]') !== null"), true, 'pointer pause does not restart after focus');
    assert.equal(await page.evaluate('window.__timers.size'), 0);
    await clickText(page, 'button', 'Next');
    assert.equal(await active(), 'Slide 3');
    assert.equal(await page.evaluate("getComputedStyle(document.querySelector('figure:not([hidden])')).animationName"), 'none');
    assert.deepEqual(await page.evaluate("[...document.querySelector('figure:not([hidden])').querySelectorAll('img, h2, p, a')].map(el => getComputedStyle(el).animationName)"), ['fadeIn', 'fadeInDown', 'fadeInLeft', 'zoomIn']);
    await page.evaluate("window.__titleAnimation = document.querySelector('figure:not([hidden]) h2').getAnimations()[0]; 0");
    await clickText(page, 'button', '3');
    assert.equal(await page.evaluate("document.querySelector('figure:not([hidden]) h2').getAnimations()[0] !== window.__titleAnimation"), true, 'reselecting a slide restarts its element effects');
    await page.evaluate("document.querySelector('section').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
    assert.equal(await active(), 'Slide 1');
    assert.equal(await page.evaluate("document.querySelectorAll('figure[hidden] .animate__animated').length"), 0, 'hidden slides retain no running element effects');
    await page.evaluate("document.querySelector('section').dispatchEvent(new Event('pointerleave'))");
    await clickText(page, 'button', 'Play');
    assert.equal(await page.evaluate('window.__timers.size'), 1);
    await page.evaluate("document.querySelector('figure:not([hidden]) a').focus()");
    assert.equal(await page.evaluate('window.__timers.size'), 0, 'focus pauses rotation');
    await clickText(page, 'button', '3');
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await until(page, "document.querySelectorAll('.animate__animated').length === 0");
    assert.equal(await page.evaluate("getComputedStyle(document.querySelector('figure:not([hidden])')).animationName"), 'none', 'switching reduced motion on cancels the effect');
    assert.equal(await page.evaluate("document.querySelectorAll('.animate__animated').length"), 0, 'reduced motion cancels child effects too');
    await page.evaluate('window.__cleanup()');
    assert.equal(await page.evaluate("document.querySelectorAll('figure:not([hidden])').length"), 3);
    assert.equal(await page.evaluate("document.querySelectorAll('.webcli-slide-controls').length"), 0);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.evaluate("window.__player.mountSlideshows(document)");
    assert.equal(await page.evaluate('window.__timers.size'), 0, 'reduced motion starts paused');
    assert.equal(await page.evaluate("document.querySelector('[aria-label=\"Play slideshow\"]') !== null"), true);
    await clickText(page, 'button', 'Next');
    assert.equal(await page.evaluate("getComputedStyle(document.querySelector('figure:not([hidden])')).animationName"), 'none', 'manual navigation also respects reduced motion');
    await page.evaluate("window.__player.unmountSlideshows(document)");
    assert.equal(await page.evaluate("document.querySelectorAll('[hidden]').length"), 0);
  } finally {
    chrome.close();
    web.close();
  }
});

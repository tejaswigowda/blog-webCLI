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

async function site() {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-blocks-'));
  for (const d of ['app', 'lib', 'blog', 'vendor']) await cp(path.join(root, d), path.join(copy, d), { recursive: true });
  await cp(path.join(root, 'index.html'), path.join(copy, 'index.html'));
  await mkdir(path.join(copy, 'test'));
  await cp(path.join(root, 'test', 'fake-github.js'), path.join(copy, 'test', 'fake-github.js'));
  await writeFile(path.join(copy, 'data.js'), `export const data = ${JSON.stringify({ 'example/blog': { 'blog.json': Buffer.from(BLOG).toString('base64') } })};\n`);
  return copy;
}
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
    assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog button.primary').disabled"), true);
    assert.equal(await page.evaluate("document.querySelector('select[aria-label=\"Slide 1 animation\"]').value"), 'fadeIn');
    for (const i of [1, 2]) {
      await fill(page, `dialog input[aria-label="Slide ${i} image"]`, `https://example.com/${i}.jpg`);
      await fill(page, `dialog input[aria-label="Slide ${i} alternative text"]`, `Boat ${i}`);
      await fill(page, `dialog input[aria-label="Slide ${i} heading"]`, `Platform ${i}`);
    }
    await fill(page, 'dialog input[aria-label="Slide 1 caption"]', '<script>not executable</script>');
    await fill(page, 'dialog input[aria-label="Slide 1 link label"]', 'Products');
    assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog button.primary').disabled"), true, 'a label requires its address');
    await fill(page, 'dialog input[aria-label="Slide 1 link address"]', './products/');
    await page.evaluate("for (const [i, value] of [[1, 'fadeInUp'], [2, 'none']]) { const select = document.querySelector('select[aria-label=\"Slide ' + i + ' animation\"]'); select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }");
    await page.evaluate("for (const [field, value] of [['image', 'zoomIn'], ['heading', 'fadeInDown'], ['caption', 'fadeInLeft'], ['link label', 'bounceIn']]) { const select = document.querySelector('select[aria-label=\"Slide 1 ' + field + ' animation\"]'); select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }");
    await clickText(page, 'dialog button', '+ Slide');
    assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog button.primary').disabled"), true);
    await page.evaluate("document.querySelector('button[aria-label=\"Remove slide 3\"]').click(); document.querySelector('button[aria-label=\"Move slide 2 up\"]').click(); 0");
    assert.equal(await page.evaluate("document.querySelector('input[aria-label=\"Slide 1 heading\"]').value"), 'Platform 2');
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

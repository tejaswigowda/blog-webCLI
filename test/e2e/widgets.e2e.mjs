import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../../lib/blog.js';
import { EXAMPLE_BLOG } from '../../lib/sample.js';
import { loadTheme, pinFor, themeDigest, themeFilePaths } from '../../lib/theme-pack.js';
import { slideshowHtml } from '../../lib/slideshow.js';
import { readDirFiles } from '../helpers.js';
import { serve } from '../../cli/serve.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const skip = chromePath() ? false : 'Chrome is not installed';
const themesRoot = new URL('../../../blog-webCLI-themes/', import.meta.url);
const starters = ['essay', 'terminal', 'wide', 'cards'];
const source = await readFile(new URL('../layout/widgets.md', import.meta.url), 'utf8');
const example = JSON.parse(await readFile(new URL('../../examples/blog/blog.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../../examples/blog/assets.lock.json', import.meta.url), 'utf8'));

async function themeFor(name) {
  const files = name === 'unaware'
    ? Object.fromEntries(Object.entries({
      'theme.json': JSON.stringify({ name: 'Unaware', version: '1.0.0', licence: 'MIT', class_contract: 'blog-webcli-v1', css: ['style.css'] }),
      'style.css': 'body{margin:0}.wrap{max-width:640px;margin:auto;padding:20px}article figure{width:calc(100% + 12rem);max-width:calc(100% + 12rem);margin-inline:-6rem}article figure img{width:900px;max-width:none}',
    }).map(([p, s]) => [p, new TextEncoder().encode(s)]))
    : await readDirFiles(fileURLToPath(new URL(`${name}/`, themesRoot)));
  const manifest = JSON.parse(new TextDecoder().decode(files['theme.json']));
  const pin = pinFor(`example/themes/${name}`, 'v1.0.0', manifest, themeDigest(files, themeFilePaths(manifest)));
  return { pin, theme: loadTheme(pin, files) };
}

test('all widgets and no-script slideshow: five starters plus an unaware theme at 1280 and 390px', { skip, timeout: 120000 }, async (t) => {
  const available = starters.filter((s) => existsSync(new URL(`${s}/theme.json`, themesRoot)));
  if (available.length !== starters.length) t.diagnostic('Sibling starter checkout missing; only default and unaware themes can be exercised here.');
  const names = ['default', ...available, 'unaware'];
  const sites = {};
  const slides = slideshowHtml([1, 2].map((n) => ({ image: `./slide${n}.jpg`, alt: `Slide ${n}`, title: `Slide ${n}`, text: 'Readable without scripting', label: '', url: '' })));
  for (const name of names) {
    const loaded = name === 'default' ? {} : await themeFor(name);
    const out = buildSite({
      blog: JSON.stringify({ ...EXAMPLE_BLOG, assets: example.assets, ...(loaded.pin ? { theme: loaded.pin } : {}) }),
      posts: [{ path: 'posts/widgets.md', text: `${source}\n${slides}\n` }],
      lock,
      ...(loaded.theme ? { theme: loaded.theme } : {}),
    });
    assert.deepEqual(out.errors, [], name);
    sites[name] = out.files;
    const css = out.files['theme.css'] || out.files['style.css'];
    if (loaded.theme) assert.ok(css.lastIndexOf('.wc-columns{') > css.indexOf(loaded.theme.css), `${name}: baseline follows theme CSS`);
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE1sAAAAASUVORK5CYII=', 'base64');
  const server = createServer((req, res) => {
    const [name, ...parts] = new URL(req.url, 'http://localhost').pathname.slice(1).split('/');
    let key = parts.join('/');
    if (key.endsWith('/')) key += 'index.html';
    const jpg = key.endsWith('.jpg');
    let value = jpg ? png : sites[name]?.[key];
    if (typeof value === 'string' && key.endsWith('.html')) value = value.replace(/(<img\b[^>]*\bsrc=")[^"]*/g, '$1./fixture.jpg');
    res.writeHead(value === undefined ? 404 : 200, { 'content-type': jpg ? 'image/png' : key.endsWith('.css') ? 'text/css' : key.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(value === undefined ? 'Not found' : value);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const chrome = await launch();
  try {
    const page = await openPage(chrome, 'about:blank');
    await page.send('Network.enable');
    await page.send('Network.setBlockedURLs', { urls: ['https://*'] });
    for (const scripts of [true, false]) {
      await page.send('Emulation.setScriptExecutionDisabled', { value: !scripts });
      for (const name of names) for (const width of [1280, 390]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await page.send('Page.enable');
        const query = `?scripts=${scripts}&width=${width}`;
        await page.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${name}/widgets/${query}` });
        let ready = false;
        for (let i = 0; i < 100; i++) {
          // Load lazy images too: the assertion covers the whole page, not just its first screen.
          ready = await page.evaluate(`(() => {
            for (const i of document.images) i.loading = 'eager';
            return location.pathname === '/${name}/widgets/' && location.search === ${JSON.stringify(query)} && document.readyState === 'complete' && document.querySelectorAll('.wc-compare img').length === 2 && [...document.images].every(i => i.complete && i.naturalWidth > 0) && ${scripts ? "!!document.querySelector('.webcli-slide-controls')" : 'true'};
          })()`);
          if (ready) break;
          await new Promise((r) => setTimeout(r, 25));
        }
        assert.ok(ready, `${name}/${width}/scripts=${scripts}: loaded`);
        const measured = await page.evaluate(`(() => {
          const box = e => { const r = e.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
          const figures = [...document.querySelectorAll('.wc-figure,.wc-compare>figure')];
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            columns: [...document.querySelector('.wc-columns').children].map(box),
            comparison: [...document.querySelector('.wc-compare').children].map(box),
            figures: figures.map(box),
            images: [...document.querySelectorAll('.wc-figure>img,.wc-compare>figure>img')].map(box),
            note: getComputedStyle(document.querySelector('.wc-note')).borderInlineStartWidth,
            radius: parseFloat(getComputedStyle(document.querySelector('.wc-note')).borderRadius),
            regions: [...document.querySelectorAll('.wc-faq,.wc-note,.wc-columns,.wc-col,.wc-figure,.wc-button,.wc-quote,.wc-steps,.wc-compare,dl')].map(box),
            steps: getComputedStyle(document.querySelector('.wc-steps')).listStyleType,
            toc: document.querySelectorAll('.toc').length,
            native: document.querySelector('.wc-faq details').open,
            slides: [...document.querySelectorAll('.webcli-slide')].map(box),
            hiddenSlides: document.querySelectorAll('.webcli-slide[hidden]').length,
            controls: document.querySelectorAll('.webcli-slide-controls').length,
          };
        })()`);
        const label = `${name}/${width}/scripts=${scripts}`;
        assert.equal(measured.overflow, false, `${label}: no page overflow`);
        assert.equal(measured.toc, 1, `${label}: generated contents`);
        assert.equal(measured.steps, 'decimal', `${label}: real numbered steps`);
        assert.equal(measured.note, '4px', `${label}: note treatment`);
        assert.ok(Math.abs(measured.radius - {default:6.4,essay:3.2,terminal:0,wide:4,cards:12.8,unaware:6.4}[name]) < .1, `${label}: starter-specific visual treatment`);
        assert.ok(measured.regions.every(r => r.width > 0 && r.height > 0), `${label}: no empty widget region`);
        assert.equal(measured.native, true, `${label}: native open preserved`);
        const [left, right] = measured.comparison;
        const [col1, col2] = measured.columns;
        if (width === 390) {
          assert.ok(right.top >= left.bottom, `${label}: comparison stacks in order`);
          assert.ok(col2.top >= col1.bottom, `${label}: columns stack in order`);
        } else {
          assert.ok(right.left >= left.right, `${label}: comparison side-by-side`);
          assert.ok(col2.left >= col1.right, `${label}: columns side-by-side`);
        }
        for (const [i, f] of measured.figures.entries()) {
          assert.ok(f.left >= 0 && f.right <= width && f.height > 0, `${label}: figure contained`);
          const img = measured.images[i];
          assert.ok(img.width > 0 && img.left >= f.left - 1 && img.right <= f.right + 1, `${label}: image fits figure`);
        }
        if (!scripts) {
          assert.equal(measured.controls, 0, `${label}: no nonfunctional controls`);
          assert.equal(measured.hiddenSlides, 0, `${label}: no hidden slides`);
          const [a, b] = measured.slides;
          assert.ok(a.height > 0 && b.height > 0 && b.top >= a.bottom, `${label}: all slides stacked in source order`);
          assert.ok(measured.slides.every(s => s.left >= 0 && s.right <= width), `${label}: no clipped slides`);
          const firstSummary = await page.evaluate("(() => { const n = document.querySelector('.wc-faq summary'); n.scrollIntoView({block:'center'}); const r = n.getBoundingClientRect(); return {x:r.x+10,y:r.y+10}; })()");
          await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...firstSummary });
          await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...firstSummary });
          assert.equal(await page.evaluate("document.querySelector('.wc-faq details').open"), false, `${label}: native click closes the answer`);
          await page.evaluate("document.querySelector('.wc-faq summary').focus()");
          await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
          await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
          assert.equal(await page.evaluate("document.querySelector('.wc-faq details').open"), true, `${label}: native keyboard toggles after click closes it`);
        } else {
          const buttonFits = await page.evaluate(`(() => {
            const button = document.querySelector('.wc-button');
            button.textContent = 'W'.repeat(200);
            return button.scrollWidth <= button.clientWidth + 1 && button.getBoundingClientRect().right <= innerWidth;
          })()`);
          assert.equal(buttonFits, true, `${label}: long button labels wrap instead of overflowing`);
          const revealed = await page.evaluate(`(async () => {
            const target = document.querySelectorAll('.webcli-slide h2')[1];
            document.addEventListener('click', event => event.preventDefault(), {once:true});
            document.querySelector('.toc a[href="#' + target.id + '"]').click();
            await new Promise(resolve => requestAnimationFrame(resolve));
            return !target.closest('figure').hidden && location.hash === '';
          })()`);
          assert.equal(revealed, true, `${label}: contents reveals a hidden slide even with reader-style fragment handling`);
        }
      }
    }
    page.close();
  } finally {
    chrome.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('widget toolbar forms: validation, all types, lossless editing, source fallback and atomic undo', { skip, timeout: 90000 }, async () => {
  const web = await serve(fileURLToPath(new URL('../../', import.meta.url)));
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html`);
    const wait = async (expr) => {
      for (let i = 0; i < 100; i++) {
        if (await page.evaluate(`Boolean(${expr})`)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.fail(`Timed out: ${expr}`);
    };
    await wait("document.readyState === 'complete'");
    await page.evaluate(`(async () => {
      const {createEditor} = await import('/app/editor.js');
      const root = document.createElement('div'); document.body.append(root);
      window.__picks = 0;
      window.__q = await createEditor(root, {chooseImage: use => { __picks++; use('asset:images/widget.jpg'); }});
      window.__markup = await import('/lib/markdown.js');
      window.__widgets = await import('/app/widgets.js');
    })()`);
    const click = (text) => page.evaluate(`(() => {
      const b = [...document.querySelectorAll('dialog.blk-dialog button')].find(b => b.textContent === ${JSON.stringify(text)});
      if (!b) throw new Error('No button: ' + ${JSON.stringify(text)});
      b.click();
    })()`);
    const fill = (label, value) => page.evaluate(`(() => {
      const n = document.querySelector('dialog.blk-dialog [aria-label=' + CSS.escape(${JSON.stringify(label)}) + ']');
      if (!n) throw new Error('No field: ' + ${JSON.stringify(label)});
      n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    const cases = [
      ['faq', { 'Question 1': 'Does it work?', 'Answer 1': 'Yes.\n\nEven without scripts.' }],
      ['note', { Note: '<script>plain text</script>' }],
      ['columns', { 'Column 1': 'Left', 'Column 2': 'Right' }],
      ['figure', { 'Figure alternative text': 'Boat', 'Figure caption': 'A boat', Credit: 'Photographer' }],
      ['button', { 'Link address': './products/', 'Link label': 'Products' }],
      ['quote', { Quote: 'A quotation.', 'Citation (optional)': 'An author' }],
      ['steps', { 'Step 1': 'First step' }],
      ['compare', { 'Before image': './before.jpg', 'Before alternative text': 'Before', 'Before caption': 'Old', 'After image': './after.jpg', 'After alternative text': 'After', 'After caption': 'New' }],
      ['definitions', { 'Term 1': 'Widget', 'Definition 1': 'Native markup.' }],
      ['embed', { 'Embed title': 'Example', 'HTTPS embed address': 'https://example.org/player' }],
      ['native-video', { 'Video title': 'Demonstration', 'HTTPS video address (.mp4, .webm or .ogv)': 'https://example.org/demo.mp4' }],
      ['markdown', { 'Markdown source': '## Heading\n\n**Editable** text.\n' }],
      ['film-cards', { 'Film 1 poster': './poster.jpg', 'Film 1 link': './film/', 'Film 1 title': 'Film', 'Film 1 topic': 'Geometry', 'Film 1 duration': '1:00', 'Film 1 claim': 'A claim.', 'Film 1 scene link': 'https://example.org/scene', 'Film 1 tutorial link': 'https://example.org/tutorial' }],
    ];
    const saved = [];
    for (const [type, values] of cases) {
      await page.evaluate("__q.setContents([{insert:'Before.\\nAfter.\\n'}]); __q.getModule('history').clear(); __q.setSelection(8,0); document.querySelector('button.ql-widget').click()");
      await wait("document.querySelector('dialog.blk-dialog[open]')");
      await page.evaluate(`(() => { const s = document.querySelector('[aria-label="Widget type"]'); s.value = ${JSON.stringify(type)}; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog .primary').disabled"), true, `${type}: incomplete form refused`);
      if (type === 'figure') await click('Choose figure from Media…');
      if (type === 'button') {
        await fill('Link address', 'javascript:alert(1)');
        await fill('Link label', 'Unsafe');
        assert.match(await page.evaluate("document.querySelector('dialog.blk-dialog .blk-msg').textContent"), /scheme/);
      }
      for (const [label, value] of Object.entries(values)) await fill(label, value);
      if (type === 'faq') {
        await click('+ Question');
        assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog .primary').disabled"), true, 'new empty question is refused');
        await fill('Question 2', 'Another question?');
        await fill('Answer 2', 'Another answer.');
        await page.evaluate("document.querySelectorAll('dialog.blk-dialog fieldset')[1].querySelector('button').click()");
        assert.equal(await page.evaluate("document.querySelector('[aria-label=\"Question 1\"]').value"), 'Another question?', 'questions reorder');
        await page.evaluate("[...document.querySelectorAll('dialog.blk-dialog fieldset')[1].querySelectorAll('button')].find(b => b.textContent === 'Remove').click(); document.querySelector('dialog.blk-dialog input[type=checkbox]').click()");
      }
      assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog .blk-msg').textContent"), '', `${type}: valid form`);
      await click('Apply');
      await wait("!document.querySelector('dialog.blk-dialog')");
      const src = await page.evaluate("document.querySelector('.ql-editor .ql-htmlblock').getAttribute('data-htmlblock')");
      saved.push(src);
      assert.equal(await page.evaluate("document.querySelector('.ql-htmlblock .blk-edit').textContent"), 'Edit widget', `${type}: canonical form detected`);
      assert.equal(await page.evaluate("document.querySelectorAll('.ql-editor script,.ql-editor img').length"), 0, `${type}: source is data, never executed`);
      assert.equal(await page.evaluate("__q.getText()"), 'Before.\nAfter.\n', `${type}: surrounding text preserved`);
      await page.evaluate("__q.getModule('history').undo()");
      assert.equal(await page.evaluate("__q.getContents().ops.map(o=>o.insert).join('')"), 'Before.\nAfter.\n', `${type}: one undo removes whole widget`);
      await page.evaluate("__q.getModule('history').redo(); document.querySelector('.ql-htmlblock .blk-edit').click()");
      await wait("document.querySelector('dialog.blk-dialog[open]')");
      await click('Cancel');
      assert.equal(await page.evaluate("document.querySelector('.ql-editor .ql-htmlblock').getAttribute('data-htmlblock')"), src, `${type}: cancellation changes nothing`);
      await page.evaluate("document.querySelector('.ql-htmlblock .blk-edit').click()");
      await wait("document.querySelector('dialog.blk-dialog[open]')");
      await click('Apply');
      assert.equal(await page.evaluate("document.querySelector('.ql-editor .ql-htmlblock').getAttribute('data-htmlblock')"), src, `${type}: edit is byte-identical`);
    }
    assert.equal(await page.evaluate('__picks'), 1, 'figure reuses the Media callback');
    const result = await page.evaluate(`(() => {
      const sources = ${JSON.stringify(saved)};
      const delta = {ops:sources.flatMap(src=>[{insert:{htmlblock:src}},{insert:'\\n'}])};
      const {md,delta:reopened} = __markup.deltaToMarkdownChecked(delta);
      __q.setContents(reopened);
      return [...document.querySelectorAll('.ql-editor .ql-htmlblock')].map(n=>n.getAttribute('data-htmlblock'));
    })()`);
    assert.deepEqual(result, saved, 'every widget survives the shared save/reopen path');
    await page.evaluate(`(() => {
      const rich = '<aside class="wc-note tip"><p>Keep <strong>rich</strong> content.</p></aside>';
      __q.setContents([{insert:{htmlblock:rich}},{insert:'\\n'}]);
      document.querySelector('.ql-htmlblock .blk-edit').click();
    })()`);
    await wait("document.querySelector('dialog.blk-dialog textarea')");
    assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog h2').textContent"), 'HTML block', 'unrepresentable rich HTML uses source, never lossy form');
    await click('Cancel');
    page.close();
  } finally {
    chrome.close();
    web.close();
  }
});

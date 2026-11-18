// End to end, in real Chrome, against an in-memory GitHub: a blog whose blog.json names no images
// repository. If it says where it lives ("repo"), images go to an images folder of that repository
// with nothing to configure. If it does not, choosing an image must say what to do about it (not
// dead-end), must not lose the post being written, and must pick up a repository saved in another
// tab without a reload.
// Run with: npm run test:e2e   (skips itself when Chrome is not installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../../cli/serve.js';
import { chromePath, launch, openPage } from './cdp.mjs';
import { buildSite } from '../../lib/blog.js';
import { loadTheme, pinFor, themeDigest, themeFilePaths } from '../../lib/theme-pack.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skip = chromePath() ? false : 'Chrome is not installed (set CHROME=/path/to/chrome)';

async function site(blogJson) {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-img-'));
  for (const d of ['app', 'lib', 'blog', 'vendor']) await cp(path.join(root, d), path.join(copy, d), { recursive: true });
  await cp(path.join(root, 'index.html'), path.join(copy, 'index.html'));
  await mkdir(path.join(copy, 'test'));
  await cp(path.join(root, 'test', 'fake-github.js'), path.join(copy, 'test', 'fake-github.js'));
  await writeFile(path.join(copy, 'data.js'), `export const data = ${JSON.stringify({ 'example/blog': { 'blog.json': Buffer.from(blogJson).toString('base64') }, 'example/images': { 'README.md': Buffer.from('i').toString('base64'), 'boat.png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0AAAAABJRU5ErkJggg==' } })};\n`);
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
  // a file chooser that answers immediately with a tiny PNG
  HTMLInputElement.prototype.click = function () {
    if (this.type !== 'file') return;
    const dt = new DataTransfer();
    dt.items.add(new File([dec(data['example/images']['boat.png'])], window.__imageName || 'Cat Pic.png', { type: 'image/png' }));
    this.files = dt.files;
    this.dispatchEvent(new Event('change'));
  };
`;

const until = async (page, expr, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(`Boolean(${expr})`)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

async function signedIn(blogJson) {
  const copy = await site(blogJson);
  const web = await serve(copy);
  const chrome = await launch();
  const base = `http://127.0.0.1:${web.address().port}`;
  const page = await openPage(chrome, `${base}/index.html`);
  await until(page, "document.querySelector('#top button')");
  await page.evaluate(`(async () => { ${INSTALL} })()`);
  await page.evaluate("[...document.querySelectorAll('#top button')].find((b) => b.textContent.trim().startsWith('Sign in')).click(); 0");
  await page.evaluate("document.querySelector('dialog input[name=token]').value = 'github_pat_' + 'b'.repeat(30); 0");
  await page.evaluate("[...document.querySelectorAll('dialog button')].find((b) => b.textContent.trim().startsWith('Sign in')).click(); 0");
  await until(page, "(document.querySelector('#top .signed') || {}).title === 'Signed in as tester'");
  return { page, close: () => { chrome.close(); web.close(); } };
}
const blogJson = (extra = {}) => JSON.stringify({ title: 'T', description: 'd', author: 'A', domain: 'https://example.github.io/blog', theme: 'default', ...extra });
const clickText = (page, selector, text) => page.evaluate(`(() => { const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!button) throw new Error('No button: ' + ${JSON.stringify(text)}); button.click(); })()`);
const fill = (page, selector, value) => page.evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);

test('Quill editor resizes vertically by dragging without changing its width or document', { skip, timeout: 60000 }, async () => {
  const { page, close } = await signedIn(blogJson({ repo: 'example/blog' }));
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false });
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('#editor .ql-editor')");
    const before = await page.evaluate(`(() => {
      const editor=document.querySelector('#editor');
      Quill.find(editor).setText('Keep this text.\\n');
      editor.scrollIntoView({block:'center',behavior:'instant'});
      const rect=editor.getBoundingClientRect();
      return {x:rect.right-4,y:rect.bottom-4,width:rect.width,height:rect.height,text:JSON.stringify(Quill.find(editor).getContents())};
    })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x, y: before.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x + 80, y: before.y + 120, button: 'left', buttons: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x + 80, y: before.y + 120, button: 'left', clickCount: 1 });
    const after = await page.evaluate(`(() => {const editor=document.querySelector('#editor'),r=editor.getBoundingClientRect();return {width:r.width,height:r.height,text:JSON.stringify(Quill.find(editor).getContents())};})()`);
    assert.ok(after.height >= before.height + 100, 'Dragging the resize handle must actually increase the editor height');
    assert.equal(after.width, before.width, 'The editor resizes vertically only');
    assert.equal(after.text, before.text);
  } finally {
    close();
  }
});

test('Quill picture presets survive saving and control rendered images with default and pinned themes', { skip, timeout: 60000 }, async () => {
  const picture = 'data:image/svg+xml,' + encodeURIComponent(await readFile(path.join(root, 'examples/theme-plain/img/rule.svg'), 'utf8'));
  const web = await serve(root);
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/`);
    await until(page, "document.readyState === 'complete'");
    await page.evaluate(`(async () => {
      const {createEditor,setAssetResolver} = await import('/app/editor.js');
      setAssetResolver(() => ${JSON.stringify(picture)});
      window.__markdown = await import('/lib/markdown.js');
      const host = document.createElement('div'); document.body.append(host);
      window.__pictureEditor = await createEditor(host, {});
      __pictureEditor.setContents([{insert:{image:'asset:images/rule.svg'}},{insert:'\\n'}]);
    })()`);
    const files = {
      'theme.json': JSON.stringify({ name: 'Image rules', version: '1.0.0', licence: 'MIT', class_contract: 'blog-webcli-v1', css: ['style.css'] }),
      'style.css': 'html body article img[src]{width:100%;height:120px;display:inline;margin:0;float:none}',
    };
    const manifest = JSON.parse(files['theme.json']);
    const pin = pinFor('example/themes/images', 'v1.0.0', manifest, themeDigest(files, themeFilePaths(manifest)));
    const theme = loadTheme(pin, files);
    for (const [preset, ratio] of [['small', .25], ['medium', .5], ['large', .75], ['full', 1], ['left', .4], ['right', .4], ['inline', null], ['', null]]) {
      const md = await page.evaluate(`(() => {
        __pictureEditor.root.querySelector('img').click();
        __pictureEditor.container.querySelector('.img-bar [data-value="${preset}"]').click();
        return __markdown.deltaToMarkdownChecked(__pictureEditor.getContents()).md;
      })()`);
      if (preset) assert.match(md, new RegExp(`\\{\\.${preset}\\}`), 'The Quill choice must reach saved Markdown');
      else assert.doesNotMatch(md, /\{\./, 'Default clears the saved preset');
      for (const pinned of [false, true]) {
        const out = buildSite({
          blog: { title: 'Images', description: 'd', author: 'A', domain: 'https://example.test/', assets: { base: 'https://cdn.example/{owner}/{repo}/{sha}/{path}', repos: { images: 'example/images' } }, ...(pinned ? { theme: pin } : {}) },
          posts: [{ path: 'posts/picture.md', text: `---\nslug: picture\ntitle: Picture\ndate: 2026-01-01\nstatus: published\n---\n\n${md}` }],
          lock: { 'images/rule.svg': 'a'.repeat(40), 'images/rule.svg#size': '64x2' }, ...(pinned ? { theme } : {}),
        });
        assert.deepEqual(out.errors, []);
        await page.evaluate(`(() => {
          document.querySelector('#picture-output')?.remove();
          const frame = document.createElement('iframe');
          frame.id = 'picture-output'; frame.width = '1100'; frame.height = '600';
          frame.setAttribute('sandbox', 'allow-same-origin');
          frame.srcdoc = ${JSON.stringify(out.files['picture/index.html'].replace(/(<img\b[^>]*\bsrc=")[^"]*/g, (_match, prefix) => prefix + picture))};
          document.body.append(frame);
        })()`);
        await until(page, `(() => {const img=document.querySelector('#picture-output').contentDocument?.querySelector('article img');return img?.complete && img.naturalWidth > 0;})()`);
        for (const width of [1100, 390]) {
          const layout = await page.evaluate(`(async () => {
            const frame=document.querySelector('#picture-output');frame.width='${width}';
            await new Promise(resolve=>requestAnimationFrame(resolve));
            const img=frame.contentDocument.querySelector('article img');
            const css=img.ownerDocument.defaultView.getComputedStyle(img);
            return {ratio:img.getBoundingClientRect().width/img.parentElement.getBoundingClientRect().width,float:css.float,display:css.display,height:parseFloat(css.height),font:parseFloat(css.fontSize)};
          })()`);
          const floating = ['left', 'right'].includes(preset);
          const expected = width < 640 && (floating || preset === 'small') ? (floating ? 1 : .5) : ratio;
          if (ratio !== null) {
            assert.ok(Math.abs(layout.ratio - expected) < .01, `${preset}, ${pinned ? 'pinned' : 'default'}, ${width}px: expected ${expected}, got ${layout.ratio}`);
            assert.equal(layout.float, floating && width > 640 ? preset : 'none');
            assert.equal(layout.display, 'block');
          } else if (preset === 'inline') assert.ok(Math.abs(layout.height - layout.font * 1.4) < 1);
          else assert.equal(layout.height, pinned ? 120 : 2, 'Unmarked images retain theme defaults');
        }
      }
    }
  } finally {
    chrome.close();
    web.close();
  }
});

test('Settings: choose a favicon from the media library', { skip, timeout: 60000 }, async () => {
  const { page, close } = await signedIn(blogJson({ repo: 'example/blog', assets: { base: 'https://cdn.jsdelivr.net/gh/{owner}/{repo}@{sha}/{path}', repos: { images: 'example/images' } } }));
  try {
    await page.evaluate("location.hash = '#repo=example/blog&settings'; 0");
    await until(page, 'document.querySelector(\'input[aria-label="Favicon"]\')');
    await clickText(page, 'form button', 'Choose from media');
    await until(page, "document.querySelector('dialog.media-dialog[open] .media-tile')");
    await page.evaluate("document.querySelector('dialog.media-dialog .media-tile[title=\"asset:images/boat.png\"]').click(); 0");
    assert.equal(await page.evaluate("document.querySelector('input[aria-label=\"Favicon\"]').value"), 'asset:images/boat.png');
    assert.equal(await page.evaluate("document.querySelector('dialog.media-dialog') === null"), true);
  } finally {
    close();
  }
});

test('slideshow images: select from Media, upload on save, and discard cancelled uploads without losing slide fields', { skip, timeout: 120000 }, async () => {
  const { page, close } = await signedIn(blogJson({ repo: 'example/blog', assets: { base: 'https://cdn.jsdelivr.net/gh/{owner}/{repo}@{sha}/{path}', repos: { images: 'example/images' } } }));
  try {
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    await page.evaluate("window.__imageName = 'discard.png'; document.querySelector('button.ql-slideshow').click(); 0");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    await page.evaluate("document.querySelector('button[aria-label=\"Choose image for slide 1\"]').click(); 0");
    await until(page, "document.querySelector('dialog.media-dialog[open] .media-tile')");
    await clickText(page, 'dialog.media-dialog button', 'Upload a new image');
    await until(page, "/discard\\.png$/.test(document.querySelector('input[aria-label=\"Slide 1 image\"]').value)");
    await clickText(page, 'dialog.blk-dialog button', 'Cancel');
    assert.equal(await page.evaluate("document.querySelectorAll('.ql-editor .ql-htmlblock').length"), 0);

    await page.evaluate("window.__imageName = 'Cat Pic.png'; document.querySelector('button.ql-slideshow').click(); 0");
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    await fill(page, 'input[aria-label="Slide 1 heading"]', 'Keep this heading');
    await fill(page, 'input[aria-label="Slide 1 alternative text"]', 'Our boat');
    await page.evaluate("document.querySelector('button[aria-label=\"Choose image for slide 1\"]').click(); 0");
    await until(page, "document.querySelector('dialog.media-dialog[open] .media-tile')");
    await page.evaluate("document.querySelector('dialog.media-dialog .media-tile[title=\"asset:images/boat.png\"]').click(); 0");
    assert.equal(await page.evaluate("document.querySelector('input[aria-label=\"Slide 1 image\"]').value"), 'asset:images/boat.png');
    assert.equal(await page.evaluate("document.querySelector('input[aria-label=\"Slide 1 heading\"]').value"), 'Keep this heading');
    await page.evaluate("document.querySelector('button[aria-label=\"Choose image for slide 1\"]').click(); 0");
    await until(page, "document.querySelector('dialog.media-dialog[open]')");
    await clickText(page, 'dialog.media-dialog button', 'Cancel');
    assert.equal(await page.evaluate("document.querySelector('input[aria-label=\"Slide 1 image\"]').value"), 'asset:images/boat.png', 'cancelling the picker leaves the selection intact');

    await page.evaluate("document.querySelector('button[aria-label=\"Choose image for slide 2\"]').click(); 0");
    await until(page, "document.querySelector('dialog.media-dialog[open]')");
    await clickText(page, 'dialog.media-dialog button', 'Upload a new image');
    await until(page, "/cat-pic\\.png$/.test(document.querySelector('input[aria-label=\"Slide 2 image\"]').value)");
    const ref = await page.evaluate("document.querySelector('input[aria-label=\"Slide 2 image\"]').value");
    assert.deepEqual(Object.keys(await page.evaluate("window.__fake.files('example/images')")).sort(), ['README.md', 'boat.png'], 'opening Media or choosing a file uploads nothing');
    assert.equal(await page.evaluate("document.querySelectorAll('.ql-editor img').length"), 0, 'the picker updates the slide, not the underlying editor');
    await fill(page, 'input[aria-label="Slide 2 alternative text"]', 'New platform');
    assert.equal(await page.evaluate("document.querySelector('dialog.blk-dialog .primary').disabled"), false, 'a picker selection refreshes validation');
    await clickText(page, 'dialog.blk-dialog button', 'Apply');
    await until(page, "document.querySelector('.ql-editor .ql-htmlblock')");
    await clickText(page, '.ql-editor .blk-edit', 'Edit slideshow');
    await until(page, "document.querySelector('dialog.blk-dialog[open]')");
    assert.equal(await page.evaluate("document.querySelector('input[aria-label=\"Slide 2 image\"]').value"), ref, 'existing slides use the same picker-enabled form');
    await clickText(page, 'dialog.blk-dialog button', 'Apply');
    await fill(page, '#view input[placeholder="Title"]', 'Boat slideshow');
    await fill(page, '#view input[placeholder^="set once"]', 'boat-slideshow');
    await clickText(page, '#view button', 'Save draft');
    await until(page, "document.querySelector('dialog[open] .preflight')");
    assert.doesNotMatch(await page.evaluate("document.querySelector('dialog[open]').innerText"), /discard\.png/);
    await clickText(page, 'dialog[open] button', 'Commit and push');
    await until(page, "window.__fake.files('example/blog')['posts/boat-slideshow.md']");
    const saved = await page.evaluate("window.__fake.files('example/blog')");
    assert.ok(saved['posts/boat-slideshow.md'].includes(ref));
    assert.match(saved['posts/boat-slideshow.md'], /asset:images\/boat\.png/);
    const lock = JSON.parse(saved['assets.lock.json']);
    assert.equal(lock['images/boat.png'], undefined, 'existing images are not pinned until publication');
    assert.ok(lock[ref.slice('asset:'.length)], 'the staged HTML-block image is uploaded and pinned');
    assert.deepEqual(Object.keys(await page.evaluate("window.__fake.files('example/images')")).sort(), ['README.md', 'boat.png', ref.slice('asset:images/'.length)].sort());
  } finally {
    close();
  }
});

test('images: a blog that says where it lives needs nothing configured; the Settings fields show the default', { skip, timeout: 120000 }, async () => {
  const { page, close } = await signedIn(blogJson({ repo: 'example/blog' }));
  try {
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    await page.evaluate("document.querySelector('.ql-image').click(); 0");
    await until(page, "document.querySelector('dialog.media-dialog[open]')");
    await clickText(page, 'dialog.media-dialog button', 'Upload a new image');
    await until(page, "document.querySelector('.ql-editor img')");
    assert.equal(await page.evaluate("document.querySelector('.toast.error')"), null, 'no complaint: images default to this repository');

    await page.evaluate("location.hash = '#repo=example/blog&settings'; 0");
    await until(page, "document.querySelector('#view input[placeholder^=\"blank:\"]')");
    const fields = await page.evaluate("[...document.querySelectorAll('#view input[placeholder^=\"blank:\"]')].map((i) => [i.value, i.placeholder])");
    assert.deepEqual(fields, [['', 'blank: example/blog/images'], ['', 'blank: example/blog/videos']], 'blank, with the default shown as the placeholder');
  } finally {
    close();
  }
});

test('images: a blog that does not say where it lives explains what to do, keeps the post, and notices the fix', { skip, timeout: 120000 }, async () => {
  const { page, close } = await signedIn(blogJson());
  try {
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    await page.evaluate("document.querySelector('.ql-editor').focus(); document.execCommand('insertText', false, 'words I have written'); 0");

    await page.evaluate("document.querySelector('.ql-image').click(); 0");
    await until(page, "document.querySelector('.toast.error')");
    const msg = await page.evaluate("document.querySelector('.toast.error .toast-body').innerText");
    assert.match(msg, /no images repository yet/);
    assert.match(msg, /me\/images/);
    assert.match(msg, /example\/blog\/images/, 'it suggests keeping them in this repository, as a folder');
    const settings = await page.evaluate("(() => { const a = document.querySelector('.toast.error button[data-href]'); return [a.dataset.href, a.tagName]; })()");
    assert.deepEqual(settings, ['#repo=example/blog&settings', 'BUTTON']);
    assert.equal(await page.evaluate("document.querySelector('.ql-editor img')"), null, 'nothing was inserted');
    assert.match(await page.evaluate("document.querySelector('.ql-editor').innerText"), /words I have written/, 'the post is still there');

    // "saved in Settings, in another tab": blog.json on GitHub now names an images repository
    await page.evaluate(`(() => {
      const S = window.__fake.state['example/blog'];
      const tree = S.trees[S.commits[S.branches.main].tree];
      const b = JSON.parse(new TextDecoder().decode(tree.get('blog.json').bytes));
      b.assets = { base: 'https://cdn.jsdelivr.net/gh/{owner}/{repo}@{sha}/{path}', repos: { images: 'example/images' } };
      tree.set('blog.json', { bytes: new TextEncoder().encode(JSON.stringify(b)), sha: 'f'.repeat(40) });
    })()`);
    await page.evaluate("document.querySelector('.ql-image').click(); 0");
    await until(page, "document.querySelector('.ql-editor img')");
    assert.match(await page.evaluate("document.querySelector('#view').innerText"), /words I have written/);
    await until(page, "!document.querySelector('.toast.error')"); // it fades out
  } finally {
    close();
  }
});

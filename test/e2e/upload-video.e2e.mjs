// End to end, in real Chrome with real WebCodecs, against an in-memory GitHub: upload an MP4 from the
// "Embed a video" dialog. It is encoded in the page into an HLS ladder, reviewed, committed with its
// tag, and embedded in the post. Then ffprobe (a test-time tool) reads the published playlist back,
// to show the files are a playable HLS stream and not merely well-named.
// Run with: npm run test:e2e   (skips itself when Chrome or ffmpeg is not installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../../cli/serve.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const skip = !chromePath() ? 'Chrome is not installed (set CHROME=/path/to/chrome)' : !HAS_FFMPEG ? 'ffmpeg and ffprobe are needed to make and check the video' : false;
const b64 = (t) => Buffer.from(t).toString('base64');
const BLOG = JSON.stringify({ title: 'T', description: 'd', author: 'A', domain: 'https://example.github.io/blog', repo: 'example/blog', theme: 'default' });

async function site() {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'blog-vid-'));
  for (const d of ['app', 'lib', 'blog', 'vendor']) await cp(path.join(root, d), path.join(copy, d), { recursive: true });
  await cp(path.join(root, 'index.html'), path.join(copy, 'index.html'));
  await mkdir(path.join(copy, 'test'));
  await cp(path.join(root, 'test', 'fake-github.js'), path.join(copy, 'test', 'fake-github.js'));
  await writeFile(path.join(copy, 'data.js'), `export const data = ${JSON.stringify({ 'example/blog': { 'blog.json': b64(BLOG) } })};\n`);
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
`;

const until = async (page, expr, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(`Boolean(${expr})`)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}\n--- dialog:\n${await page.evaluate("document.querySelector('dialog')?.innerText || '(none)'")}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
const clickText = (page, selector, text) => page.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(selector + ' ' + text)}); el.click(); return true; })()`);
const dialogText = (page) => page.evaluate("document.querySelector('dialog[open]')?.innerText || ''");
const pick = (page, name, base64) => page.evaluate(`(() => {
  const input = document.querySelector('dialog[open] input[type=file]');
  const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: 'video/mp4' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
})()`);

test('video: upload an MP4, encode it in the browser, publish the release, embed it; the result plays', { skip, timeout: 300000 }, async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'blog-vid-src-'));
  const src = path.join(work, 'src.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const video = (await readFile(src)).toString('base64');

  const copy = await site();
  const web = await serve(copy);
  const chrome = await launch();
  const base = `http://127.0.0.1:${web.address().port}`;
  try {
    const page = await openPage(chrome, `${base}/index.html`);
    await until(page, "document.querySelector('#top button')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);
    await clickText(page, '#top button', 'Sign in');
    await page.evaluate("document.querySelector('dialog input[name=token]').value = 'github_pat_' + 'b'.repeat(30); 0");
    await clickText(page, 'dialog button', 'Sign in');
    await until(page, "document.querySelector('#top').innerText.includes('Signed in as tester')");
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");

    // ---- the dialog offers an upload when there is nothing to embed ----
    await page.evaluate("document.querySelector('.ql-video').click(); 0");
    await until(page, "document.querySelector('dialog[open]')");
    await until(page, "document.querySelector('dialog[open]').innerText.includes('No videos here yet')");
    assert.ok(!(await dialogText(page)).includes('Create a release'), 'releases are made under the hood, not asked for');
    await clickText(page, 'dialog button', 'Upload a video');
    await until(page, "document.querySelector('dialog[open] input[type=file]')");

    // ---- something that is not a video is refused with the reason, and nothing else happens ----
    await pick(page, 'notes.mp4', b64('this is not a video file at all'));
    await until(page, "document.querySelector('dialog[open] .err')");
    assert.match(await dialogText(page), /Cannot package this video: not-mp4/);
    assert.equal(await page.evaluate("[...document.querySelectorAll('dialog[open] button')].some((b) => b.textContent.startsWith('Encode') && !b.disabled)"), false, 'nothing to encode yet');

    // ---- a real video: what it is, the qualities, the name ----
    await pick(page, 'Harbour Walk.mp4', video);
    await until(page, "document.querySelector('dialog[open] input[placeholder^=\"release name\"]').value === 'harbour-walk'");
    const facts = await dialogText(page);
    assert.match(facts, /640×360 · 30 fps · 3\.\d s · avc1[\w.]* · with audio/);
    assert.match(facts, /360p30 · 506 kbps/);
    assert.match(facts, /About [\d.]+ [KMB]+ will be added to the repository/);

    // a name hls.webcli.app would refuse disables the button and says why
    await page.evaluate("(() => { const i = document.querySelector('dialog[open] input[placeholder^=\"release name\"]'); i.value = 'test'; i.dispatchEvent(new Event('input')); })()");
    assert.equal(await page.evaluate("[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.startsWith('Encode')).disabled"), true);
    assert.match(await dialogText(page), /category|name/i);
    await page.evaluate("(() => { const i = document.querySelector('dialog[open] input[placeholder^=\"release name\"]'); i.value = 'harbour-walk'; i.dispatchEvent(new Event('input')); })()");

    // ---- encode: real WebCodecs, in the page ----
    await clickText(page, 'dialog button', 'Encode and review');
    await until(page, "document.querySelector('dialog[open]').innerText.includes('Ready to create harbour-walk/v1')", 240000);
    const review = await dialogText(page);
    assert.match(review, /\d+ files, [\d.]+ [KMB]+, to github\.com\/example\/blog \(main\) in videos\/harbour-walk\/ as harbour-walk\/v1/);
    assert.match(review, /Encoded in your browser from 640×360 at 30 fps: 360p30\./);
    for (const f of ['master.m3u8', 'render.json', 'files.sha256', 'poster.jpg', '360p30/index.m3u8', '360p30/init.mp4', 'audio/index.m3u8']) assert.ok(review.includes(`videos/harbour-walk/${f}`) || review.includes('… and'), f);
    assert.match(review, /Nothing has been uploaded yet/);
    assert.equal(await page.evaluate("Object.keys(window.__fake.state['example/blog'].tagRefs).length"), 0, 'encoding sent nothing');

    // ---- publish and embed ----
    await clickText(page, 'dialog button', 'Commit, push and tag');
    await until(page, "!document.querySelector('dialog[open]')", 60000);
    await until(page, "document.querySelector('.ql-editor iframe[data-video]')");
    assert.equal(await page.evaluate("document.querySelector('.ql-editor iframe[data-video]').getAttribute('data-video')"), 'video:videos/harbour-walk@v1');
    assert.match(await page.evaluate("document.querySelector('#view .ok').innerText"), /Created harbour-walk\/v1\./);

    // ---- what was published is a playable HLS stream ----
    const published = await page.evaluate(`(() => {
      const S = window.__fake.state['example/blog'];
      const tree = S.trees[S.commits[S.branches.main].tree];
      const out = {};
      const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(s); };
      for (const [p, e] of tree) if (p.startsWith('videos/harbour-walk/')) out[p] = b64(e.bytes);
      return { files: out, tagIsHead: S.tagRefs['harbour-walk/v1'] === S.branches.main };
    })()`);
    assert.equal(published.tagIsHead, true, 'the tag is at the commit that holds the files');
    const names = Object.keys(published.files);
    assert.ok(names.some((n) => n.endsWith('/master.m3u8')) && names.some((n) => /\/360p30\/seg\d+\.m4s$/.test(n)) && names.some((n) => /\/audio\/seg\d+\.m4s$/.test(n)), names.join('\n'));
    const out = path.join(work, 'published');
    for (const [p, b] of Object.entries(published.files)) {
      const dest = path.join(out, p.slice('videos/'.length));
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(b, 'base64'));
    }
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-allowed_extensions', 'ALL', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', path.join(out, 'harbour-walk', 'master.m3u8')]).toString());
    const v = probe.streams.find((s) => s.codec_type === 'video');
    assert.deepEqual([v.codec_name, v.width, v.height], ['h264', 640, 360]);
    assert.ok(probe.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac'), 'the audio is there too');
    assert.ok(Math.abs(Number(probe.format.duration) - 3) < 0.6, `duration ${probe.format.duration}`);

    // files.sha256 (hls-webCLI's own check) holds for what landed in the repository
    const sums = Buffer.from(published.files['videos/harbour-walk/files.sha256'], 'base64').toString().trim().split('\n');
    assert.ok(sums.length >= 5);
    const crypto = await import('node:crypto');
    for (const line of sums) {
      const [, sha, file] = /^([0-9a-f]{64})\s+\*?(?:\.\/)?(.+)$/.exec(line);
      assert.equal(crypto.createHash('sha256').update(Buffer.from(published.files[`videos/harbour-walk/${file}`], 'base64')).digest('hex'), sha, file);
    }
  } finally {
    chrome.close();
    web.close();
  }
});

test('video: every rung that fits is offered; unticking one leaves it out of the release', { skip, timeout: 300000 }, async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'blog-vid-hd-'));
  const src = path.join(work, 'hd.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-bf', '2', '-pix_fmt', 'yuv420p', src]);
  const video = (await readFile(src)).toString('base64');
  const copy = await site();
  const web = await serve(copy);
  const chrome = await launch();
  const base = `http://127.0.0.1:${web.address().port}`;
  try {
    const page = await openPage(chrome, `${base}/index.html`);
    await until(page, "document.querySelector('#top button')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);
    await clickText(page, '#top button', 'Sign in');
    await page.evaluate("document.querySelector('dialog input[name=token]').value = 'github_pat_' + 'b'.repeat(30); 0");
    await clickText(page, 'dialog button', 'Sign in');
    await until(page, "document.querySelector('#top').innerText.includes('Signed in as tester')");
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    await page.evaluate("document.querySelector('.ql-video').click(); 0");
    await until(page, "document.querySelector('dialog[open]')");
    await clickText(page, 'dialog button', 'Upload a video');
    await until(page, "document.querySelector('dialog[open] input[type=file]')");
    await pick(page, 'dock-at-dawn.mp4', video);
    await until(page, "document.querySelectorAll('dialog[open] input[type=checkbox]').length === 2");
    const facts = await dialogText(page);
    assert.match(facts, /1280×720 · 30 fps/);
    assert.match(facts, /720p30 · 1800 kbps[\s\S]*480p30 · 900 kbps/);
    assert.match(facts, /no audio/);
    assert.equal(await page.evaluate("[...document.querySelectorAll('dialog[open] select')].every((s) => s.disabled) && document.querySelector('dialog[open] select').closest('div').hidden"), true, 'no audio choice for a silent video');

    const before = (await dialogText(page)).match(/About ([\d.]+) ([KMB]+)/)[0];
    await page.evaluate("(() => { const c = document.querySelector('dialog[open] input[type=checkbox][value=\"720\"]'); c.checked = false; c.dispatchEvent(new Event('change')); })()");
    assert.notEqual((await dialogText(page)).match(/About ([\d.]+) ([KMB]+)/)[0], before, 'the estimate follows the choice');
    await clickText(page, 'dialog button', 'Encode and review');
    await until(page, "document.querySelector('dialog[open]').innerText.includes('Ready to create dock-at-dawn/v1')", 240000);
    const review = await dialogText(page);
    assert.match(review, /Encoded in your browser from 1280×720 at 30 fps: 480p30\./);
    assert.ok(review.includes('videos/dock-at-dawn/480p30/index.m3u8') && !review.includes('720p30'), 'only the chosen rung');

    // Back returns to the choice, which starts again
    await clickText(page, 'dialog button', 'Back');
    await until(page, "document.querySelector('dialog[open] input[type=file]')");
  } finally {
    chrome.close();
    web.close();
  }
});

test('video: a browser that cannot decode AAC is told so when the file is picked, and the audio defaults to dropped', { skip, timeout: 300000 }, async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'blog-vid-aac-'));
  const src = path.join(work, 'talk.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const video = (await readFile(src)).toString('base64');
  const copy = await site();
  const web = await serve(copy);
  const chrome = await launch();
  const base = `http://127.0.0.1:${web.address().port}`;
  try {
    const page = await openPage(chrome, `${base}/index.html`);
    await until(page, "document.querySelector('#top button')");
    await page.evaluate(`(async () => { ${INSTALL} })()`);
    await clickText(page, '#top button', 'Sign in');
    await page.evaluate("document.querySelector('dialog input[name=token]').value = 'github_pat_' + 'b'.repeat(30); 0");
    await clickText(page, 'dialog button', 'Sign in');
    await until(page, "document.querySelector('#top').innerText.includes('Signed in as tester')");
    // a browser that cannot do AAC (the VS Code / Electron browser can encode it but not decode it; both end the same way)
    await page.evaluate("AudioEncoder.isConfigSupported = async () => ({ supported: false }); 0");
    await page.evaluate("location.hash = '#repo=example/blog&new'; 0");
    await until(page, "document.querySelector('.ql-editor')");
    await page.evaluate("document.querySelector('.ql-video').click(); 0");
    await until(page, "document.querySelector('dialog[open]')");
    await clickText(page, 'dialog button', 'Upload a video');
    await until(page, "document.querySelector('dialog[open] input[type=file]')");

    // before a file is picked there is no audio choice to see
    assert.equal(await page.evaluate("document.querySelector('dialog[open] select').closest('div').hidden"), true);

    await pick(page, 'talk.mp4', video);
    await until(page, "document.querySelector('dialog[open] input[placeholder^=\"release name\"]').value === 'talk'");
    const text = await dialogText(page);
    assert.match(text, /This browser cannot keep this video's audio: this browser cannot encode AAC-LC.*desktop Chrome or Edge\./);
    assert.equal((text.match(/desktop Chrome/g) || []).length, 1, 'the advice is given once');
    assert.equal(await page.evaluate("document.querySelector('dialog[open] select').value"), 'drop');

    // encoding then works, without the audio, instead of failing after the work is done
    await page.evaluate("(() => { const i = document.querySelector('dialog[open] input[placeholder^=\"release name\"]'); i.value = 'quiet-talk'; i.dispatchEvent(new Event('input')); })()");
    await clickText(page, 'dialog button', 'Encode and review');
    await until(page, "document.querySelector('dialog[open]').innerText.includes('Ready to create quiet-talk/v1')", 240000);
    const review = await dialogText(page);
    assert.ok(!review.includes('/audio/'), 'no audio rendition');
    assert.ok(review.includes('videos/quiet-talk/360p30/index.m3u8'));
  } finally {
    chrome.close();
    web.close();
  }
});

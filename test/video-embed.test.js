// R2: a video post is an embed of a render that hls.webcli.app already published, and a post restates none of the render's facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSite, parsePost, validateBlog } from '../lib/blog.js';
import { RENDER_FIELDS } from '../lib/frontmatter.js';
import { videoEmbedUrl } from '../lib/video.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const blogJson = (extra = {}) => ({
  title: 'T', description: 'D', author: 'Ada', domain: 'https://example.test', repo: 'me/blog',
  video: { player: 'https://player.example/', base: 'https://cdn.example/{owner}/{repo}/{tag}/{slug}/', repos: { videos: 'me/renders' } },
  ...extra,
});
const post = (body, extra = '') => ({ path: 'posts/clip.md', text: `---\nslug: clip\ntitle: Clip\ndate: 2026-01-01\nstatus: published\n${extra}---\n\n${body}\n` });

test('R2: a video post is a sandboxed player embed of a published render, pinned by its tag', () => {
  const r = buildSite({ blog: blogJson(), posts: [post('Before.\n\n![](video:videos/clip@v2)\n\nAfter.')], lock: {} });
  assert.deepEqual(r.errors.map((e) => e.message), []);
  const html = r.files['clip/index.html'];
  const frame = /<iframe [^>]*>/.exec(html)[0];
  assert.match(frame, /sandbox="allow-scripts"/);
  assert.ok(!/allow-same-origin/.test(html), 'an opaque origin: no page, no token, no storage');
  assert.match(frame, /referrerpolicy="no-referrer"/);
  assert.match(frame, /src="https:\/\/player\.example\/#https:\/\/cdn\.example\/me\/renders\/clip\/v2\/clip\/&amp;present=true"/);
  assert.equal(videoEmbedUrl('video:videos/clip@v2', validateBlog(JSON.stringify(blogJson()))), 'https://player.example/#https://cdn.example/me/renders/clip/v2/clip/&present=true');
  assert.ok(html.includes('<noscript') || /<a [^>]*href="https:\/\/player\.example/.test(html) || html.includes('Video:'), 'the link inside the frame is the fallback with scripting off');
  // what the page holds about the video is its address and nothing else
  assert.ok(!/render\.json|master\.m3u8/.test(html.replace(/https:\/\/cdn\.example[^"]*/g, '')));
});

test('R2: a post restates none of a render\'s facts: each is refused, with the reason', () => {
  for (const k of RENDER_FIELDS) {
    const e = (() => { try { parsePost(post('![](video:videos/clip@v1)', `${k}: 62\n`)); return null; } catch (err) { return err; } })();
    assert.ok(e && e.code === 'bad-frontmatter' && /render\.json/.test(e.detail), `${k} is refused`);
  }
  // the fields a post does own are untouched
  assert.doesNotThrow(() => parsePost(post('![](video:videos/clip@v1)', 'tags: [a, b]\ncover: auto\n')));
});

test('R1: there is no encoder in the blog app', async () => {
  const vendor = await fs.readdir(path.join(root, 'vendor'));
  assert.ok(!vendor.includes('hls'), 'vendor/hls is gone');
  await assert.rejects(fs.access(path.join(root, 'app', 'encode.js')), 'app/encode.js is gone');
  for (const dir of ['app', 'lib', 'cli', 'blog']) {
    for (const f of await fs.readdir(path.join(root, dir))) {
      if (!/\.m?js$/.test(f) || /-source\.js$/.test(f)) continue;
      const src = await fs.readFile(path.join(root, dir, f), 'utf8');
      assert.ok(!/vendor\/hls|VideoEncoder|transcodeLadder|WebCodecs/.test(src), `${dir}/${f} reaches for an encoder`);
    }
  }
});

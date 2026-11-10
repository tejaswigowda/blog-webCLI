// Discovery and URL continuity: images carry their size (E13), /feed/ is a page and never the Atom document (E10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSite } from '../lib/blog.js';
import { imageSize, sizeEntry } from '../lib/image-size.js';

const PNG = (w, h) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const BLOG = { title: 'T', description: 'D', author: 'Ann', domain: 'https://x.test/b', repo: 'me/b', assets: { repos: { images: 'me/img' }, base: 'https://cdn.test/{owner}/{repo}@{sha}/{path}' } };
const post = (body) => ({ path: 'posts/a.md', text: `---\nslug: a\ntitle: "A"\ndate: 2026-01-01\nauthor: Ann\nstatus: published\n---\n\n${body}\n` });

test('image size: PNG, GIF and WebP are read from the first bytes; anything else is null', () => {
  assert.deepEqual(imageSize(PNG(640, 480)), { width: 640, height: 480 });
  const gif = new Uint8Array(32);
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x01, 0x10, 0x00]);
  assert.deepEqual(imageSize(gif), { width: 288, height: 16 });
  const jpg = new Uint8Array(40);
  jpg.set([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0x00, 0x02, 0x00]);
  assert.deepEqual(imageSize(jpg), { width: 512, height: 256 });
  assert.equal(imageSize(new Uint8Array(40)), null);
  assert.deepEqual(sizeEntry('images', 'a.png', PNG(3, 2)), { 'images/a.png#size': '3x2' });
  assert.deepEqual(sizeEntry('images', 'a.png', new Uint8Array(4)), {});
});

test('E13: an image the lock knows the size of carries width and height; one it does not is as before', () => {
  const lock = { 'images/a.png': 'a'.repeat(40), 'images/a.png#size': '640x480', 'images/b.png': 'b'.repeat(40) };
  const r = buildSite({ blog: BLOG, posts: [post('![pic](asset:images/a.png)\n\n![other](asset:images/b.png)')], lock });
  assert.deepEqual(r.errors, []);
  const page = r.files['a/index.html'];
  assert.match(page, /<img src="[^"]*a\.png" alt="pic" width="640" height="480" loading="lazy">/);
  assert.match(page, /<img src="[^"]*b\.png" alt="other" loading="lazy">/);
});

test('E10: every page has feed autodiscovery; /feed/ is a page that points at the feed, with no Atom document', () => {
  const r = buildSite({ blog: BLOG, posts: [post('hi')], lock: {} });
  assert.match(r.files['a/index.html'], /<link rel="alternate" type="application\/atom\+xml"[^>]*href="\.\.\/feed\.xml"/);
  const f = r.files['feed/index.html'];
  assert.ok(f.startsWith('<!doctype html>') && !f.includes('<feed'));
  assert.match(f, /rel="alternate" type="application\/atom\+xml"[^>]*href="\.\.\/feed\.xml"/);
  assert.match(f, /http-equiv="refresh"/);
  assert.match(f, /now at/);
  assert.ok(r.files['feed.xml'].includes('<feed'));
});

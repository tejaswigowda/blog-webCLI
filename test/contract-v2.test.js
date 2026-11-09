import test from 'node:test';
import assert from 'node:assert/strict';
import { indexBody, indexList, postBody, CONTRACT_BUILDERS } from '../lib/contracts.js';
import { pagerHtml } from '../lib/listings.js';
import { deltaToHtml } from '../lib/html.js';
import { mdToDelta } from '../lib/markdown.js';
import { CONTRACTS, validateThemeManifest } from '../lib/theme-pack.js';

const blog = { title: 'B', description: 'd', author: 'A', domain: 'https://example.github.io/b' };
const entry = { slug: 's', title: 'S', date: '2026-01-01', tags: ['t'], excerpt: 'e' };
const idx = { blog, home: '', feed: 'feed.xml', hrefFor: (s) => `${s}/`, entries: [entry], menu: [] };
const post = { blog, meta: { slug: 's', title: 'S', date: '2026-01-01', tags: [] }, bodyHtml: '<p>x</p>', home: '', feed: 'feed.xml', logoUrl: 'logo.png' };
const pg = { n: 2, of: 3, at: 2, stable: false, nav: { prev: { href: '../' }, next: { href: '../3/' } } };

// wordpress-classic-2 is wordpress-classic plus classes a blog can truthfully carry. It is a new name, so that the output of the
// two older contracts stays what it was byte for byte (the blog's pinned themes are written against it).
test('wordpress-classic-2 is a known contract, and takes a skeleton as the classic one does', () => {
  assert.ok(CONTRACTS.includes('wordpress-classic-2'));
  assert.ok(CONTRACT_BUILDERS['wordpress-classic-2']);
  const m = { name: 'T', version: '1', licence: 'GPL-2.0-or-later', class_contract: 'wordpress-classic-2', css: ['style.css'], skeleton: 'skeleton.html' };
  validateThemeManifest(m);
});

test('v2 adds the numbered-pager classes to the links the pager already has, and no other contract changes', () => {
  const v2 = pagerHtml(pg, 'wordpress-classic-2');
  assert.match(v2, /<nav class="navigation pagination posts-navigation"/);
  assert.match(v2, /<a class="prev page-numbers" rel="prev" href="\.\.\/">/);
  assert.match(v2, /<span class="page-numbers current page-of" aria-current="page">Page 2 of 3<\/span>/);
  assert.match(v2, /<a class="next page-numbers" rel="next" href="\.\.\/3\/">/);
  for (const c of ['blog-webcli-v1', 'wordpress-classic', undefined]) {
    const old = pagerHtml(pg, c);
    assert.equal(old, pagerHtml(pg));
    assert.ok(!/page-numbers|posts-navigation/.test(old));
  }
});

test('v2 classes on the entry date, the menu, the logo, a standalone page and an archive heading', () => {
  const c2 = 'wordpress-classic-2';
  assert.match(indexList(c2, idx), /<span class="posted-on post-date">/);
  assert.match(postBody(c2, post).html, /<span class="posted-on post-date">/);
  assert.match(postBody(c2, post).html, /class="custom-logo-link site-logo"/);
  assert.match(postBody(c2, post).html, /class="menu-wrapper menu nav-menu"/);
  assert.match(postBody(c2, { ...post, page: true }).html, /<div class="entry-content page-content">/);
  assert.ok(!/page-content/.test(postBody(c2, post).html));
  const arch = indexBody(c2, { ...idx, heading: 'Tag: t', intro: '1 post' });
  assert.equal(arch.bodyClass, 'archive');
  assert.match(arch.html, /class="archive-description taxonomy-description"/);
  assert.equal(indexBody(c2, idx).bodyClass, 'home blog');
  for (const c of ['wordpress-classic', 'blog-webcli-v1']) {
    const all = indexList(c, idx) + postBody(c, post).html + postBody(c, { ...post, page: true }).html + indexBody(c, { ...idx, heading: 'Tag: t', intro: '1 post' }).html;
    assert.ok(!/post-date|site-logo|nav-menu|page-content|taxonomy-description/.test(all), c);
  }
  assert.equal(indexBody('wordpress-classic', { ...idx, heading: 'Tag: t' }).bodyClass, 'home blog'); // unchanged, as pinned themes expect
});

test('v2 is wordpress-classic with only classes added', () => {
  const strip = (h) => h.replace(/ (site-logo|nav-menu|post-date|taxonomy-description|page-content)(?=")/g, '');
  assert.equal(strip(postBody('wordpress-classic-2', post).html), postBody('wordpress-classic', post).html);
  assert.equal(strip(postBody('wordpress-classic-2', { ...post, page: true }).html), postBody('wordpress-classic', { ...post, page: true }).html);
  assert.equal(strip(indexList('wordpress-classic-2', idx)), indexList('wordpress-classic', idx));
});

test('blocks render for the classic family under either name', () => {
  const delta = mdToDelta('| a |\n| --- |\n| b |\n');
  const out = deltaToHtml(delta, { contract: 'wordpress-classic-2' });
  assert.match(out, /^<figure class="wp-block-table">/);
  assert.equal(out, deltaToHtml(delta, { contract: 'wordpress-classic' }));
});

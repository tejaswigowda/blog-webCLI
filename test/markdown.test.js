import test from 'node:test';
import assert from 'node:assert/strict';
import { corpus } from './helpers.js';
import { mdToDelta, deltaToMd, deltaToMarkdownChecked } from '../lib/markdown.js';
import { deltaEqual, canon } from '../lib/delta.js';
import { splitFile, joinFile } from '../lib/frontmatter.js';
import { Refusal } from '../lib/errors.js';

test('B2: md -> Delta -> md is byte-identical for every post in the corpus', async () => {
  const posts = await corpus();
  assert.ok(posts.length >= 6);
  for (const { name, text } of posts) {
    const { front, body } = splitFile(text, name);
    const out = joinFile(front, deltaToMd(mdToDelta(body)));
    assert.equal(out, text, `${name} did not round-trip`);
  }
});

test('Delta -> md -> Delta is stable too (second leg of the loop)', async () => {
  for (const { name, text } of await corpus()) {
    const d1 = mdToDelta(splitFile(text, name).body);
    const d2 = mdToDelta(deltaToMd(d1));
    assert.deepEqual(canon(d1.ops), canon(d2.ops), name);
  }
});

test('parser yields the Delta Quill would hold', () => {
  const d = mdToDelta('## Hi\n\nA **b** _i_ [l](http://x.y)\n\n- a\n    - b\n');
  assert.deepEqual(d.ops, [
    { insert: 'Hi' },
    { insert: '\n', attributes: { header: 2 } },
    { insert: 'A ' },
    { insert: 'b', attributes: { bold: true } },
    { insert: ' ' },
    { insert: 'i', attributes: { italic: true } },
    { insert: ' ' },
    { insert: 'l', attributes: { link: 'http://x.y' } },
    { insert: '\na' },
    { insert: '\n', attributes: { list: 'bullet' } },
    { insert: 'b' },
    { insert: '\n', attributes: { list: 'bullet', indent: 1 } },
  ]);
});

test('video: a standalone reference is a block embed with no trailing newline', () => {
  const d = mdToDelta('Hi\n\n![](video:videos/clip@v1)\n\nBye\n');
  assert.deepEqual(d.ops, [{ insert: 'Hi\n' }, { insert: { video: 'video:videos/clip@v1' } }, { insert: 'Bye\n' }]);
  assert.equal(deltaToMd(d), 'Hi\n\n![](video:videos/clip@v1)\n\nBye\n');
  // what Quill 2 emits for the same document
  assert.equal(deltaToMarkdownChecked(d).md, 'Hi\n\n![](video:videos/clip@v1)\n\nBye\n');
});

test('non-canonical markdown is detected, not silently rewritten', () => {
  for (const md of ['* star bullet\n', 'wrapped\nline\n', 'no trailing newline', '<b>html</b>  \n', '| a | b |\n|---|---|\n', '#### four\n', '- a\n\n- b\n', 'x\n![](video:videos/clip@v1)\n', '![](video:videos/clip@v1)\ny\n']) {
    assert.notEqual(deltaToMd(mdToDelta(md)), md, JSON.stringify(md));
  }
});

test('lossy-round-trip: unsupported formatting is refused with the right code', () => {
  const bad = [
    [{ insert: 'x', attributes: { color: '#f00' } }, { insert: '\n' }],
    [{ insert: 'x', attributes: { underline: true } }, { insert: '\n' }],
    [{ insert: { video: 'https://example.com/v' } }, { insert: '\n' }],
    [{ insert: 'x' }, { insert: '\n', attributes: { align: 'center' } }],
  ];
  for (const ops of bad) {
    assert.throws(() => deltaToMarkdownChecked({ ops }), (e) => e instanceof Refusal && e.code === 'lossy-round-trip');
  }
  assert.throws(() => deltaToMarkdownChecked({ ops: [{ insert: 'a`b', attributes: { code: true } }, { insert: '\n' }] }), (e) => e.code === 'lossy-round-trip');
  assert.throws(() => deltaToMarkdownChecked({ ops: [{ insert: 'x', attributes: { link: 'http://a b' } }, { insert: '\n' }] }), (e) => e.code === 'lossy-round-trip');
});

test('editor normalisation: empty paragraphs and edge whitespace are not formatting', () => {
  const { md } = deltaToMarkdownChecked({
    ops: [
      { insert: 'a ', attributes: { bold: true } },
      { insert: 'b\n\n\n' },
      { insert: '  c  \n' },
    ],
  });
  assert.equal(md, '**a** b\n\nc\n');
});

// ---- fuzz: any Delta the toolbar can produce survives the round trip ----
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const WORDS = ['alpha', 'snake_case', 'x*y', '~tilde', 'a_b_', '[br]', '<tag>', '#hash', '1.', '-', '+', '>', '`tick`', 'back\\slash', '&amp;', 'café', 'http://a.b/c_d', '_', '**', '~~', '!', '(', ')', '|'];

function randomDelta(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const ops = [];
  const nLines = 1 + Math.floor(r() * 8);
  for (let l = 0; l < nLines; l++) {
    const kind = pick(['p', 'p', 'p', 'h', 'q', 'ul', 'ol', 'code', 'video']);
    if (kind === 'video') {
      ops.push({ insert: { video: `video:videos/${pick(['a', 'b-c', 'x+y'])}@v${1 + Math.floor(r() * 9)}` } });
      continue;
    }
    const nRuns = kind === 'code' ? 1 : 1 + Math.floor(r() * 4);
    for (let i = 0; i < nRuns; i++) {
      const text = Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(WORDS)).join(' ');
      if (kind === 'code') {
        ops.push({ insert: text });
        continue;
      }
      const attrs = {};
      if (r() < 0.3) attrs.bold = true;
      if (r() < 0.3) attrs.italic = true;
      if (r() < 0.15) attrs.strike = true;
      if (r() < 0.15) attrs.code = true;
      if (r() < 0.2) attrs.link = pick(['https://example.com/x', '../rel/', 'asset:images/a.png']);
      ops.push(Object.keys(attrs).length ? { insert: text, attributes: attrs } : { insert: text });
      if (r() < 0.1) ops.push({ insert: { image: 'asset:images/p.png' }, attributes: r() < 0.5 ? { alt: pick(['a [b]', 'plain']) } : {} });
    }
    const nl = { insert: '\n' };
    if (kind === 'h') nl.attributes = { header: 1 + Math.floor(r() * 3) };
    if (kind === 'q') nl.attributes = { blockquote: true };
    if (kind === 'ul' || kind === 'ol') nl.attributes = { list: kind === 'ul' ? 'bullet' : 'ordered', ...(r() < 0.4 ? { indent: 1 + Math.floor(r() * 2) } : {}) };
    if (kind === 'code') nl.attributes = { 'code-block': r() < 0.5 ? true : 'js' };
    ops.push(nl);
  }
  return { ops };
}

test('fuzz: normalised editor Deltas round-trip losslessly or are refused — never altered', () => {
  const r = rng(20261105);
  let ok = 0;
  let refused = 0;
  for (let n = 0; n < 3000; n++) {
    const d = randomDelta(r);
    try {
      const { md, delta } = deltaToMarkdownChecked(d);
      // what the editor will show after save is exactly what md parses back to
      assert.ok(deltaEqual(mdToDelta(md).ops, delta.ops));
      assert.equal(deltaToMd(mdToDelta(md)), md, 'markdown is a fixed point');
      ok++;
    } catch (e) {
      if (!(e instanceof Refusal) || e.code !== 'lossy-round-trip') throw e;
      refused++;
    }
  }
  assert.ok(ok > 1500, `too many refusals: ${refused} of 3000`);
});

test('fuzz: markdown is a fixed point after one normalisation', () => {
  const r = rng(7);
  for (let n = 0; n < 1000; n++) {
    let md;
    try {
      md = deltaToMarkdownChecked(randomDelta(r)).md;
    } catch {
      continue;
    }
    assert.equal(deltaToMd(mdToDelta(md)), md);
  }
});

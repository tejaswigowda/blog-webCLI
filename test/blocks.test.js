// Tables and raw HTML blocks in the markdown subset. Both are Delta block embeds ({ mdtable }, { htmlblock }) that round-trip
// byte for byte (B2), render through the one shared renderer, and, for HTML, are held to an allowlist and re-serialised.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSite } from '../lib/blog.js';
import { deltaToHtml, excerpt, plainLines, wordCount } from '../lib/html.js';
import { canonCell, deltaToMarkdownChecked, deltaToMd, mdRoundTrips, mdToDelta } from '../lib/markdown.js';
import { checkHtmlBlock, renderHtmlBlock } from '../lib/rawhtml.js';
import { collectAssetRefs } from '../lib/assets.js';
import { Refusal } from '../lib/errors.js';
import { stripData } from './helpers.js';

const rt = (md) => deltaToMd(mdToDelta(md));
const html = (md, opts = {}) => deltaToHtml(mdToDelta(md), { resolve: (r) => `https://cdn.test/${r.slice(6)}`, resolveVideo: (r) => r, ...opts });
const code = (c) => (e) => e instanceof Refusal && e.code === c;

// ---------- tables ----------
const TABLE = '| Name | Value | Note |\n| --- | ---: | :---: |\n| a | **1** | _x_ |\n| b \\| c | [t](https://e.com) | `k` |\n';

test('tables: a canonical table is a fixed point of md -> Delta -> md', () => {
  assert.equal(rt(TABLE), TABLE);
  assert.equal(mdRoundTrips(TABLE).ok, true);
  const d = mdToDelta(TABLE);
  assert.deepEqual(d.ops, [{ insert: { mdtable: {
    head: ['Name', 'Value', 'Note'], align: ['', 'right', 'center'],
    rows: [['a', '**1**', '_x_'], ['b | c', '[t](https://e.com)', '`k`']],
  } } }]);
});

test('tables: one column, no body rows, empty cells, every alignment, surrounded by other blocks', () => {
  for (const md of [
    '| a |\n| --- |\n| 1 |\n', '| a | b |\n| --- | --- |\n', '|  |  |\n| --- | --- |\n|  | x |\n', '| l | r | c | n |\n| :--- | ---: | :---: | --- |\n| 1 | 2 | 3 | 4 |\n',
    'Before.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter.\n', '## Head\n\n| a |\n| --- |\n| 1 |\n\n- item\n\n| b |\n| --- |\n| 2 |\n',
  ]) assert.equal(rt(md), md, JSON.stringify(md));
});

test('tables: what is not canonical is read, and canonical once rewritten (fmt), never altered in meaning', () => {
  const loose = 'a | b\n:-- | --:\n1 | 2 |\n| short\n';
  assert.equal(mdRoundTrips(loose).ok, false);
  assert.equal(mdRoundTrips(loose).out, '| a | b |\n| :--- | ---: |\n| 1 | 2 |\n| short |  |\n');
  assert.equal(mdRoundTrips(mdRoundTrips(loose).out).ok, true);
  assert.equal(mdRoundTrips('|a|b|\n|-|-|\n|1|2|\n').out, '| a | b |\n| --- | --- |\n| 1 | 2 |\n');
});

test('tables: a row with more cells than the header is refused, not truncated; a lone pipe line is a paragraph', () => {
  assert.throws(() => mdToDelta('| a |\n| --- |\n| 1 | 2 |\n'), code('lossy-round-trip'));
  for (const md of ['| a | b |\n', '| a | b |\nplain text\n', 'a | b\n', '| a |\n| --- | --- |\n']) assert.ok(!mdToDelta(md).ops.some((o) => o.insert && o.insert.mdtable), JSON.stringify(md));
});

test('tables: a table cannot swallow the paragraph that follows with no blank line, and a paragraph cannot hide one', () => {
  const d = mdToDelta('| a |\n| --- |\n| 1 |\nafter\n');
  assert.equal(d.ops.filter((o) => o.insert.mdtable).length, 1);
  assert.equal(d.ops[1].insert, 'after\n');
  const e = mdToDelta('text line\n| a | b |\n| --- | --- |\n');
  assert.equal(e.ops[0].insert, 'text line\n');
  assert.ok(e.ops[1].insert.mdtable);
});

test('tables: cells are inline markdown, so a pipe, a backslash and markup in text all survive', () => {
  for (const cell of ['plain', 'a | b', 'a \\ b', 'x\\|y', '**b** and _i_ and ~~s~~', '`a|b`', '![alt](asset:images/a.png)', '[l](https://e.com/a_b)', 'snake_case_word', '1 < 2 & 3 > 2', '日本語 🎉', '# not a heading', '- not a list', '\\*literal\\*']) {
    const md = `| h |\n| --- |\n| ${canonCell(cell).replace(/\|/g, '\\|')} |\n`;
    assert.equal(rt(md), md, cell);
  }
});

test('tables: the editor path canonicalises cells (a typed "a*b" is text) and the round trip is proved', () => {
  const t = { head: ['  Name ', 'a*b'], align: ['', 'left'], rows: [['x', ' **y** ']] };
  const { md, delta } = deltaToMarkdownChecked({ ops: [{ insert: { mdtable: t } }, { insert: '\n' }] });
  assert.equal(md, '| Name | a\\*b |\n| --- | :--- |\n| x | **y** |\n');
  assert.equal(deltaToMd(delta), md);
  for (const bad of [{ head: [], align: [], rows: [] }, { head: ['a'], align: ['x'], rows: [] }, { head: ['a'], align: [''], rows: [['1', '2']] }, { head: ['a\nb'], align: [''], rows: [] }]) {
    assert.throws(() => deltaToMarkdownChecked({ ops: [{ insert: { mdtable: bad } }, { insert: '\n' }] }), code('lossy-round-trip'), JSON.stringify(bad));
  }
});

test('tables: rendered as a real table, with alignment on the cell and the cell\'s markup inside', () => {
  const out = html(TABLE);
  assert.equal(out, '<table><thead><tr><th>Name</th><th align="right">Value</th><th align="center">Note</th></tr></thead><tbody>'
    + '<tr><td>a</td><td align="right"><strong>1</strong></td><td align="center"><em>x</em></td></tr>'
    + '<tr><td>b | c</td><td align="right"><a href="https://e.com" rel="noopener noreferrer">t</a></td><td align="center"><code>k</code></td></tr></tbody></table>');
  assert.equal(html('| a |\n| --- |\n'), '<table><thead><tr><th>a</th></tr></thead></table>');
  assert.match(html(TABLE, { contract: 'wordpress-classic' }), /^<figure class="wp-block-table"><table>/);
  // markup in a cell is text: nothing typed there becomes a tag
  assert.equal(html('| <b>x</b> |\n| --- |\n| <script>1</script> |\n').includes('<script'), false);
});

test('tables: an asset in a cell is pinned like any image, and an unresolved one is refused', () => {
  const md = '| pic |\n| --- |\n| ![a](asset:images/a.png) |\n';
  assert.deepEqual(collectAssetRefs(mdToDelta(md)), ['asset:images/a.png']);
  assert.match(html(md), /<td><img src="https:\/\/cdn\.test\/images\/a\.png" alt="a" loading="lazy"><\/td>/);
  assert.throws(() => html(md, { resolve: () => { throw new Refusal('unresolved-asset', 'x'); } }), code('unresolved-asset'));
  assert.throws(() => html('| a |\n| --- |\n| [x](javascript:x) |\n'), code('unsafe-url'));
});

test('tables: their words count, are searchable, and never become the excerpt', () => {
  const d = mdToDelta('| Name | Price |\n| --- | --- |\n| Apple | 3 |\n\nThe real first paragraph.\n');
  assert.equal(wordCount(d), 4 + 4);
  assert.ok(plainLines(d).some((l) => l.text === 'Name Price Apple 3' && l.embed));
  assert.equal(excerpt(d), 'The real first paragraph.');
});

// ---------- raw HTML ----------
const GOOD = '<div class="note" id="n1">\n<p>Hello <b>there</b> &amp; <a href="https://e.com/x?a=1&amp;b=2">link</a></p>\n<ul><li>one</li><li>two</li></ul>\n</div>\n';

test('html: a block that starts with a tag runs to the blank line, and is a fixed point', () => {
  const d = mdToDelta(GOOD);
  assert.deepEqual(d.ops, [{ insert: { htmlblock: GOOD.trimEnd() } }]);
  assert.equal(rt(GOOD), GOOD);
  for (const md of ['<hr>\n', 'a\n\n<details>\n<summary>More</summary>\nbody\n</details>\n\nz\n', '<!-- a note -->\n', '<table>\n<tr><td colspan="2">x</td></tr>\n</table>\n', '<p>one</p>\n\n<p>two</p>\n']) assert.equal(rt(md), md, JSON.stringify(md));
  assert.equal(mdToDelta('<p>one</p>\n\n<p>two</p>\n').ops.length, 2, 'a blank line ends a block');
});

test('html: it interrupts a paragraph, and trailing space is not canonical', () => {
  const d = mdToDelta('text\n<div>x</div>\n');
  assert.equal(d.ops[0].insert, 'text\n');
  assert.ok(d.ops[1].insert.htmlblock);
  assert.equal(mdRoundTrips('<p>x</p>  \n').ok, false);
  assert.equal(mdRoundTrips('<p>x</p>  \n').out, '<p>x</p>\n');
});

test('html: the editor path removes blank lines (they would end the block) and refuses a <pre> that depends on them', () => {
  const { md } = deltaToMarkdownChecked({ ops: [{ insert: { htmlblock: '\n<div>\n\n<p>x</p>\n\n</div>\n\n' } }, { insert: '\n' }] });
  assert.equal(md, '<div>\n<p>x</p>\n</div>\n');
  assert.throws(() => deltaToMarkdownChecked({ ops: [{ insert: { htmlblock: '<pre>a\n\nb</pre>' } }, { insert: '\n' }] }), code('bad-html'));
});

test('html: rendered from tokens: lower-cased, re-escaped, comments dropped, links hardened, images lazy', () => {
  const out = html('<DIV CLASS=note>\n<!-- hidden -->\n<A HREF="https://e.com/?a=1&amp;b=2">x &lt; y & z</A><IMG SRC="asset:images/a.png" alt=\'a "b"\'>\n</DIV>\n');
  assert.equal(out, '<div class="note">\n\n<a href="https://e.com/?a=1&amp;b=2" rel="noopener noreferrer">x &lt; y &amp; z</a><img src="https://cdn.test/images/a.png" alt="a &quot;b&quot;" loading="lazy">\n</div>');
  assert.equal(html('<details open>\n<summary>s</summary>\nb\n</details>\n'), '<details open>\n<summary>s</summary>\nb\n</details>');
});

const REFUSED = [
  ['script', '<script>alert(1)</script>'], ['script src', '<script src="https://evil.test/x.js"></script>'], ['style tag', '<style>a{}</style>'],
  ['iframe', '<iframe src="https://e.com"></iframe>'], ['object', '<object data="x"></object>'], ['embed', '<embed src="x">'], ['svg', '<svg onload="x()"></svg>'],
  ['form', '<form action="/x"><input></form>'], ['link', '<link rel="stylesheet" href="x.css">'], ['meta refresh', '<meta http-equiv="refresh" content="0;url=x">'],
  ['base', '<base href="https://evil.test/">'], ['video', '<video src="x"></video>'], ['math', '<math></math>'], ['template', '<template></template>'],
  ['onclick', '<div onclick="x()">a</div>'], ['onerror', '<img src="a.png" onerror="x()">'], ['uppercase handler', '<div ONMOUSEOVER=x()>a</div>'],
  ['style attr', '<p style="color:red">a</p>'], ['srcdoc', '<div srcdoc="x">a</div>'], ['formaction', '<a formaction="x">a</a>'], ['data attr', '<div data-x="1">a</div>'],
  ['javascript href', '<a href="javascript:alert(1)">x</a>'], ['mixed case', '<a href="JaVaScRiPt:alert(1)">x</a>'], ['entity scheme', '<a href="java&#115;cript:alert(1)">x</a>'],
  ['hex entity', '<a href="&#x6A;avascript:alert(1)">x</a>'], ['tab in scheme', '<a href="java&#9;script:alert(1)">x</a>'], ['newline in scheme', '<a href="java\nscript:alert(1)">x</a>'],
  ['leading space', '<a href=" javascript:alert(1)">x</a>'], ['data url', '<img src="data:image/svg+xml,<svg onload=x>">'], ['data href', '<a href="data:text/html,x">x</a>'],
  ['vbscript', '<a href="vbscript:x">x</a>'], ['ftp', '<a href="ftp://e.com">x</a>'], ['mailto on img', '<img src="mailto:a@b.c">'], ['named entity in url', '<a href="https://e.com/&bogus;">x</a>'],
  ['unclosed', '<div><p>x</p>'], ['stray close', '</div>'], ['misnested', '<b><i>x</b></i>'], ['self-closed div', '<div/>'], ['stray lt', '<p>1 < 2</p>'], ['unterminated tag', '<div class="a"'],
  ['unterminated comment', '<!-- x'], ['unquoted junk', '<p "x">a</p>'], ['duplicate attr', '<p class="a" class="b">x</p>'], ['no value', '<a href>x</a>'], ['bad class', '<p class="a&quot;b">x</p>'],
  ['bad id', '<p id="1a">x</p>'], ['img no src', '<img alt="x">'], ['too deep', `${'<div>'.repeat(30)}${'</div>'.repeat(30)}`], ['huge', `<p>${'x'.repeat(50001)}</p>`],
  ['colspan junk', '<td colspan="a">x</td>'], ['td attr on p', '<p colspan="2">x</p>'], ['ol type', '<ol type="x"></ol>'],
];
test('html: every tag, attribute and address that could run, load, submit or restyle is refused, with a reason', () => {
  for (const [what, src] of REFUSED) {
    assert.throws(() => checkHtmlBlock(src), (e) => e instanceof Refusal && e.code === 'bad-html' && e.detail.length > 8, what);
    assert.throws(() => html(src), code('bad-html'), `${what} is refused at render`);
  }
});

test('html: whatever is accepted renders with nothing executable, whatever it is mutated into', () => {
  const seeds = [GOOD, '<table><tr><td align="left" colspan="2">a<br>b</td></tr></table>', '<a href="/x#y" title="t &amp; u">z</a>', '<ol start="3" reversed><li value="9">x</li></ol>', '<p lang="fr" dir="rtl">x</p>'];
  const muts = [(s) => s, (s) => s.toUpperCase(), (s) => s.replace(/</g, '<\u0000'), (s) => s.replace(/"/g, "'"), (s) => s.replace(/ /g, '\t'), (s) => s.replace(/>/g, ' >'), (s) => s.replace(/=/g, ' = '), (s) => `${s}<script>x()</script>`, (s) => s.replace('<', '<img onerror=x() src=a>')];
  let accepted = 0;
  for (const seed of seeds) {
    for (const m of muts) {
      let out;
      try {
        out = renderHtmlBlock(m(seed), { resolve: (r) => `https://cdn.test/${r}` });
      } catch (e) {
        assert.ok(e instanceof Refusal, 'only a refusal');
        continue;
      }
      accepted++;
      assert.doesNotMatch(out, /<\s*(script|style|iframe|object|embed|svg|form|link|meta|base)\b/i);
      assert.doesNotMatch(out, /\son[a-z]+\s*=/i);
      assert.doesNotMatch(out, /javascript:|vbscript:|data:text/i);
      assert.doesNotMatch(out, /\sstyle\s*=/i);
      // every tag in the output is one of the allowlist, and nothing but & entities and text lies between
      assert.doesNotMatch(out.replace(/<\/?[a-z][a-z0-9]*(?:\s+[\w-]+(?:="[^"<>]*")?)*\s*>/gi, ''), /</, 'nothing but whole tags contains a <');
    }
  }
  assert.ok(accepted >= 6, `${accepted} mutants were accepted and checked`);
});

test('html: addresses are pinned and checked like the ones in paragraphs; the words are counted and searchable', () => {
  const d = mdToDelta('<div><img src="asset:images/a.png" alt="a"><a href="asset:files/x.pdf">get</a><a href="https://e.com">e</a></div>\n');
  assert.deepEqual(collectAssetRefs(d), ['asset:files/x.pdf', 'asset:images/a.png']);
  const t = mdToDelta('<p>Some <b>bold</b> words &amp; more</p>\n\nParagraph.\n');
  assert.equal(wordCount(t), 5 + 1);
  assert.equal(plainLines(t)[0].text, 'Some bold words & more');
  assert.equal(excerpt(t), 'Paragraph.');
});

// ---------- in a build ----------
const post = (body, o = '') => ({ path: 'posts/post-one.md', text: `---\nslug: post-one\ntitle: P\ndate: 2026-01-01\nstatus: published\n${o}---\n\n${body}` });
const BLOG = { title: 'T', description: 'D', author: 'A', domain: 'https://example.test/blog', repo: 'me/blog', assets: { base: 'https://cdn.example/{owner}/{repo}@{sha}/{path}', repos: { images: 'me/images' } } };
const SHA = 'a'.repeat(40);
const lock = { 'images/a.png': SHA };

test('a build with a table and an HTML block: both on the page, pinned, in the search text, and no script runs', () => {
  const body = `${TABLE.replace('| a |', '| ![x](asset:images/a.png) |')}\n<div class="note">\n<p>Hi <a href="https://e.com">there</a></p>\n</div>\n`;
  const r = buildSite({ blog: { ...BLOG, search: true }, posts: [post(body)], lock });
  assert.deepEqual(r.errors, []);
  const page = r.files['post-one/index.html'];
  assert.match(page, /<table><thead>/);
  assert.ok(page.includes(`https://cdn.example/me/images@${SHA}/a.png`));
  assert.match(page, /<div class="note">\n<p>Hi <a href="https:\/\/e\.com" rel="noopener noreferrer">there<\/a><\/p>\n<\/div>/);
  assert.doesNotMatch(stripData(page), /<script|\son[a-z]+=/i);
  assert.match(r.files['search.json'], /Name Value Note/);
  assert.match(r.files['search.json'], /Hi there/);
});

test('a build refuses what is not allowed, unpinned assets and provider addresses, with the file named', () => {
  const fails = (body, c) => {
    const r = buildSite({ blog: BLOG, posts: [post(body)], lock });
    assert.equal(r.errors.length, 1, body);
    assert.equal(r.errors[0].code, c, body);
    assert.match(String(r.errors[0].where), /posts\/post-one\.md/);
  };
  fails('<script>alert(1)</script>\n', 'bad-html');
  fails('<div onclick="x()">a</div>\n', 'bad-html');
  fails('<img src="asset:images/missing.png" alt="">\n', 'unresolved-asset');
  fails('| a |\n| --- |\n| ![](asset:images/missing.png) |\n', 'unresolved-asset');
  fails('<img src="https://cdn.jsdelivr.net/gh/me/images/a.png" alt="">\n', 'provider-url');
  fails('| a |\n| --- |\n| [x](https://raw.githubusercontent.com/me/x/main/a) |\n', 'provider-url');
});

test('a draft with an HTML block that is not allowed is not a build failure: it is invisible, and refused only when published', () => {
  const draft = { path: 'posts/d.md', text: '---\nslug: d\ntitle: D\ndate: 2026-01-01\nstatus: draft\n---\n\n<script>x()</script>\n' };
  const r = buildSite({ blog: BLOG, posts: [draft, post('ok\n')], lock });
  assert.deepEqual(r.errors, []);
  assert.ok(!r.files['d/index.html']);
});

test('the markdown is the record: no Delta is stored, and a table or block in a post is readable text', () => {
  const body = `${TABLE}\n${GOOD}`;
  const p = post(body);
  assert.doesNotMatch(p.text, /mdtable|htmlblock|"ops"/);
  assert.equal(buildSite({ blog: BLOG, posts: [p], lock }).errors.length, 0);
});

// ---------- fuzz ----------
function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const PIECES = ['a', 'B', '1', '|', '\\', '*', '_', '`', '[', ']', '(', ')', '<', '>', '&', '~', '#', '-', ':', ' ', '日', '🎉', '**x**', '_y_', '[l](https://e.com)', '![i](asset:images/a.png)', '\\|', '&amp;'];

test('fuzz: any table the editor can produce round-trips losslessly or is refused, never altered; the markdown is then a fixed point', () => {
  const r = rng(7);
  const word = () => Array.from({ length: Math.floor(r() * 5) }, () => PIECES[Math.floor(r() * PIECES.length)]).join('');
  let kept = 0;
  for (let n = 0; n < 400; n++) {
    const cols = 1 + Math.floor(r() * 4);
    const t = {
      head: Array.from({ length: cols }, word), align: Array.from({ length: cols }, () => ['', 'left', 'right', 'center'][Math.floor(r() * 4)]),
      rows: Array.from({ length: Math.floor(r() * 4) }, () => Array.from({ length: cols }, word)),
    };
    let out;
    try {
      out = deltaToMarkdownChecked({ ops: [{ insert: { mdtable: t } }, { insert: '\n' }] });
    } catch (e) {
      assert.ok(e instanceof Refusal && e.code === 'lossy-round-trip', `${JSON.stringify(t)}: ${e.message}`);
      continue;
    }
    kept++;
    assert.equal(rt(out.md), out.md, JSON.stringify(t));
    assert.equal(deltaToMd(mdToDelta(out.md)), out.md);
  }
  assert.ok(kept > 150, `${kept} random tables survived the round trip`);
});

test('fuzz: markdown with tables and blocks in any arrangement is a fixed point after one normalisation', () => {
  const r = rng(11);
  const parts = ['para one', '## Head', '- a\n- b', '> quote', '| a | b |\n| --- | :---: |\n| 1 | 2 |', '<div>\n<p>x</p>\n</div>', '```\ncode\n```', '<hr>', '1. one\n2. two'];
  for (let n = 0; n < 300; n++) {
    const md = `${Array.from({ length: 1 + Math.floor(r() * 6) }, () => parts[Math.floor(r() * parts.length)]).join('\n\n')}\n`;
    const once = rt(md);
    assert.equal(rt(once), once, JSON.stringify(md));
  }
});

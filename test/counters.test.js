import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSite, parsePost } from '../lib/blog.js';
import { deltaToMarkdownChecked } from '../lib/markdown.js';
import { counterResolver, parseCounterDeclarations } from '../lib/counters.js';
import { tokenizeHtml } from '../lib/rawhtml.js';
import { renderFromSite } from '../lib/live-render.js';
import { setCounters, splitFile } from '../lib/frontmatter.js';

const blog = { schemaVersion: 2, minGeneratorVersion: '0.5.1', title: 'Test', description: 'Test', author: 'A', domain: 'https://example.com', search: true };
const front = `---
slug: test
title: Test
date: 2026-01-01
status: published
counters:
  step: { start: 1, style: decimal }
  fig: { start: 2, style: upper-alpha }
---

`;
const body = `## <span class="wc-count-step"></span> One

<h2><span class="wc-count-step"></span> Two</h2>

| Figure | Step |
| --- | --- |
| <span class="wc-count-fig"></span> | <span class="wc-count-step"></span> |

\`\`\`
<span class="wc-count-step"></span>
\`\`\`
`;

test('counters resolve in source order across Markdown, HTML and tables, including search and client', () => {
  const text = front + body;
  const post = parsePost({ path: 'posts/test.md', text }, { counterMode: true });
  assert.equal(post.lossy, null);
  assert.equal(deltaToMarkdownChecked(post.delta, { counters: true }).md, body);
  const built = buildSite({ blog, posts: [{ path: post.path, text }] });
  assert.deepEqual(built.errors, []);
  const html = built.files['test/index.html'];
  assert.match(html, /<span class="wc-count-step">1<\/span> One/);
  assert.match(html, /<span class="wc-count-step">2<\/span> Two/);
  assert.match(html, /<span class="wc-count-fig">B<\/span>/);
  assert.match(html, /<span class="wc-count-step">3<\/span>/);
  assert.match(html, /&lt;span class=&quot;wc-count-step&quot;&gt;&lt;\/span&gt;/);
  assert.match(built.files['search.json'], /1 One\\n2 Two\\nFigure Step B 3/);
  const client = renderFromSite({ blog, lock: {}, index: JSON.parse(built.files['index/posts.json']), records: [] }, { slug: 'test', text });
  assert.equal(client.html.match(/<article>[\s\S]*?<\/article>/)[0], html.match(/<article>[\s\S]*?<\/article>/)[0]);
});

test('counter declarations validate styles, names and older schemas', () => {
  assert.equal(tokenizeHtml('<span class="wc-count-step"></span>').length, 2);
  assert.throws(() => tokenizeHtml('<span class="wc-count-step">1</span>'), /empty span/);
  for (const style of ['decimal', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman']) {
    const definitions = parseCounterDeclarations([`  item: { start: 4, style: ${style} }`]);
    assert.equal(counterResolver(definitions)('item'), { decimal: '4', 'lower-alpha': 'd', 'upper-alpha': 'D', 'lower-roman': 'iv', 'upper-roman': 'IV' }[style]);
  }
  assert.throws(() => parseCounterDeclarations(['  step: { start: 1, style: binary }']), /binary/);
  assert.throws(() => parseCounterDeclarations(['  step: { start: 0, style: decimal }']), /positive/);
  assert.throws(() => parseCounterDeclarations(['  step: { start: 1, style: decimal }', '  step: { start: 1, style: decimal }']), /twice/);
  const missing = buildSite({ blog, posts: [{ path: 'posts/test.md', text: (front + body).replace('wc-count-fig', 'wc-count-typo') }] });
  assert.ok(missing.errors.some((e) => e.code === 'undeclared-counter' && e.message.includes('typo')));
  const old = buildSite({ blog: { ...blog, schemaVersion: 1 }, posts: [{ path: 'posts/test.md', text: front + body }] });
  assert.ok(old.errors.some((e) => e.code === 'unsupported-blog-schema'));
  assert.throws(() => buildSite({ blog: { ...blog, minGeneratorVersion: '0.5.0' }, posts: [] }), /at least 0\.5\.1/);
  assert.throws(() => buildSite({ blog: { ...blog, minGeneratorVersion: '999.0.0' }, posts: [] }), /requires generator/);
  assert.throws(() => parsePost({ path: 'posts/test.md', text: front.replace(/  (?:step|fig):.*\n/g, '') + body }, { counterMode: true }), /declare at least one/);
  assert.throws(() => parseCounterDeclarations(['  step: { start: 1, style: decimal, extra: yes }']), /invalid fields/);
});

test('counter declarations round-trip in front matter', () => {
  const { front: sourceFront } = splitFile(front + body, 'posts/test.md');
  const updated = setCounters(sourceFront, { figure: { start: 4, style: 'lower-roman' } });
  assert.match(updated, /counters:\n  figure: \{ start: 4, style: lower-roman \}\n/);
  assert.doesNotMatch(updated, /  step:/);
  assert.match(setCounters(updated, null), /status: published\n$/);
});

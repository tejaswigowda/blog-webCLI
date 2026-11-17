import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { mdToDelta, deltaToMd, deltaToMarkdownChecked, hasMath } from '../lib/markdown.js';
import { deltaToHtml, plainLines, excerpt, wordCount } from '../lib/html.js';
import { renderMath } from '../lib/math-renderer.js';
import { serializeMathML } from '../lib/mathml.js';
import { MATH_ID, MAX_MATH_LENGTH } from '../lib/math-syntax.js';
import { buildSite } from '../lib/blog.js';
import { loadSite, renderFromSite } from '../lib/live-render.js';
import { checkPage, checkMissing } from '../lib/live.js';
import { splitFile } from '../lib/frontmatter.js';
import { EXAMPLE_BLOG } from '../lib/sample.js';
import { decodeHtml } from '../lib/html-entities.js';
import { TARGETS, bundleInputs } from '../cli/build-live.js';
import { LIVE_SOURCE } from '../lib/live-source.js';
import { MATH_SOURCE } from '../lib/math-source.js';

const source = await readFile(new URL('./corpus/math.md', import.meta.url), 'utf8');
const body = splitFile(source, 'math.md').body;
const post = (body, kind = 'posts', slug = 'math') => ({ path: `${kind}/${slug}.md`, text: `---\nslug: ${slug}\ntitle: Math\n${kind === 'posts' ? 'date: 2026-11-16\n' : ''}status: published\n---\n\n${body}` });
const blog = { ...EXAMPLE_BLOG, search: true };
const encode = (text) => new TextEncoder().encode(text);

test('V4/V5: adversarial math is verbatim in Delta and survives both Markdown round trips', () => {
  const delta = mdToDelta(body);
  assert.equal(deltaToMd(delta), body);
  assert.equal(deltaToMarkdownChecked(delta).md, body);
  const math = delta.ops.filter((op) => op.attributes?.math).map((op) => op.insert);
  assert.deepEqual(math, [String.raw`x_1 + a_{ij}`, String.raw`\alpha^*`, '[a, b)', String.raw`\text{\_ \{ \%}`, '\\text{a`b}', String.raw`\left( x \right)`]);
  const table = '| Value |\n| --- |\n| \\(x_1\\) |\n';
  assert.equal(deltaToMd(mdToDelta(table)), table);
  assert.equal(hasMath(mdToDelta(table)), true);
  assert.match(deltaToHtml(mdToDelta(table)), /<td><math>/);
  for (const md of ['**\\(x_1\\)**\n', '[\\([a,b)\\)](https://example.test/)\n', '\\(  x_1  \\)\n']) {
    assert.equal(deltaToMd(mdToDelta(md)), md);
    assert.equal(deltaToMarkdownChecked(mdToDelta(md)).md, md);
  }
  const html = deltaToHtml(delta);
  assert.equal([...html.matchAll(/<math[\s>]/g)].length, 7);
  assert.equal([...html.matchAll(/<annotation encoding="application\/x-tex">/g)].length, 7);
});

test('V2/V3: delimiters exclude code and HTML, escaped openers are prose, and prices remain currency', () => {
  const literal = 'Literal \\\\( and $30 item and $50 one; $.99 and $.58, or $5 and $.25.\n\n`\\(x_1\\) $x$`\n\n```text\n\\(x_1\\) $$x$$\n```\n\n<p>\\(x\\) $x$</p>\n';
  const delta = mdToDelta(literal);
  assert.equal(deltaToMd(delta), literal);
  assert.equal(hasMath(delta), false);
  assert.doesNotMatch(deltaToHtml(delta), /<math[\s>]/);
  for (const md of ['$x$\n', '$ x $\n', '$$x$$\n', '$30$\n']) {
    assert.throws(() => mdToDelta(md), (e) => e.code === 'dollar-math' && /currency/.test(e.detail));
  }
  for (const text of ['Save $$$ on groceries', '$20 and c$oupons', 'save $5 and $ off']) {
    const markdown = deltaToMarkdownChecked({ ops: [{ insert: `${text}\n` }] }).md;
    assert.equal(mdToDelta(markdown).ops[0].insert, `${text}\n`);
    assert.equal(deltaToMd(mdToDelta(markdown)), markdown);
  }
  assert.throws(() => deltaToHtml(mdToDelta('```math\n$$x$$\n```\n')), (e) => e.code === 'dollar-math');
  for (const md of ['\\(x_1\n', '\\( \\right) x\n']) assert.throws(() => mdToDelta(md), (e) => e.code === 'unclosed-math');
  assert.throws(() => mdToDelta('\\(\\text{\\)}\\)\n'), (e) => e.code === 'bad-math');
  assert.throws(() => deltaToMarkdownChecked({ ops: [{ insert: 'x\\)y', attributes: { math: true } }, { insert: '\n' }] }), (e) => e.code === 'bad-math');
  const adjacent = '```js\nconst x = 1;\n```\n\n```math\nx_1\n```\n\n```text\nplain\n```\n';
  const html = deltaToHtml(mdToDelta(adjacent));
  assert.match(html, /language-js/);
  assert.match(html, /<math display="block">/);
  assert.match(html, /language-text/);
  assert.doesNotMatch(html, /language-math/);
});

test('V6/V7: macros, links, resources, unsupported commands and excessive work fail explicitly with source location', () => {
  for (const tex of [String.raw`\newcommand{\a}{x}`, String.raw`\def\a{x}`, String.raw`\let\a=b`, String.raw`\gdef\a{x}`, String.raw`\csname def\endcsname`]) {
    assert.throws(() => renderMath(tex, { where: 'posts/math.md' }), (e) => e.code === 'math-macro' && e.where === 'posts/math.md' && e.detail.includes(JSON.stringify(tex)));
  }
  for (const command of ['href', 'url', 'includegraphics', 'style', 'class', 'ref', 'tag', 'notACommand']) {
    const tex = `\\${command}{https://example.test/}{x}`;
    assert.throws(() => renderMath(tex, { where: 'posts/math.md' }), (e) => e.code === 'bad-math' && e.where === 'posts/math.md' && e.detail.includes(`\\${command}`) && e.detail.includes(JSON.stringify(tex)));
  }
  for (const tex of ['x'.repeat(MAX_MATH_LENGTH + 1), '{'.repeat(49) + 'x' + '}'.repeat(49), '\\alpha '.repeat(257), String.raw`\begin{equation}x\end{equation}`, '', String.raw`\frac{a}`]) {
    assert.throws(() => renderMath(tex), (e) => e.code === 'bad-math');
  }
  assert.throws(() => renderMath('\\iff '.repeat(50)), (e) => e.code === 'bad-math' && /Too many expansions/.test(e.detail));
  assert.doesNotMatch(renderMath(String.raw`\text{<img src=x onerror=alert(1)>}`), /<img|onerror="/);
  assert.match(renderMath(String.raw`\frac{a}{b}`), /<mfrac>/, 'a refusal does not leak macros or state into the next expression');
});

test('V8/V9: MathML is checked and reserialized; only necessary aligned-cell CSS survives', () => {
  const annotation = '<semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation></semantics>';
  for (const html of [
    `<math href="https://example.test">${annotation}</math>`,
    `<math onclick="alert(1)">${annotation}</math>`,
    `<math style="background:url(https://example.test)">${annotation}</math>`,
    `<math><script>alert(1)</script>${annotation}</math>`,
    `<math><maction>${annotation}</maction></math>`,
    `<math>${annotation}</mrow>`,
    `<math>${annotation}</math><math>${annotation}</math>`,
    '<math><mi>x</mi></math>',
    `<math><mtd style="position:fixed">${annotation}</mtd></math>`,
  ]) assert.throws(() => serializeMathML(html, 'x'), (e) => e.code === 'bad-math', html);
  assert.doesNotMatch(renderMath(String.raw`\frac{a}{b}`, { display: true }), /style=|class=|href=/);
  const tex = String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`;
  const html = renderMath(tex, { display: true });
  assert.match(html, /<mtable/);
  assert.match(html, /style="text-align:right;padding-left:0em;padding-right:0em;"/);
  assert.equal(decodeHtml(/<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/.exec(html)[1]), tex);
  assert.doesNotMatch(html, /class=|href=|<style/);
});

test('V1/V11/V12/V13/V14: inert pages, heading refusal, plain-text exclusion, source feed and live parity', async () => {
  const mathPost = post('Prose \\(\\alpha_1\\) remains.\n\n```math\n\\frac{a}{b}\n```\n');
  const result = buildSite({ blog, posts: [mathPost], lock: {} });
  assert.deepEqual(result.errors, []);
  const html = result.files['math/index.html'];
  assert.match(html, new RegExp(`<meta name="x-math" content="${MATH_ID}">`));
  assert.doesNotMatch(html, /<script[^>]+src=|webcli-math\.js|temml\.(?:css|woff)/i);
  assert.equal(result.files['webcli-math.js'], undefined);
  const entry = JSON.parse(result.files['index/posts.json']).posts[0];
  assert.equal(entry.words, 2);
  assert.equal(entry.excerpt, 'Prose remains.');
  assert.doesNotMatch(result.files['search.json'], /alpha|frac/);
  const feedHtml = decodeHtml(/<content type="html">([\s\S]*?)<\/content>/.exec(result.files['feed.xml'])[1]);
  assert.match(feedHtml, /\\alpha_1/);
  assert.match(feedHtml, /\\frac\{a\}\{b\}/);
  assert.doesNotMatch(feedHtml, /<math|<annotation/);
  const delta = mdToDelta('Only \\(x_1\\) prose.\n\n```math\n\\alpha + \\beta\n```\n');
  assert.equal(wordCount(delta), 2);
  assert.equal(excerpt(delta), 'Only prose.');
  assert.doesNotMatch(plainLines(delta).map((l) => l.text).join(' '), /alpha|beta|x_1/);
  for (const heading of ['#', '##', '###', '####']) {
    const bad = buildSite({ blog, posts: [post(`${heading} \\(x\\)\n`)], lock: {} });
    assert.equal(bad.errors[0].code, 'math-in-heading');
    assert.equal(bad.errors[0].where, 'posts/math.md');
    assert.deepEqual(bad.files, {});
  }
  const home = buildSite({ blog, posts: [post('\\(x\\)\n', 'pages', 'home')], lock: {} });
  assert.deepEqual(home.errors, []);
  assert.match(home.files['index.html'], /name="x-math"/);
  assert.match(home.files['index.html'], /<math>/);

  const liveBlog = { ...blog, repo: 'me/blog', content: { base: 'https://content.test/{owner}/{repo}/{ref}/{path}' } };
  const built = buildSite({ blog: liveBlog, posts: [mathPost], lock: {} });
  assert.deepEqual(built.errors, []);
  const files = { ...built.files, 'blog.json': JSON.stringify(liveBlog), 'posts/math.md': mathPost.text };
  const get = async (p) => p in files ? encode(files[p]) : null;
  const site = await loadSite(get);
  assert.equal(renderFromSite(site, { slug: 'math', text: mathPost.text }).html, built.files['math/index.html']);
  const current = await checkPage({ base: 'test', slug: 'math', builtSha: 'old', get });
  assert.equal(current.state, 'rebuilt');
  assert.equal(current.html, built.files['math/index.html']);
  const mismatch = await checkPage({ base: 'test', slug: 'math', builtSha: 'old', pageMath: 'Temml@old', get });
  assert.equal(mismatch.state, 'left');
  assert.match(mismatch.why, /math-version/);
  const missing = await checkMissing({ pathname: '/math/', get });
  assert.equal(missing.state, 'rebuilt');
  assert.equal(missing.html.replace('<meta name="robots" content="noindex">\n', ''), current.html);
  assert.equal(built.files['webcli-math.js'], MATH_SOURCE);
  assert.doesNotMatch(built.files['math/index.html'], /src="[^"]*webcli-math/);
});

test('V10: Temml is absent from the live bundle and isolated in the optional math bundle', async (t) => {
  const [live, math] = await Promise.all(['live', 'math'].map((name) => bundleInputs(TARGETS.find((target) => target.name === name))));
  assert.ok(!live.some((p) => p.includes('vendor/temml/') || p.endsWith('/math-renderer.js')), 'normal pages do not bundle Temml');
  assert.ok(math.some((p) => p.includes('vendor/temml/')));
  assert.match(LIVE_SOURCE, /import\(new URL\("\.\/webcli-math\.js",import\.meta\.url\)\.href\)/);
  t.diagnostic(`live: ${Buffer.byteLength(LIVE_SOURCE)} bytes (${gzipSync(LIVE_SOURCE).length} gzip); lazy math: ${Buffer.byteLength(MATH_SOURCE)} bytes (${gzipSync(MATH_SOURCE).length} gzip); static math adds 0 script/CSS/font requests`);
});

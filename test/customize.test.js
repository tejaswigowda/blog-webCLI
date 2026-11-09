import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, validateBlog } from '../lib/blog.js';
import { FONTS, MAX_CSS, checkCss, themeCss, validateCustomize } from '../lib/customize.js';
import { THEMES } from '../lib/theme.js';
import { stripData } from './helpers.js';

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'blog');
const base = async () => JSON.parse(await fs.readFile(path.join(EXAMPLE, 'blog.json'), 'utf8'));
const inputs = async (blog) => ({
  blog: JSON.stringify(blog),
  lock: JSON.parse(await fs.readFile(path.join(EXAMPLE, 'assets.lock.json'), 'utf8')),
  posts: await Promise.all(['static-hls-in-git', 'markdown-is-the-format'].map(async (s) => ({ path: `posts/${s}.md`, text: await fs.readFile(path.join(EXAMPLE, 'posts', `${s}.md`), 'utf8') }))),
});
const refused = (c) => assert.throws(() => validateCustomize(c), (e) => e.code === 'bad-blog-json', JSON.stringify(c).slice(0, 80));

test('customize: a complete valid block is accepted', () => {
  assert.doesNotThrow(() =>
    validateCustomize({
      colors: { accent: '#0b5fff', text: '#111', background: '#ffffff', muted: '#666666', dark: { accent: '#7aa7ff', background: '#101012' } },
      font: 'sans',
      headingFont: 'slab',
      width: '70ch',
      fontSize: '1.1rem',
      header: { logo: 'asset:images/logo.png', showTitle: false, links: [{ label: 'About', url: 'https://example.com/a' }, { label: 'Mail', url: 'mailto:me@example.com' }] },
      footer: { text: '© me', links: [{ label: 'Source', url: 'https://github.com/me/blog' }] },
      list: { layout: 'cards', excerpts: false, dates: true, tags: false },
      css: '.posts h2 { letter-spacing: .02em } @media (max-width: 600px) { body { font-size: 16px } }',
    }),
  );
});

test('customize: unknown settings and values outside closed sets are refused, not guessed', () => {
  refused({ colour: {} });
  refused({ colors: { accent: 'red' } });
  refused({ colors: { accent: 'url(x)' } });
  refused({ colors: { accent: '#12' } });
  refused({ colors: { primary: '#fff' } });
  refused({ colors: { dark: { dark: { accent: '#fff' } } } });
  refused({ font: 'Comic Sans' });
  refused({ font: 'Georgia,serif;}body{display:none' });
  refused({ width: '10rem' });
  refused({ width: '9999px' });
  refused({ width: '40' });
  refused({ width: 40 });
  refused({ fontSize: '40px' });
  refused({ fontSize: '70ch' });
  refused({ header: { logo: 'https://evil.example/x.png' } });
  refused({ header: { logo: 'asset:images/../x.png' } });
  refused({ header: { showTitle: 'no' } });
  refused({ header: { links: [{ label: 'x', url: 'javascript:alert(1)' }] } });
  refused({ header: { links: [{ label: 'x', url: '/relative' }] } });
  refused({ header: { links: [{ label: '', url: 'https://a.b' }] } });
  refused({ header: { links: [{ label: 'x', url: 'https://a.b', onclick: 'x' }] } });
  refused({ header: { links: Array.from({ length: 9 }, () => ({ label: 'x', url: 'https://a.b' })) } });
  refused({ footer: { text: 'x'.repeat(201) } });
  refused({ list: { layout: 'masonry' } });
  refused({ list: { dates: 'yes' } });
  refused([]);
});

test('custom CSS: nothing that fetches, imports, binds, escapes or breaks out of <style>', () => {
  const evil = [
    '@import "https://evil.example/x.css";',
    'body{background:url(https://evil.example/x)}',
    'body{background:URL( "x" )}',
    'a[href^="https://a"]{background:image-set("x" 1x)}',
    'body{background:u/**/rl(x)}'.replace('u/**/rl(x)', 'url(x)'),
    '@font-face{font-family:x;src:local(y)}',
    '@namespace x url(y);',
    '@charset "x";',
    'a{behavior:url(x)}',
    'a{-moz-binding:url(x)}',
    'a{width:expression(alert(1))}',
    'a{background:javascript:alert(1)}',
    'a{content:"data:text/html,x"}',
    '</style><script>alert(1)</script>',
    'a{color:red}<!--',
    'a{content:"\\75rl(x)"}',
    '/* open',
    'a{src:src(x)}',
    'x'.repeat(MAX_CSS + 1),
  ];
  for (const css of evil) assert.throws(() => checkCss(css), (e) => e.code === 'bad-blog-json', css.slice(0, 50));
  assert.doesNotThrow(() => checkCss('/* a comment */ .a > .b + .c ~ .d, a[href$=".pdf"]::after { content: " (pdf)"; } @keyframes k { from { opacity: 0 } to { opacity: 1 } } @supports (display: grid) { .posts { gap: 1rem } }'));
  // a forbidden construct hidden inside a comment is irrelevant; one next to a comment is not
  assert.doesNotThrow(() => checkCss('/* url(x) */ a{color:red}'));
  assert.throws(() => checkCss('a{background:/**/url(x)}'));
});

test('themeCss: no customization is the default theme, byte for byte', async () => {
  const blog = await base();
  delete blog.customize;
  assert.equal(themeCss(blog), THEMES.default);
});

test('themeCss: settings become variables; colours split light and dark; custom css comes last', () => {
  const css = themeCss({
    customize: {
      colors: { accent: '#0b7a5f', text: '#202020', dark: { accent: '#5fd3a8' } },
      font: 'mono',
      headingFont: 'sans',
      width: '50rem',
      fontSize: '17px',
      css: '.x{color:red}',
    },
  });
  assert.ok(css.startsWith(THEMES.default));
  assert.ok(css.includes(`:root{--font:${FONTS.mono};--heading-font:${FONTS.sans};--width:50rem;--size:17px}`));
  assert.ok(css.includes('@media not (prefers-color-scheme:dark){:root{--link:#0b7a5f;--fg:#202020;--rule:color-mix('));
  assert.ok(css.includes('@media (prefers-color-scheme:dark){:root{--link:#5fd3a8}}'), 'dark mode gets only what the author set for dark');
  assert.ok(css.trimEnd().endsWith('.x{color:red}'));
  // deterministic
  assert.equal(css, themeCss({ customize: { colors: { dark: { accent: '#5fd3a8' }, accent: '#0b7a5f', text: '#202020' }, css: '.x{color:red}', fontSize: '17px', width: '50rem', headingFont: 'sans', font: 'mono' } }));
});

test('themeCss: unsafe css is refused even if validation was skipped', () => {
  assert.throws(() => themeCss({ customize: { css: 'a{background:url(x)}' } }), (e) => e.code === 'bad-blog-json');
});

test('static pages: header, footer and list follow blog.json on every page', async () => {
  const blog = await base();
  const { files } = buildSite(await inputs(blog));
  for (const f of ['index.html', 'static-hls-in-git/index.html', 'markdown-is-the-format/index.html']) {
    const h = files[f];
    assert.ok(h.includes('<a href="https://example.com/about" rel="noopener noreferrer">About</a>'), `${f}: nav link`);
    assert.ok(h.includes('© 2026 Ada Example'), `${f}: footer text`);
    assert.ok(h.includes('<a href="https://github.com/example/blog" rel="noopener noreferrer">Source</a>'), `${f}: footer link`);
    assert.ok(h.includes('--width:42rem') && h.includes('--link:#0b7a5f') && h.includes('--link:#5fd3a8'), `${f}: styles inlined`);
    assert.ok(!/<script/i.test(stripData(h)));
  }
});

test('static pages: list options', async () => {
  const run = async (list) => {
    const blog = await base();
    blog.customize.list = list;
    return buildSite(await inputs(blog)).files['index.html'];
  };
  const cards = await run({ layout: 'cards' });
  assert.ok(cards.includes('<ul class="posts cards">'));
  const bare = await run({ excerpts: false, dates: false, tags: false });
  const ul = /<ul class="posts">[\s\S]*<\/ul>/.exec(bare)[0];
  assert.ok(!ul.includes('<p>') && !ul.includes('<time') && !ul.includes('class="tag"'));
  assert.ok(ul.includes('<h2><a href="static-hls-in-git/">Static HLS in git</a></h2>'));
  const full = await run({});
  assert.ok(full.includes('<time datetime="2026-11-05">') && /class="tag" href="\.\/tags\/video\/">#video/.test(full) && /<li>[\s\S]*<p>HLS is a playlist/.test(full));
});

test('static pages: a logo is pinned like any asset, and an unpinned one is refused', async () => {
  const blog = await base();
  blog.customize.header = { logo: 'asset:images/logo.png', showTitle: false };
  const input = await inputs(blog);
  assert.deepEqual(buildSite(input).errors.map((e) => e.code), ['unresolved-asset']);
  input.lock['images/logo.png'] = '4'.repeat(40);
  const { files, errors } = buildSite(input);
  assert.equal(errors.length, 0);
  assert.ok(files['index.html'].includes(`<img class="logo" src="https://cdn.jsdelivr.net/gh/example/images@${'4'.repeat(40)}/logo.png" alt="Example Blog">`));
  assert.ok(!/<a class="brand" href="\.\/"><img[^>]*>Example Blog<\/a>/.test(files['index.html']), 'the title text is hidden when showTitle is false');
  // a logo with the title shown has empty alt: the title already names the link
  blog.customize.header.showTitle = true;
  assert.match(buildSite({ ...input, blog: JSON.stringify(blog) }).files['index.html'], /alt=""><\/a>|alt="">Example Blog/);
});

test('static pages: labels and text are escaped', async () => {
  const blog = await base();
  blog.customize.header.links = [{ label: '<img src=x onerror=alert(1)>', url: 'https://example.com/?a=1&b="2"' }];
  blog.customize.footer.text = '<script>alert(1)</script>';
  const html = buildSite(await inputs(blog)).files['index.html'];
  assert.ok(!html.includes('<script>alert') && !html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && html.includes('href="https://example.com/?a=1&amp;b=&quot;2&quot;"'));
});

test('blog.json: customize is validated with the rest of the file', async () => {
  const blog = await base();
  blog.customize = { colors: { accent: 'blue' } };
  assert.throws(() => validateBlog(blog), (e) => e.code === 'bad-blog-json' && /customize: colors\.accent/.test(e.detail));
});

test('withoutLook: only what changes how a blog looks is set aside; a blog with no look is untouched', async () => {
  const { hasLook, withoutLook, LOOK_KEYS } = await import('../lib/customize.js');
  const blog = { title: 'T', customize: { colors: { accent: '#fff' }, font: 'serif', css: 'a{}', list: { layout: 'cards' }, header: { links: [{ label: 'A', url: 'https://a.test' }] }, footer: { text: 'x' } } };
  assert.equal(hasLook(blog), true);
  const bare = withoutLook(blog);
  assert.deepEqual(Object.keys(bare.customize).sort(), ['footer', 'header']);
  assert.ok(blog.customize.colors, 'the original is not modified');
  assert.deepEqual(withoutLook({ title: 'T', customize: { colors: {} } }), { title: 'T' }, 'an empty customize goes');
  const none = { title: 'T', customize: { footer: { text: 'x' } } };
  assert.equal(hasLook(none), false);
  assert.deepEqual(withoutLook(none), none);
  assert.deepEqual([...LOOK_KEYS].sort(), ['colors', 'css', 'font', 'fontSize', 'headingFont', 'list', 'width']);
});

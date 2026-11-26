import test from 'node:test';
import assert from 'node:assert/strict';

test('Blog run parser uses fragment precedence and validates render inputs', async () => {
  const { parseRunParams } = await import(`../app/webcli.js?test=${Date.now()}`);
  assert.equal(parseRunParams('', ''), null);
  assert.deepEqual(
    parseRunParams('?src=old.md&run=render', '#&src=new.md&run=render&download=1'),
    { run: 'render', src: 'new.md', markdown: null, format: 'HTML', download: true },
  );
  assert.deepEqual(
    parseRunParams('', '#&run=render&markdown=%23+Hello'),
    { run: 'render', src: null, markdown: '# Hello', format: 'HTML', download: false },
  );
  assert.throws(() => parseRunParams('', '#&run=render'), /requires src or markdown/);
  assert.throws(() => parseRunParams('', '#&run=nope&src=a.md'), /Unknown run/);
  assert.throws(() => parseRunParams('', '#&run=render&src=a.md&format=PDF'), /format=HTML/);
});

test('Blog run fetch refuses non-web and non-blob sources', async () => {
  const { fetchInput } = await import(`../app/webcli.js?test=${Date.now()}`);
  await assert.rejects(fetchInput('file:///secret', 'https://example.test/'), /src must be/);
  const input = await fetchInput('post.md', 'https://example.test/app/', async (url, options) => {
    assert.equal(url, 'https://example.test/app/post.md');
    assert.deepEqual(options, { method: 'GET', credentials: 'omit', cache: 'no-store' });
    return new Response('# Hello');
  });
  assert.equal(input.name, 'post.md');
  assert.equal(new TextDecoder().decode(input.bytes), '# Hello');
});

test('Blog HTML artifact has UTF-8 size and base64 data URL', async () => {
  const { makeHtmlArtifact } = await import(`../app/webcli.js?test=${Date.now()}`);
  const artifact = makeHtmlArtifact('<p>Café</p>', 'post.html');
  assert.equal(artifact.mime, 'text/html');
  assert.equal(artifact.name, 'post.html');
  assert.equal(artifact.size, new TextEncoder().encode('<p>Café</p>').byteLength);
  assert.match(artifact.dataUrl, /^data:text\/html;base64,/);
});

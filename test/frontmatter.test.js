import test from 'node:test';
import assert from 'node:assert/strict';
import { newFront, parseMeta, setMeta, validateMeta } from '../lib/frontmatter.js';

const valid = (contents) => ({
  slug: 'example',
  title: 'Example',
  date: '2026-01-02',
  status: 'published',
  ...(contents === undefined ? {} : { contents }),
});

test('frontmatter contents is a boolean and rejects non-boolean values', () => {
  assert.equal(parseMeta('contents: true\n').contents, true);
  assert.equal(parseMeta('contents: false\n').contents, false);
  for (const value of ['yes', '1', '"true"', 'TRUE']) {
    const meta = { ...valid(), ...parseMeta(`contents: ${value}\n`) };
    assert.throws(() => validateMeta(meta, 'posts/example.md'), (e) => e.code === 'bad-frontmatter' && /contents must be true or false/.test(e.message), value);
  }
  assert.doesNotThrow(() => validateMeta({ ...valid(true) }, 'posts/example.md'));
  assert.doesNotThrow(() => validateMeta({ ...valid(false) }, 'posts/example.md'));
});

test('contents serialization is canonical and updates preserve existing frontmatter syntax', () => {
  const front = 'slug: example\ntitle: "Kept: as written"\nstatus: published # keep this\ncontents: false # old setting\ncustom: [one, "two words"]\n';
  const updated = setMeta(front, 'contents', true);
  assert.equal(updated, 'slug: example\ntitle: "Kept: as written"\nstatus: published # keep this\ncontents: true  # old setting\ncustom: [one, "two words"]\n');
  assert.equal(parseMeta(updated).contents, true);

  const added = setMeta(front.replace(/contents: false # old setting\n/, ''), 'contents', false);
  assert.match(added, /contents: false\n$/);
  assert.equal(parseMeta(added).contents, false);
  assert.match(newFront(valid(false)), /contents: false\n$/);
  assert.match(newFront(valid(true)), /contents: true\n$/);
});

// The committed normaliser (test/normalise.js) forgives three things and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalise } from './normalise.js';

const same = (a, b, why) => assert.equal(normalise(a), normalise(b), why);
const differs = (a, b, why) => assert.notEqual(normalise(a), normalise(b), why);

test('forgiven: whitespace between tags', () => {
  same('<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>', '<ul><li>a</li><li>b</li></ul>');
  same('<p>a</p>\r\n\r\n<p>b</p>', '<p>a</p><p>b</p>');
});

test('forgiven: attribute order, quoting of values, and the spelling of a boolean attribute', () => {
  same('<a href="x" class="c" rel="me">t</a>', '<a rel="me" href=\'x\' class=c>t</a>');
  same('<input type="checkbox" checked disabled>', '<input disabled checked type="checkbox">');
});

test('forgiven: the self-closing form of a void element', () => {
  same('<br>', '<br />');
  same('<img src="a" alt="">', '<img alt="" src="a"/>');
  same('<meta charset="utf-8">', '<meta charset="utf-8" />');
});

test('forgiven: line endings and trailing newlines at the end of the file', () => {
  same('<p>a</p>\r\n', '<p>a</p>\n\n\n');
});

test('not forgiven: text, including whitespace inside it', () => {
  differs('<p>a b</p>', '<p>a  b</p>');
  differs('<p>a <b>b</b></p>', '<p>a<b>b</b></p>', 'a space between text and a tag is text');
  differs('<p>a</p>', '<p>A</p>');
  differs('<p>a &amp; b</p>', '<p>a & b</p>');
});

test('not forgiven: a different value, element, order or comment', () => {
  differs('<a href="x">t</a>', '<a href="y">t</a>');
  differs('<a href="x">t</a>', '<a href="x ">t</a>');
  differs('<p>a</p><p>b</p>', '<p>b</p><p>a</p>');
  differs('<h2>a</h2>', '<h3>a</h3>');
  differs('<!-- a -->', '<!-- b -->');
  differs('<p class="a b">x</p>', '<p class="b a">x</p>', 'the order of class names is a value');
  differs('<div />', '<div></div>', 'only a void element may drop its slash');
});

test('not forgiven: anything inside pre, textarea, script and style', () => {
  differs('<pre>a\n  b</pre>', '<pre>a\nb</pre>');
  differs('<pre><code>a >  < b</code></pre>', '<pre><code>a > < b</code></pre>');
  differs('<style>a {\n x: 1 }</style>', '<style>a { x: 1 }</style>');
  differs('<script>if (a<b) {  }</script>', '<script>if (a<b) { }</script>');
  same('<pre   class="x" id="y">a\n  b</pre>', '<pre id="y" class="x">a\n  b</pre>', 'the tag itself is still normalised');
});

test('the normaliser is idempotent', () => {
  const page = '<!doctype html>\r\n<html lang="en">\n<head><meta  content="x"  name="y" />\n</head><body>\n<pre> a\n  b </pre>\n<p class=a   id="b">t</p>\n</body></html>\n';
  assert.equal(normalise(normalise(page)), normalise(page));
});

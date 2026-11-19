import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { slugWarnings } from '../lib/slug-guard.js';

const known = new Set((await readFile(new URL('../vendor/word-list/words.txt', import.meta.url), 'utf8')).trim().split('\n'));
const check = (slug, title = '', body = '') => slugWarnings({ slug, title, body }, known);

test('slug guard: only an unknown token one edit from a known word in the document is flagged', () => {
  assert.deepEqual(check('my-favorite-grocey-deals', 'My Favorite Grocery Deals'), [{ token: 'grocey', corrections: ['grocery'] }]);
  assert.deepEqual(check('grocey', 'Shopping', 'GROCERY savings.'), [{ token: 'grocey', corrections: ['grocery'] }]);
  assert.deepEqual(check('grocey', 'Shopping', 'Save on food.'), [], 'a dictionary neighbour alone is not enough');
  assert.deepEqual(check('grocy', 'Grocery'), [], 'two edits are not a near-miss');
  assert.deepEqual(check('store', 'Stores'), [], 'an ordinary word is not a typo even when a neighbour appears');
  assert.deepEqual(check('bashas-ibotta-frys-sprouts-upside', "Bashas' Ibotta Fry's Sprouts Upside"), [], 'brand names do not trigger a dictionary-only warning');
  assert.deepEqual(check('frys-fry-s', 'Fry\u2019s', 'An offer at the store.'), [], 'possessives and single-letter slug fragments are not misspellings');
  assert.deepEqual(check('2026-grocey', 'Grocery'), [{ token: 'grocey', corrections: ['grocery'] }]);
});

test("slug guard: substitutions, insertions and deletions offer only the document's actual words", () => {
  assert.deepEqual(check('grocerx-grocerxy', 'Grocery'), [{ token: 'grocerx', corrections: ['grocery'] }, { token: 'grocerxy', corrections: ['grocery'] }]);
  assert.deepEqual(check('grocey-grocey', 'Grocery grocery'), [{ token: 'grocey', corrections: ['grocery'] }]);
  assert.deepEqual(check('grocey', 'Grocey'), [], 'repeating an unknown word is not evidence for a correction');
});

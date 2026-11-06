import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// the vendored moment.js, exactly as the page loads it
const file = new URL('../vendor/moment/moment.min.js', import.meta.url);
const src = readFileSync(file, 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', src)(mod, mod.exports);
const moment = mod.exports;
globalThis.window = { moment };
const { describeDate, today } = await import('../app/dates.js');

const now = moment('2026-11-05T22:00:00'); // evening: UTC is already the 6th
const d = (iso) => describeDate(iso, now);

test('the vendored moment is the pinned release', () => {
  assert.equal(moment.version, '2.31.0');
  assert.equal(createHash('sha256').update(src).digest('hex'), 'c111ad2e4447c253765e679bb4a40ba91a3e23d80b4b69d603a0fd25164cb9de');
});

test('days around today read as words', () => {
  assert.equal(d('2026-11-05').label, 'Today');
  assert.equal(d('2026-11-04').label, 'Yesterday');
  assert.equal(d('2026-11-06').label, 'Tomorrow');
  assert.equal(d('2026-11-02').label, '3 days ago');
  assert.equal(d('2026-11-09').label, 'in 4 days');
});

test('a date is compared by day, not by the hour: the evening does not turn yesterday into "2 days ago"', () => {
  assert.equal(describeDate('2026-11-04', moment('2026-11-05T23:59:00')).label, 'Yesterday');
  assert.equal(describeDate('2026-11-05', moment('2026-11-05T00:01:00')).label, 'Today');
});

test('further away it is a date; the year only when it is not this year', () => {
  assert.equal(d('2026-09-01').label, 'Sep 1');
  assert.equal(d('2025-12-25').label, 'Dec 25, 2025');
  assert.equal(d('2027-01-02').label, 'Jan 2, 2027');
});

test('the full date is always available for the tooltip', () => {
  assert.equal(d('2026-11-04').full, 'Wednesday, November 4, 2026');
  assert.equal(d('2025-12-25').full, 'Thursday, December 25, 2025');
});

test('what is not a calendar day is shown as written, never "Invalid date"', () => {
  assert.deepEqual(d('someday'), { label: 'someday', full: 'someday', relative: '' });
  assert.equal(d('2026-02-30').label, '2026-02-30');
  assert.equal(d('').label, '');
  assert.equal(d(undefined).label, '');
});

test("today() is the reader's own day, not UTC's", () => {
  const local = moment().format('YYYY-MM-DD');
  assert.equal(today(), local);
});

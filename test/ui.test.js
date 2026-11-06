import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_DELAY, DEFAULT_TIMEOUT, MAX_TOASTS, describeError } from '../app/ui.js';
import { Refusal } from '../lib/errors.js';

test('a refusal is titled with its code and carries the reason', () => {
  const d = describeError(new Refusal('slug-collision', 'posts/a.md already exists'));
  assert.deepEqual(d, { title: 'Refused: slug-collision', message: 'posts/a.md already exists' });
});

test('anything else is "Something went wrong" with its message', () => {
  assert.deepEqual(describeError(new Error('boom')), { title: 'Something went wrong', message: 'boom' });
  assert.deepEqual(describeError('plain'), { title: 'Something went wrong', message: 'plain' });
});

test('errors stay until dismissed; successes and notes go by themselves; the stack and the delay are bounded', () => {
  assert.equal(DEFAULT_TIMEOUT.error, 0);
  assert.ok(DEFAULT_TIMEOUT.success > 0 && DEFAULT_TIMEOUT.info > 0);
  assert.ok(MAX_TOASTS >= 3 && MAX_TOASTS <= 6);
  assert.ok(ACTIVITY_DELAY > 0 && ACTIVITY_DELAY < 400);
});

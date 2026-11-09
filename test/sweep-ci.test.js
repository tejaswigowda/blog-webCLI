import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { regressions, VERDICT_RANK } from '../cli/sweep-core.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// M4: the corpus costs nothing to keep because one check says whether a change broke layout
test('M4: a verdict regression fails the sweep; a count, an improvement and a new theme do not', () => {
  const base = { a: 'usable', b: 'usable (soft)', c: 'degraded', d: 'unportable?', e: 'usable' };
  assert.deepEqual(regressions(base, { a: 'usable', b: 'usable (soft)', c: 'degraded', d: 'unportable?', e: 'usable' }), []);
  assert.deepEqual(regressions(base, { a: 'degraded', b: 'usable', c: 'unportable?', d: 'degraded', e: 'usable (soft)', f: 'degraded' }), [
    { slug: 'a', before: 'usable', now: 'degraded' },
    { slug: 'c', before: 'degraded', now: 'unportable?' },
  ]);
  assert.deepEqual(regressions({ x: 'degraded' }, { x: 'error' }), [{ slug: 'x', before: 'degraded', now: 'error' }]);
  assert.equal(VERDICT_RANK.usable, VERDICT_RANK['usable (soft)']);
});

test('M4: the baseline is committed, covers the corpus, and the workflow runs on a schedule and on changes under lib/', async () => {
  const baseline = JSON.parse(await fs.readFile(path.join(root, 'docs/layout-baseline.json'), 'utf8'));
  assert.equal(Object.keys(baseline).length, 77);
  for (const v of Object.values(baseline)) assert.ok(v in VERDICT_RANK, v);
  const wf = await fs.readFile(path.join(root, '.github/workflows/sweep.yml'), 'utf8');
  assert.match(wf, /schedule:/);
  assert.match(wf, /- 'lib\/\*\*'/);
  assert.match(wf, /blog-webCLI-corpus/);
  assert.match(wf, /wp-sweep\.mjs corpus \/tmp\/sweep --check/);
  for (const f of ['docs/layout-sweep.md', 'docs/contract-gap.md']) await fs.access(path.join(root, f));
});

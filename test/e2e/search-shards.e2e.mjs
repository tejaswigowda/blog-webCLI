// End to end, in real Chrome: a blog big enough that its search index is in shards. The search page reads the list and every shard
// from its own origin, ranks across all of them, and writes results as text.
// Run with: npm run test:e2e   (skips itself when Chrome is not installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../../cli/serve.js';
import { SEARCH_SHARD_OVER, buildSite } from '../../lib/blog.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const skip = chromePath() ? false : 'Chrome is not installed (set CHROME=/path/to/chrome)';
const COUNT = SEARCH_SHARD_OVER + 30;

test('search in shards: every shard is read, results come from all of them, and are text', { skip, timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blog-shards-'));
  const posts = Array.from({ length: COUNT }, (_, n) => ({
    path: `posts/p${n}.md`,
    text: `---\nslug: p${n}\ntitle: Post ${n}\ndate: 2025-${String((n % 12) + 1).padStart(2, '0')}-10\nstatus: published\n---\n\nPlain words of post ${n}.${n === 3 ? ' The unique word is zanzibar.' : ''}${n === 450 ? ' The unique word is zanzibar too.' : ''}\n`,
  }));
  const web = await serve(dir);
  const origin = `http://127.0.0.1:${web.address().port}`;
  const blog = { title: 'Shards', description: 'd', author: 'A', domain: origin, theme: 'default', search: true, pagination: { size: 50 } };
  const r = buildSite({ blog, posts, lock: {} });
  assert.deepEqual(r.errors, []);
  assert.equal(JSON.parse(r.files['search.json']).version, 2);
  for (const [f, c] of Object.entries(r.files)) {
    await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await writeFile(path.join(dir, f), c);
  }
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `${origin}/search/?q=zanzibar`);
    const until = async (expr, ms = 15000) => {
      const t0 = Date.now();
      for (;;) {
        if (await page.evaluate(`Boolean(${expr})`)) return;
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${expr}`);
        await new Promise((res) => setTimeout(res, 100));
      }
    };
    await until("document.querySelector('[data-results] li')");
    const found = await page.evaluate("[...document.querySelectorAll('[data-results] li a')].map((a) => a.textContent).sort()");
    assert.deepEqual(found, ['Post 3', 'Post 450'], 'a post from each end of the index, from different shards');
    assert.match(await page.evaluate("document.querySelector('[data-status]').textContent"), /2 results/);
    assert.equal(await page.evaluate("document.querySelectorAll('[data-results] script, [data-results] img').length"), 0);
    const fetched = await page.evaluate("performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname).filter((p) => /search\\/data-|search\\.json/.test(p))");
    assert.equal(fetched.filter((p) => /data-\d+\.json$/.test(p)).length, 16, 'the list, then every shard');
    assert.ok(fetched.includes('/search.json'));
  } finally {
    chrome.close();
    web.close();
  }
});

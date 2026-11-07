// End to end, in real Chrome: the tool's own licences and dependencies are shown in the UI (R4), from the generated inventory.
// Run with: npm run test:e2e   (skips itself when Chrome is not installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../../cli/serve.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skip = chromePath() ? false : 'Chrome is not installed (set CHROME=/path/to/chrome)';

test('licences: the tool\'s own dependencies are listed by surface, with their licence and where they came from', { skip, timeout: 60000 }, async () => {
  const web = await serve(root);
  const chrome = await launch();
  try {
    const page = await openPage(chrome, `http://127.0.0.1:${web.address().port}/index.html#licences`);
    for (let i = 0; i < 100 && !(await page.evaluate("document.querySelector('#view table')")); i++) await new Promise((r) => setTimeout(r, 100));
    const text = await page.evaluate("document.querySelector('#view').innerText");
    assert.match(text, /Licences and dependencies of this tool/);
    assert.match(text, /runtime: built into the scripts/i);
    assert.match(text, /moment\s+2\.31\.0\s+MIT/);
    assert.match(text, /quill\s+2\.0\.3\s+BSD-3-Clause/);
    assert.match(text, /blog-webCLI runtime\s+[\d.]+\s+MIT/);
    assert.match(text, /blog-webCLI tool\s+[\d.]+\s+GPL-3\.0-only/);
    // the runtime table holds nothing copyleft
    const runtime = await page.evaluate("[...document.querySelectorAll('#view h2')].find((h) => /^runtime/i.test(h.textContent)).nextElementSibling.innerText");
    assert.ok(!/GPL/.test(runtime), 'nothing copyleft in the runtime');
    assert.equal(await page.evaluate("document.querySelectorAll('#view script, #view img, #view [onclick]').length"), 0, 'text only');
  } finally {
    chrome.close();
    web.close();
  }
});

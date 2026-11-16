import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { serve } from '../../cli/serve.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const skip = chromePath() ? false : 'Chrome is not installed';

test('public About and guides work at their real paths without scripting, at desktop and phone widths', { skip, timeout: 60000 }, async () => {
  const web = await serve(fileURLToPath(new URL('../../', import.meta.url)));
  const chrome = await launch();
  const base = `http://127.0.0.1:${web.address().port}`;
  try {
    const page = await openPage(chrome, 'about:blank');
    await page.send('Network.enable');
    await page.send('Network.setBlockedURLs', { urls: ['https://*'] });
    await page.send('Emulation.setScriptExecutionDisabled', { value: true });
    for (const width of [1280, 390]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const route of ['/about', '/about/tutorials/', '/about/tutorials/recreate-webcli-app.html', '/about/tutorials/migrate-swim-platform.html']) {
        await page.send('Page.navigate', { url: `${base}${route}` });
        let ready = false;
        for (let i = 0; i < 200; i++) {
          ready = await page.evaluate(`location.pathname === ${JSON.stringify(route)} && document.readyState === 'complete' && !!document.querySelector('main h1')`);
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.ok(ready, route);
        const result = await page.evaluate(`({
          title: document.querySelector('h1').innerText,
          scripts: document.scripts.length,
          overflow: document.documentElement.scrollWidth > innerWidth,
          styled: getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)',
          brokenImages: [...document.images].filter(i => !i.complete || !i.naturalWidth).length,
          resources: performance.getEntriesByType('resource').map(e => e.name)
        })`);
        assert.ok(result.title.length > 3, route);
        assert.equal(result.scripts, 0, route);
        assert.equal(result.overflow, false, `${width}px ${route}`);
        assert.equal(result.styled, true, route);
        assert.equal(result.brokenImages, 0, route);
        assert.ok(result.resources.every((url) => new URL(url).origin === base), route);
      }
    }
    page.close();
  } finally {
    chrome.close();
    web.close();
  }
});

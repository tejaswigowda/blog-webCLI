import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { serve } from '../../cli/serve.js';
import { chromePath, launch, openPage } from './cdp.mjs';

const skip = chromePath() ? false : 'Chrome is not installed';

test('editor header groups accessible Tutorials, About and GitHub icons at desktop and phone widths', { skip, timeout: 60000 }, async () => {
  const web = await serve(fileURLToPath(new URL('../../', import.meta.url)));
  const chrome = await launch();
  const base = `http://127.0.0.1:${web.address().port}`;
  try {
    const page = await openPage(chrome, 'about:blank');
    await page.send('Network.enable');
    await page.send('Network.setBlockedURLs', { urls: ['https://*'] });
    await page.send('Page.navigate', { url: base });
    let ready = false;
    for (let i = 0; i < 200; i++) {
      ready = await page.evaluate(`!!document.querySelector('#top .help-nav .gh-link')`);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(ready, 'editor header rendered');
    for (const width of [1280, 390]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const result = await page.evaluate(`(() => {
        const tutorials = document.querySelector('#top a[aria-label="Tutorials"]');
        const about = document.querySelector('#top a[aria-label="About blog-webCLI"]');
        const github = document.querySelector('#top .gh-link');
        const t = tutorials.getBoundingClientRect(), a = about.getBoundingClientRect(), g = github.getBoundingClientRect();
        return {
          tutorialsPath: new URL(tutorials.href).pathname,
          tutorialsIcon: !!tutorials.querySelector('svg[aria-hidden="true"]'),
          aboutPath: new URL(about.href).pathname,
          aboutIcon: !!about.querySelector('svg'),
          githubUrl: github.dataset.href,
          githubLabel: github.getAttribute('aria-label'),
          githubIcon: getComputedStyle(github, '::before').maskImage !== 'none',
          tooltips: [...document.querySelectorAll('#top form button, #top .help-nav > *')].map((el) => [el.getAttribute('aria-label'), el.getAttribute('title')]),
          text: tutorials.textContent + about.textContent + github.textContent,
          adjacent: tutorials.nextElementSibling === about && t.top === a.top && a.left >= t.right && a.left - t.right < 12 &&
            about.nextElementSibling === github && a.top === g.top && g.left >= a.right && g.left - a.right < 12,
          overflow: document.documentElement.scrollWidth > innerWidth
        };
      })()`);
      assert.equal(result.tutorialsPath, '/about/tutorials/');
      assert.equal(result.tutorialsIcon, true);
      assert.equal(result.aboutPath, '/about/');
      assert.equal(result.aboutIcon, true);
      assert.equal(result.githubUrl, 'https://github.com/tejaswigowda/blog-webCLI');
      assert.equal(result.githubLabel, 'Fork on GitHub');
      assert.equal(result.githubIcon, true);
      assert.deepEqual(result.tooltips, [
        ['Open repository', 'Open repository'],
        ['Tutorials', 'Tutorials'],
        ['About blog-webCLI', 'About blog-webCLI'],
        ['Fork on GitHub', 'Fork on GitHub'],
      ]);
      assert.equal(result.text, '');
      assert.equal(result.adjacent, true, `${width}px`);
      assert.equal(result.overflow, false, `${width}px`);
    }
    await page.evaluate(`document.querySelector('#top a[aria-label="About blog-webCLI"]').click()`);
    let navigated = false;
    for (let i = 0; i < 200; i++) {
      navigated = await page.evaluate(`location.pathname === '/about/' && document.querySelector('h1')?.textContent === 'About blog-webCLI'`);
      if (navigated) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(navigated, 'About icon opens the public About page');
    page.close();
  } finally {
    chrome.close();
    web.close();
  }
});

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

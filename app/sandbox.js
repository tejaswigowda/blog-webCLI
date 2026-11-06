// The extension sandbox, as the editor uses it. Extension code runs ONLY here, at publish:
//   * in a Worker (no DOM),
//   * inside an iframe with sandbox="allow-scripts" and no allow-same-origin (an opaque origin:
//     no storage, no cookies, no reach into the editor),
//   * under a CSP with connect-src 'none' that the Worker inherits (no network),
//   * given only { source, hook, input, ctx } as data — never a token or a URL,
//   * with a hard time limit: on timeout the whole frame is destroyed, which kills the Worker.
// The reader (/blog/) and the CLI never import this module.
import { Refusal } from '../lib/errors.js';

export const SANDBOX_ATTRIBUTE = 'allow-scripts'; // never add allow-same-origin
export const DEFAULT_TIMEOUT_MS = 4000;

export function createSandbox({ frameUrl = new URL('sandbox-frame.html', import.meta.url).href, timeoutMs = DEFAULT_TIMEOUT_MS, parent = document.body } = {}) {
  let frame = null;
  let ready = null;
  let counter = 0;
  const pending = new Map();

  const onMessage = (ev) => {
    if (!frame || ev.source !== frame.contentWindow) return;
    const m = ev.data;
    if (m && m.type === 'ready') return ready && ready.resolve();
    const job = m && pending.get(m.id);
    if (!job) return;
    pending.delete(m.id);
    clearTimeout(job.timer);
    if (m.ok) job.resolve(m.output);
    else job.reject(new Refusal('extension-failed', `${job.label}: ${m.error}`));
  };

  function start() {
    window.addEventListener('message', onMessage);
    frame = document.createElement('iframe');
    frame.setAttribute('sandbox', SANDBOX_ATTRIBUTE);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    ready = {};
    ready.promise = new Promise((resolve, reject) => {
      ready.resolve = resolve;
      setTimeout(() => reject(new Refusal('extension-failed', 'the extension sandbox did not start')), 8000);
    });
    frame.src = frameUrl;
    parent.append(frame);
    return ready.promise;
  }

  function destroy(reason) {
    window.removeEventListener('message', onMessage);
    if (frame) frame.remove();
    frame = null;
    ready = null;
    for (const [id, job] of pending) {
      clearTimeout(job.timer);
      job.reject(new Refusal('extension-failed', `${job.label}: ${reason}`));
      pending.delete(id);
    }
  }

  async function run({ source, hook, input, ctx, label = 'extension' }) {
    if (!frame) await start();
    else await ready.promise;
    const id = ++counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // An extension that does not return is destroyed, not waited for.
        destroy(`${label} did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped`);
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, label });
      frame.contentWindow.postMessage({ type: 'run', id, source, hook, input, ctx }, '*');
    });
  }

  return {
    run,
    dispose: () => destroy('the sandbox was closed'),
    // The runner buildSiteWith calls.
    runner: ({ extension, hook, ctx, input }) => run({ source: extension.source, hook, input, ctx, label: `${extension.manifest.name} (${hook})` }),
  };
}

// Runs inside the sandboxed iframe. It receives { source, hook, input, ctx } as plain data,
// starts a Worker for each run, and returns the string the extension produced. It never receives
// a token, a URL to fetch, or any handle on the editor.
(() => {
  // The Worker's bootstrap. Everything with ambient authority is removed before the extension's
  // code exists in the realm (and the frame's CSP, which the Worker inherits, blocks the network anyway).
  const BOOT = `
    'use strict';
    const post = self.postMessage.bind(self);
    const GONE = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'indexedDB', 'caches', 'localStorage', 'sessionStorage', 'BroadcastChannel', 'Worker', 'SharedWorker', 'importScripts', 'close'];
    // on self and on every prototype above it, so Object.getPrototypeOf(self).fetch is gone too
    for (let o = self; o; o = Object.getPrototypeOf(o)) {
      for (const name of GONE) {
        if (!Object.prototype.hasOwnProperty.call(o, name)) continue;
        try { Object.defineProperty(o, name, { value: undefined, configurable: false, writable: false }); } catch (e) {}
      }
    }
    for (const name of GONE) { try { if (!(name in self) || self[name] !== undefined) Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false }); } catch (e) {} }
    try { Object.defineProperty(navigator, 'sendBeacon', { value: undefined }); } catch (e) {}
    self.onmessage = async (e) => {
      self.onmessage = null;
      const { source, hook, input, ctx } = e.data;
      try {
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const mod = await import(url);
        const fn = mod.hooks && mod.hooks[hook];
        if (typeof fn !== 'function') throw new Error('the extension does not implement ' + hook);
        const output = await fn(input, ctx);
        post({ ok: true, output });
      } catch (err) {
        post({ ok: false, error: String((err && err.message) || err) });
      }
    };
  `;
  const bootUrl = URL.createObjectURL(new Blob([BOOT], { type: 'text/javascript' }));

  function run({ source, hook, input, ctx }) {
    return new Promise((resolve, reject) => {
      const w = new Worker(bootUrl);
      w.onmessage = (e) => {
        w.terminate();
        if (e.data && e.data.ok) resolve(e.data.output);
        else reject(new Error((e.data && e.data.error) || 'the extension failed'));
      };
      w.onerror = (e) => {
        w.terminate();
        reject(new Error(e.message || 'the extension could not be loaded'));
      };
      w.postMessage({ source, hook, input, ctx });
    });
  }

  addEventListener('message', (ev) => {
    if (ev.source !== parent) return;
    const m = ev.data;
    if (!m || m.type !== 'run' || typeof m.id !== 'number') return;
    run(m).then(
      (output) => parent.postMessage({ id: m.id, ok: true, output }, '*'),
      (err) => parent.postMessage({ id: m.id, ok: false, error: String(err.message || err) }, '*'),
    );
  });
  parent.postMessage({ type: 'ready' }, '*');
})();

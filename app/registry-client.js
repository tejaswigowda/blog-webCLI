// Reading the registry: fetch the file for freshness, fall back to the bundled snapshot. Same shape as the freshness check on a
// generated page (lib/live.js): a plain GET of a static file, no credentials, a path that is not in any cache, and an unreachable
// registry degrades the list to the snapshot rather than breaking the screen (R6).
import { KINDS, parseRegistry } from '../lib/registry.js';
import { varyPath } from '../lib/live.js';

const FILES = { themes: 'themes.json', extensions: 'extensions.json' };

// -> { entries, rejected, source: 'registry' | 'snapshot', why? }
export async function loadRegistry(kind, { url, fetchImpl = (...a) => globalThis.fetch(...a), snapshot, now = Date.now, rand } = {}) {
  if (!(kind in KINDS)) throw new Error(`unknown registry kind "${kind}"`);
  const fromSnapshot = (why) => {
    const parsed = parseRegistry(kind, { version: snapshot && snapshot.version, [kind]: snapshot && snapshot[kind] });
    return { ...parsed, source: 'snapshot', why };
  };
  if (!url) return fromSnapshot('no registry is configured');
  try {
    const res = await fetchImpl(`${url}${varyPath(FILES[kind], rand)}?t=${now()}`, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ...parseRegistry(kind, await res.text()), source: 'registry' };
  } catch (e) {
    return fromSnapshot(e && e.message ? e.message : String(e));
  }
}

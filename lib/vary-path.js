// Vary the spelling, not the resource: percent-encoded unreserved characters defeat stale CDN cache keys.
export function varyPath(path, rand = randomUnit) {
  return path.replace(/[A-Za-z0-9-]/g, (c) => (rand() < 0.5 ? `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}` : c));
}

export function randomUnit() {
  const c = globalThis.crypto;
  if (c && c.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  return Math.random();
}

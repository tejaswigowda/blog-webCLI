// The generator's version, stamped into every page it writes (x-generator) and into the live
// renderer that ships with them, so a page and the code that re-renders it can be told apart.
// package.json carries the same number; a test keeps the two equal.
export const VERSION = '0.5.1';

export function compareVersions(a, b) {
  const n = (v) => String(v || '').split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}

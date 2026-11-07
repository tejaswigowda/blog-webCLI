// The dependency and licence inventory: every third-party file or package, its licence, its upstream, and the surface it lands on.
//   node cli/inventory.js           write licences-inventory.json
//   node cli/inventory.js --check   fail if it is stale, or if anything unlicensed or copyleft reaches the runtime
// Generated, never maintained by hand. The inventory is documentation; the failure is the mechanism (R5).
//
// Surfaces (see LICENSE):
//   runtime  built into the scripts generated pages load (webcli-live.js, webcli-search.js): found by bundling them
//   tool     loaded by the editor, the reader or the command line: found by what app/, blog/, cli/ and index.html name
//   dev      installed to build or test, shipped to no one (package-lock.json)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS, bundleInputs } from './build-live.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A licence a page's reader may be handed inside a script, with no obligation beyond a notice.
export const RUNTIME_ALLOWED = ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Unlicense', 'CC0-1.0', 'Zlib'];
// What the tool (GPL-3.0-only) may include: the above, and licences that are compatible with it.
export const TOOL_ALLOWED = [...RUNTIME_ALLOWED, 'GPL-3.0-only', 'GPL-3.0-or-later', 'GPL-2.0-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'LGPL-2.1-or-later', 'MPL-2.0'];
const COPYLEFT = /(^|[^A-Za-z])(A?GPL|LGPL|MPL|EPL|CDDL|EUPL|OSL|CPAL|SSPL|CC-BY-SA|CC-BY-NC)/i;

// A licence expression is acceptable under `allowed` if some alternative of every "AND" group is: "MIT OR GPL-3.0-only" is MIT.
export function acceptable(expr, allowed) {
  const text = String(expr || '').trim().replace(/^\(|\)$/g, '');
  if (!text || /UNLICENSED|SEE LICENSE|^NONE$|^UNKNOWN$/i.test(text)) return false;
  return text.split(/\s+AND\s+/).every((group) => group.replace(/[()]/g, '').split(/\s+OR\s+/).some((one) => allowed.includes(one.trim())));
}
export const isCopyleft = (expr) => COPYLEFT.test(String(expr || ''));

// items: [{ name, version, licence, upstream, kind: 'vendored' | 'npm' | 'first-party', surfaces: [..], paths?: [..] }]
// bundled: the repository-relative files the generated-page scripts are built from. -> a list of reasons to fail.
export function violations(items, bundled, { runtimeDirs = ['lib/'] } = {}) {
  const out = [];
  const owner = (file) => items.find((i) => i.kind !== 'first-party' && (i.paths || []).some((p) => file === p || file.startsWith(p)));
  for (const file of bundled) {
    if (runtimeDirs.some((d) => file.startsWith(d))) continue;
    const item = owner(file);
    if (!item) out.push(`${file} is built into a generated page's script and belongs to no inventoried package or vendored directory`);
  }
  for (const i of items) {
    if (i.kind === 'first-party') continue;
    const where = i.surfaces.join('+');
    if (!String(i.licence || '').trim() || /UNLICENSED|SEE LICENSE/i.test(i.licence)) out.push(`${i.name} ${i.version || ''} has no licence (${where})`);
    else if (i.surfaces.includes('runtime') && !acceptable(i.licence, RUNTIME_ALLOWED)) out.push(`${i.name} ${i.version || ''} is ${i.licence}, which may not reach the runtime (generated pages): ${isCopyleft(i.licence) ? 'copyleft' : 'not on the permissive list'}`);
    else if (i.surfaces.includes('tool') && !acceptable(i.licence, TOOL_ALLOWED)) out.push(`${i.name} ${i.version || ''} is ${i.licence}, which the GPL-3.0-only tool cannot include`);
  }
  return out;
}

async function walk(dir, out = []) {
  for (const e of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

async function sourcesNaming(name, dirs) {
  const hits = [];
  for (const d of dirs) {
    const files = d.endsWith('.html') ? [d] : (await walk(d)).filter((f) => /\.(m?js|html)$/.test(f));
    for (const f of files) if ((await fs.readFile(path.join(root, f), 'utf8')).includes(`vendor/${name}/`)) hits.push(f);
  }
  return hits;
}

export async function collect() {
  const bundled = new Set();
  for (const t of TARGETS) for (const f of await bundleInputs(t)) bundled.add(f);
  const items = [];

  // vendored: every directory under vendor/ declares itself in SOURCE.json, with a licence file beside the code
  for (const name of (await fs.readdir(path.join(root, 'vendor'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const raw = await fs.readFile(path.join(root, 'vendor', name, 'SOURCE.json'), 'utf8').catch(() => null);
    if (raw === null) {
      items.push({ name, version: '', licence: '', upstream: '', kind: 'vendored', surfaces: ['tool'], paths: [`vendor/${name}/`], undeclared: true });
      continue;
    }
    const s = JSON.parse(raw);
    const haveLicenceFile = await fs.access(path.join(root, 'vendor', name, s.licenceFile || 'LICENSE')).then(() => true, () => false);
    const prefix = `vendor/${name}/`;
    const surfaces = [];
    if ([...bundled].some((f) => f.startsWith(prefix))) surfaces.push('runtime');
    if ((await sourcesNaming(name, ['app', 'blog', 'cli', 'index.html'])).length) surfaces.push('tool');
    items.push({ name: s.name, version: s.version, licence: haveLicenceFile ? s.licence : '', upstream: s.upstream, kind: 'vendored', surfaces: surfaces.length ? surfaces : ['tool'], paths: [prefix], ...(haveLicenceFile ? {} : { missingLicenceFile: s.licenceFile || 'LICENSE' }) });
  }

  // npm: from the lockfile; nothing here is shipped unless it is bundled
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  for (const [k, v] of Object.entries(lock.packages || {})) {
    if (!k) continue;
    const name = k.replace(/^node_modules\//, '');
    items.push({ name, version: v.version || '', licence: v.license || '', upstream: v.resolved ? `https://www.npmjs.com/package/${name}` : '', kind: 'npm', surfaces: [v.dev ? 'dev' : 'tool'], paths: [k + '/'] });
  }

  items.push({ name: 'blog-webCLI runtime', version: JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version, licence: 'MIT', upstream: 'https://github.com/tejaswigowda/blog-webCLI', kind: 'first-party', surfaces: ['runtime'], paths: ['lib/'] });
  items.push({ name: 'blog-webCLI tool', version: JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version, licence: 'GPL-3.0-only', upstream: 'https://github.com/tejaswigowda/blog-webCLI', kind: 'first-party', surfaces: ['tool'], paths: ['app/', 'cli/', 'blog/', 'index.html'] });
  items.sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : 1) : a.kind < b.kind ? -1 : 1));
  return { items, bundled: [...bundled].sort() };
}

export async function build() {
  const { items, bundled } = await collect();
  const found = violations(items.map((i) => (i.undeclared ? { ...i, licence: '' } : i)), bundled);
  for (const i of items) if (i.undeclared) found.push(`vendor/${i.name}/ has no SOURCE.json: say what it is, its licence and its upstream`);
  const text = `${JSON.stringify({
    version: 1,
    $comment: 'Generated by `node cli/inventory.js`; never edit by hand. surfaces: runtime = built into the scripts generated pages load; tool = the editor, reader and CLI; dev = build and test only.',
    policy: { runtimeAllowed: RUNTIME_ALLOWED, toolAllowed: TOOL_ALLOWED },
    runtimeBuiltFrom: bundled,
    items: items.map(({ undeclared, missingLicenceFile, ...i }) => i),
  }, null, 2)}\n`;
  return { text, violations: found };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { text, violations: found } = await build();
  const file = path.join(root, 'licences-inventory.json');
  if (process.argv.includes('--check')) {
    const have = await fs.readFile(file, 'utf8').catch(() => '');
    let bad = false;
    if (have !== text) {
      console.error('licences-inventory.json is stale: run `node cli/inventory.js` and commit it');
      bad = true;
    }
    for (const v of found) console.error(`licence: ${v}`);
    if (found.length) bad = true;
    if (bad) process.exit(1);
    console.log(`ok: licences-inventory.json is current; nothing unlicensed or copyleft reaches the runtime`);
  } else {
    await fs.writeFile(file, text);
    console.log(`wrote licences-inventory.json${found.length ? ` (${found.length} violation(s): ${found.join('; ')})` : ''}`);
    if (found.length) process.exit(1);
  }
}

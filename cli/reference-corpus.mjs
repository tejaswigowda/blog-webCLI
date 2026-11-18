import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, appendFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOrder } from '../lib/order.js';

const [site, tier, reference, baseline] = process.argv.slice(2);
if (!/^[a-z]+(?:-[a-z]+)?$/.test(site || '') || !['fixture', 'full'].includes(tier) || !reference || !baseline) {
  throw new Error('usage: reference-corpus.mjs <site> <fixture|full> <source-dir> <approved-generator-dir>');
}
const candidate = fileURLToPath(new URL('./blog.js', import.meta.url));
const approved = path.resolve(baseline, 'cli/blog.js');
const scratch = await mkdtemp(path.join(tmpdir(), 'webcli-reference-'));
const line = async (value) => {
  console.log(value);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${value}\n`);
};
const optional = async (src, dest) => {
  if (await access(src).then(() => true, (e) => {
    if (e.code === 'ENOENT') return false;
    throw e;
  })) await cp(src, dest, { recursive: true });
};

async function stage(dir) {
  await mkdir(dir);
  const blog = JSON.parse(await readFile(path.join(reference, 'blog.json'), 'utf8'));
  const order = resolveOrder(blog);
  for (const name of ['blog.json', 'assets.lock.json', 'pages']) {
    await optional(path.join(reference, name), path.join(dir, name));
  }
  // Keep the entire source if it has an authored order: dropping a slug changes the meaning of that list.
  if (tier === 'full' || order.by === 'manual') {
    if (order.by === 'manual') await cp(path.join(reference, order.list), path.join(dir, order.list));
    for (const name of ['posts', 'comments']) await optional(path.join(reference, name), path.join(dir, name));
    return;
  }
  const posts = await readdir(path.join(reference, 'posts')).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  const names = posts.filter((name) => name.endsWith('.md')).sort();
  const ranked = [];
  const features = [/\n(?:status: draft|publishAt:)/, /\n(?:aliases|canonical|parent):/, /asset:/, /\n\|/, /<\/(?:a|iframe|div)>/, /[?&](?:tag|subId|sscid|clickid|irgwc|ranMID|awc)=/i, /\$\d/, /\\\(|\b(?:math|md)\b(?=\n)/];
  for (const name of names) {
    const text = await readFile(path.join(reference, 'posts', name), 'utf8');
    ranked.push({ name, score: features.reduce((n, feature) => n + Number(feature.test(text)), 0) });
  }
  ranked.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
  await mkdir(path.join(dir, 'posts'));
  await mkdir(path.join(dir, 'comments'));
  for (const { name } of ranked.slice(0, 20)) {
    await cp(path.join(reference, 'posts', name), path.join(dir, 'posts', name));
    const comments = `comments/${name.replace(/\.md$/, '.json')}`;
    await optional(path.join(reference, comments), path.join(dir, comments));
  }
  await line(`${site}: selected ${Math.min(ranked.length, 20)} posts plus all standalone pages`);
}

function run(cli, subcommand, dir, ...args) {
  // Do not emit source paths, refusal details or asset URLs from private repositories in Actions logs.
  const result = spawnSync(process.execPath, [cli, subcommand, dir, ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

async function snapshot(dir, prefix = '', files = new Map()) {
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const name = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) await snapshot(dir, name, files);
    // Runtime bytes are already covered by check:live and browser tests; still compare their presence.
    else files.set(name, /^webcli-(live|math|search|slideshow)\.js$/.test(name) ? 'runtime' :
      createHash('sha256').update(await readFile(path.join(dir, name))).digest('hex'));
  }
  return files;
}

try {
  const previous = path.join(scratch, 'approved');
  const next = path.join(scratch, 'candidate');
  await stage(previous);
  await cp(previous, next, { recursive: true });
  const baseBuild = run(approved, 'build', previous);
  const start = performance.now();
  const build = run(candidate, 'build', next);
  await line(`${site} (${tier}): candidate build ${(performance.now() - start).toFixed(0)} ms`);
  const failures = [];
  if (build.status !== 0) failures.push('candidate build refused');
  else {
    const requireAsset = site !== 'lyceum-films'; // The catalogue's root site supplies the required probe.
    const check = run(candidate, 'check', next, ...(requireAsset ? ['--require-asset'] : []));
    if (requireAsset) await line(`${site}: anonymous pinned-asset check ${check.status === 0 ? 'passed' : 'failed or not reached'}`);
    if (check.status !== 0) failures.push('regenerate check or anonymous pinned-asset verification failed');
  }
  if (baseBuild.status !== 0) failures.push('approved generator could not establish a baseline');
  if (baseBuild.status === 0 && build.status === 0) {
    const before = await snapshot(previous);
    const after = await snapshot(next);
    let changed = 0;
    for (const name of new Set([...before.keys(), ...after.keys()])) if (before.get(name) !== after.get(name)) changed++;
    if (changed) failures.push(`${changed} regenerated file(s) differ from approved generator`);
  }
  if (failures.length) {
    await line(`${site}: ${failures.join('; ')}`);
    process.exitCode = 1;
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

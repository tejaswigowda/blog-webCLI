// Logical asset references: `asset:<repo-key>/<path>`. Source files name a key and a
// path, never a provider. blog.json maps keys to repos and holds the URL template;
// assets.lock.json pins each referenced file to a commit sha.
import { Refusal } from './errors.js';
import { at, parseRepoRef } from './reporef.js';
import { embedUrls } from './blockrefs.js';

const KEY = /^[a-z0-9][a-z0-9_-]*$/;

export function isAssetRef(s) {
  return typeof s === 'string' && s.startsWith('asset:');
}

export function parseAssetRef(ref) {
  const m = /^asset:([^/\s]+)\/(.+)$/.exec(ref || '');
  if (!m || !KEY.test(m[1]) || m[2].split('/').some((p) => p === '' || p === '.' || p === '..') || /\s/.test(m[2])) {
    throw new Refusal('unresolved-asset', `"${ref}" is not a valid asset reference (asset:<repo-key>/<path>)`);
  }
  return { key: m[1], path: m[2] };
}

export const lockKey = (ref) => ref.replace(/^asset:/, '');

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

export function resolveAsset(ref, blog, lock = {}) {
  const { key, path } = parseAssetRef(ref);
  const repo = blog.assets && blog.assets.repos && blog.assets.repos[key];
  if (!repo) throw new Refusal('unresolved-asset', `${ref}: blog.json has no asset repo "${key}"`);
  const sha = lock[`${key}/${path}`];
  if (!sha) throw new Refusal('unresolved-asset', `${ref}: not pinned in assets.lock.json`);
  const { repo: full, folder } = parseRepoRef(repo);
  const [owner, name] = full.split('/');
  return blog.assets.base
    .replace('{owner}', owner)
    .replace('{repo}', name)
    .replace('{sha}', sha)
    .replace('{path}', enc(at(folder, path)));
}

// Hostnames that identify an asset provider. A post that names one is refused (B6).
const KNOWN_PROVIDERS = ['cdn.jsdelivr.net', 'raw.githubusercontent.com', 'githubusercontent.com', 'unpkg.com', 'rawcdn.githack.com', 'raw.githack.com'];

export function providerHosts(blog) {
  const hosts = new Set(KNOWN_PROVIDERS);
  try {
    if (blog.assets) hosts.add(new URL(blog.assets.base.replace(/\{[a-z]+\}/g, 'x')).hostname);
    if (blog.video) hosts.add(new URL(blog.video.base.replace(/\{[a-z]+\}/g, 'x')).hostname);
  } catch {
    /* validated elsewhere */
  }
  return hosts;
}

export function namesProvider(url, blog) {
  // A link to the player is a provider address too: videos are embedded by reference.
  if (blog.video && url.startsWith(blog.video.player)) return true;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const p of providerHosts(blog)) if (host === p || host.endsWith('.' + p)) return true;
  return false;
}

// Only these URL forms may appear in rendered output.
export function isSafeUrl(url) {
  if (isAssetRef(url)) return true;
  if (/^(https?:|mailto:)/i.test(url)) return true;
  // javascript:, data:, vbscript: and every other scheme are refused; relative URLs pass.
  return !/^[a-z][a-z0-9+.-]*:/i.test(url);
}

export function collectAssetRefs(delta, meta = {}) {
  const refs = new Set();
  if (isAssetRef(meta.cover)) refs.add(meta.cover);
  if (isAssetRef(meta.image)) refs.add(meta.image);
  for (const op of delta.ops) {
    if (op.insert && typeof op.insert === 'object' && isAssetRef(op.insert.image)) refs.add(op.insert.image);
    if (op.attributes && isAssetRef(op.attributes.link)) refs.add(op.attributes.link);
  }
  for (const { url } of embedUrls(delta)) if (isAssetRef(url)) refs.add(url);
  return [...refs].sort();
}

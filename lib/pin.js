// Pins: a theme or extension is named by { repo, ref, sha256 }. `ref` is a release tag or a
// commit, never a branch, and the sha256 covers the files, so a tag that is moved or a repository
// that is rewritten is caught instead of silently restyling every page it ever touched.
import { Refusal } from './errors.js';
import { isRepoRef } from './reporef.js';
import { sha256 } from './sha256.js';

export const SHA_RE = /^[0-9a-f]{40}$/;
export const HASH_RE = /^[0-9a-f]{64}$/;
// v1.2.0, 1.2, 2.0.0-rc.1 — the shapes a release tag takes. main, master, HEAD, latest, dev are not.
const TAG_RE = /^v?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/;

export const isPinnedRef = (ref) => typeof ref === 'string' && (SHA_RE.test(ref) || TAG_RE.test(ref));

export function validatePin(pin, what, code = 'unpinned-ref') {
  const bad = (c, m) => new Refusal(c, `${what}: ${m}`);
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) throw bad('bad-blog-json', 'must be an object with repo, ref and sha256');
  if (typeof pin.repo !== 'string' || !isRepoRef(pin.repo)) throw bad('bad-blog-json', '"repo" must be owner/name or owner/name/folder');
  if (!isPinnedRef(pin.ref)) throw bad(code, `"${pin.ref}" is not a release tag (v1.2.0) or a commit sha; a branch can move and is refused`);
  if (typeof pin.sha256 !== 'string' || !HASH_RE.test(pin.sha256)) throw bad('bad-blog-json', '"sha256" must be 64 hex characters');
  return pin;
}

export const pinLabel = (pin) => `${pin.repo}@${pin.ref}`;

// The hash a blog pins: every file a theme or extension declares, by path and content.
export function filesDigest(files, paths, fail) {
  const lines = paths.map((p) => {
    if (!(p in files)) throw fail(`"${p}" is listed but is not in the repository`);
    return `${p} ${sha256(files[p])}\n`;
  });
  return sha256(lines.join(''));
}

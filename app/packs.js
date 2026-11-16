// Fetching a theme from its repository, at a pinned ref, and verifying it.
// Works with any client that has readBytes / tagExists / branchExists (the app's GitHub class,
// which the CLI also uses). Themes contain CSS and data, never executable code.
import { Refusal } from '../lib/errors.js';
import { at, parseRepoRef } from '../lib/reporef.js';
import { SHA_RE, validatePin } from '../lib/pin.js';
import { loadTheme, pinFor, themeDigest, themeFilePaths, validateThemeManifest } from '../lib/theme-pack.js';

const dec = new TextDecoder();
const cache = new Map();

// A tag, or a commit. Never a branch, and never a name that is both (it would mean two things).
export async function assertRefKind(gh, repo, ref, what) {
  if (SHA_RE.test(ref)) return 'commit';
  const tag = await gh.tagExists(repo, ref);
  const branch = await gh.branchExists(repo, ref);
  if (branch && tag) throw new Refusal('unpinned-ref', `${what}: "${ref}" is both a tag and a branch in ${repo}; pin the commit sha instead`);
  if (branch) throw new Refusal('unpinned-ref', `${what}: "${ref}" is a branch in ${repo}. A branch can move; pin a release tag or a commit.`);
  if (!tag) throw new Refusal('unpinned-ref', `${what}: ${repo} has no tag "${ref}". Pin an existing release tag or a commit.`);
  return 'tag';
}

async function readFiles(gh, where, ref, paths, bad) {
  const { repo, folder } = parseRepoRef(where);
  const files = {};
  for (const p of paths) {
    const bytes = await gh.readBytes(repo, at(folder, p), ref);
    if (bytes === null) throw bad(`${where}@${ref} has no ${p}`);
    files[p] = bytes;
  }
  return files;
}

const badTheme = (m) => new Refusal('bad-theme', m);

async function manifestOf(gh, where, ref, file, bad, validate) {
  const { repo, folder } = parseRepoRef(where);
  const bytes = await gh.readBytes(repo, at(folder, file), ref);
  if (bytes === null) throw bad(`${where}@${ref} has no ${file}`);
  let manifest;
  try {
    manifest = JSON.parse(dec.decode(bytes));
  } catch (e) {
    throw bad(`${file} is not valid JSON (${e.message})`);
  }
  validate(manifest);
  return { manifest, bytes };
}

// ---- reading a pack to PIN it (no digest yet): returns what blog.json should record ----

// A registry entry is a claim about a repository, never a source for the pin: when the entry states a sha256 or a licence
// and what the app computes differs, nothing is pinned.
export function checkRegistryClaim(expect, pin) {
  if (!expect) return;
  if (expect.sha256 && expect.sha256 !== pin.sha256) throw new Refusal('registry-mismatch', `The registry lists ${pin.repo}@${pin.ref} with sha256 ${expect.sha256}, but the repository hashes to ${pin.sha256}. Nothing was pinned.`);
  if (expect.licence && expect.licence !== pin.licence) throw new Refusal('registry-mismatch', `The registry lists ${pin.repo}@${pin.ref} as ${expect.licence}, but its manifest says ${pin.licence}. Nothing was pinned.`);
}

export async function readThemeToPin(gh, where, ref, { base, expect } = {}) {
  const r = parseRepoRef(where);
  await assertRefKind(gh, r.repo, ref, 'theme');
  const { manifest, bytes } = await manifestOf(gh, where, ref, 'theme.json', badTheme, validateThemeManifest);
  const files = { 'theme.json': bytes, ...(await readFiles(gh, where, ref, themeFilePaths(manifest).filter((p) => p !== 'theme.json'), badTheme)) };
  const digest = themeDigest(files, themeFilePaths(manifest));
  const pin = pinFor(r.ref, ref, manifest, digest, base);
  checkRegistryClaim(expect, pin);
  const theme = loadTheme(pin, files); // proves the css passes before anything is written
  return { pin, theme, manifest };
}

// ---- loading what a blog.json already pins ----

export async function loadPinnedTheme(gh, pin) {
  validatePin(pin, 'theme');
  const key = `t:${pin.repo}@${pin.ref}:${pin.sha256}`;
  if (cache.has(key)) return cache.get(key);
  await assertRefKind(gh, parseRepoRef(pin.repo).repo, pin.ref, 'theme');
  const { manifest, bytes } = await manifestOf(gh, pin.repo, pin.ref, 'theme.json', badTheme, validateThemeManifest);
  const files = { 'theme.json': bytes, ...(await readFiles(gh, pin.repo, pin.ref, themeFilePaths(manifest).filter((p) => p !== 'theme.json'), badTheme)) };
  const theme = loadTheme(pin, files);
  cache.set(key, theme);
  return theme;
}

export async function loadPacks(gh, blog) {
  const theme = blog.theme && typeof blog.theme === 'object' ? await loadPinnedTheme(gh, blog.theme) : null;
  return { theme };
}

export const clearPackCache = () => cache.clear();

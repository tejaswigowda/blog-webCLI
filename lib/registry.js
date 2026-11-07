// The registry of themes and extensions: a list in a data repository (blog-registry), read by URL. It is data, never authority (R7).
// A registry entry is turned into exactly { name, repo, ref, licence, blurb, screenshot?, sha256? } or refused: nothing else in the
// file reaches the app, a screenshot is an https address or nothing, every string is bounded, and the result is only ever rendered
// as text. A theme is still pinned by what the app computes from its repository at that ref; the registry cannot cause any code to
// run, at read time or at all, and a theme with no entry works by its address.
// This file imports nothing, so the registry repository's own checks run this exact file (cli/registry.js copies it there).

export const REGISTRY_VERSION = 1;
export const KINDS = Object.freeze({ themes: 'themes', extensions: 'extensions' });
export const MAX_ENTRIES = 200;
export const FIELDS = Object.freeze(['name', 'repo', 'ref', 'licence', 'blurb', 'screenshot', 'sha256']);

const NAME = /^[^\u0000-\u001f\u007f<>]{1,60}$/u;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100})*$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;
const LICENCE = /^[A-Za-z0-9.+() -]{1,80}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BLURB_MAX = 300;
const HTTPS = /^https:\/\/[^\s<>"'\\]{1,300}$/;

const plain = (v) => typeof v === 'string' && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v);

// -> { ok: true, entry } | { ok: false, why }
export function validateEntry(kind, e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, why: 'not an object' };
  if (typeof e.name !== 'string' || !NAME.test(e.name.trim())) return { ok: false, why: 'name must be 1-60 characters of plain text' };
  if (typeof e.repo !== 'string' || !REPO.test(e.repo) || e.repo.split('/').some((s) => s === '.' || s === '..')) return { ok: false, why: 'repo must be owner/name or owner/name/folder' };
  if (typeof e.ref !== 'string' || !REF.test(e.ref) || e.ref.includes('..') || e.ref.endsWith('/')) return { ok: false, why: 'ref must be a tag or a commit' };
  if (typeof e.licence !== 'string' || !LICENCE.test(e.licence)) return { ok: false, why: 'licence must be an SPDX identifier' };
  const entry = { name: e.name.trim(), repo: e.repo, ref: e.ref, licence: e.licence };
  if (e.blurb !== undefined) {
    if (!plain(e.blurb) || e.blurb.length > BLURB_MAX) return { ok: false, why: `blurb must be plain text of at most ${BLURB_MAX} characters` };
    if (e.blurb.trim()) entry.blurb = e.blurb.trim();
  }
  if (kind === KINDS.themes && e.screenshot !== undefined) {
    if (typeof e.screenshot !== 'string' || !HTTPS.test(e.screenshot)) return { ok: false, why: 'screenshot must be an https address' };
    entry.screenshot = e.screenshot;
  }
  if (e.sha256 !== undefined) {
    if (typeof e.sha256 !== 'string' || !SHA256.test(e.sha256)) return { ok: false, why: 'sha256 must be 64 lowercase hex digits' };
    entry.sha256 = e.sha256;
  }
  return { ok: true, entry };
}

// A registry file for `kind`: { version: 1, <kind>: [ …entries ] }. A file that is not that shape is refused whole (the caller falls
// back); an entry that is not valid is dropped alone, and said. -> { entries, rejected: [{ index, name, why }] }
export function parseRegistry(kind, input) {
  if (!(kind in KINDS)) throw new Error(`unknown registry kind "${kind}"`);
  let doc = input;
  if (typeof input === 'string') {
    try {
      doc = JSON.parse(input);
    } catch {
      throw new Error('the registry is not JSON');
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('the registry is not an object');
  if (doc.version !== REGISTRY_VERSION) throw new Error(`the registry is version ${JSON.stringify(doc.version)}; this app reads version ${REGISTRY_VERSION}`);
  const list = doc[kind];
  if (!Array.isArray(list)) throw new Error(`the registry has no "${kind}" list`);
  if (list.length > MAX_ENTRIES) throw new Error(`the registry lists ${list.length} ${kind}; the most read is ${MAX_ENTRIES}`);
  const entries = [];
  const rejected = [];
  const seen = new Set();
  list.forEach((raw, index) => {
    const v = validateEntry(kind, raw);
    if (!v.ok) return rejected.push({ index, name: raw && typeof raw.name === 'string' ? raw.name.slice(0, 60) : '', why: v.why });
    const key = `${v.entry.repo}`;
    if (seen.has(key)) return rejected.push({ index, name: v.entry.name, why: `${v.entry.repo} is listed twice` });
    seen.add(key);
    entries.push(v.entry);
  });
  return { entries, rejected };
}

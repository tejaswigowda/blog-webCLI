// A video release, as hls.webcli.app defines it: a folder <name>/ holding an HLS render
// (master.m3u8, render.json, files.sha256, poster, one folder of segments per rung), published as
// one commit and one tag <name>/v<N> that never moves. This is the pure part of making one from the
// blog app, which does it under the hood (an uploaded video is encoded by app/encode.js; a render
// folder already in the repository is tagged): what a release must look like, and which version
// comes next.
import { Refusal } from './errors.js';
import { sha256Bytes } from './sha256.js';

export const RELEASE_NAME = /^[a-z0-9]+(?:[+-][a-z0-9]+)*$/; // hls-webCLI's slug rule
export const LIMITS = { files: 2000, file: 50 * 1024 * 1024, total: 300 * 1024 * 1024 };

const EXTENSIONS = new Set(['m3u8', 'm4s', 'mp4', 'ts', 'aac', 'm4a', 'vtt', 'jpg', 'jpeg', 'png', 'webp', 'json', 'sha256', 'txt']);
const PATH = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.+-]*)*$/;
const dec = new TextDecoder();

const bad = (m, where) => new Refusal('bad-release', m, where);

export const releaseTag = (name, version) => `${name}/v${version}`;

// The versions of <name> among a repository's tags, ascending.
export function versionsOf(tags, name) {
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/v([1-9]\\d*)$`);
  return tags.map((t) => re.exec(t)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
}
export const nextVersion = (tags, name) => (versionsOf(tags, name).pop() || 0) + 1;

// Folders directly under `prefix` ("videos/" or "") that hold a master.m3u8, from a repository tree.
export function releaseFolders(tree, prefix) {
  const out = new Set();
  for (const path of tree.keys()) {
    if (!path.startsWith(prefix)) continue;
    const m = /^([^/]+)\/master\.m3u8$/.exec(path.slice(prefix.length));
    if (m && RELEASE_NAME.test(m[1])) out.add(m[1]);
  }
  return [...out].sort();
}

// Every URI in a playlist, which must stay inside the release.
function playlistUris(text) {
  const uris = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) for (const m of t.matchAll(/URI="([^"]*)"/g)) uris.push(m[1]);
    else uris.push(t);
  }
  return uris;
}

// files: [{ path, bytes }] relative to the release. Refuses rather than repairs.
export function checkRelease(name, files) {
  if (!RELEASE_NAME.test(name || '')) throw bad(`"${name}" is not a valid release name: lowercase words joined by "-" (hls.webcli.app's rule)`);
  if (!files.length) throw bad('there are no files in this release');
  if (files.length > LIMITS.files) throw bad(`${files.length} files; a release is limited to ${LIMITS.files}`);
  let total = 0;
  const byPath = new Map();
  for (const f of files) {
    if (!PATH.test(f.path) || f.path.split('/').some((s) => s === '..' || s === '.')) throw bad(`"${f.path}" is not a safe file name (letters, digits, ".", "_", "-", "+" and folders)`, f.path);
    const ext = (f.path.split('.').pop() || '').toLowerCase();
    if (!EXTENSIONS.has(ext)) throw bad(`"${f.path}": a release holds playlists, segments, captions, a poster and its manifests; .${ext} is not one of them`, f.path);
    if (f.bytes.length > LIMITS.file) throw bad(`"${f.path}" is ${(f.bytes.length / 1048576).toFixed(0)} MB; the limit is ${LIMITS.file / 1048576} MB a file`, f.path);
    if (byPath.has(f.path)) throw bad(`"${f.path}" appears twice`, f.path);
    total += f.bytes.length;
    byPath.set(f.path, f);
  }
  if (total > LIMITS.total) throw bad(`${(total / 1048576).toFixed(0)} MB in all; the limit is ${LIMITS.total / 1048576} MB. Split it into shorter videos.`);
  if (!byPath.has('master.m3u8')) throw bad('master.m3u8 is missing: that is how a release is recognised');

  // a release that depends on another host is not a release: the lock-in this app exists to avoid
  for (const f of files) {
    if (!f.path.endsWith('.m3u8')) continue;
    for (const uri of playlistUris(dec.decode(f.bytes))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('/') || uri.split('/').includes('..')) throw bad(`${f.path} points outside the release (${uri.slice(0, 60)}). Playlists must use relative file names only.`, f.path);
    }
  }

  // files.sha256 is hls-webCLI's own check (sha256sum format); when present it must hold
  const sums = byPath.get('files.sha256');
  if (sums) {
    for (const line of dec.decode(sums.bytes).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = /^([0-9a-f]{64})[ \t]+\*?(?:\.\/)?(.+)$/.exec(line.trim());
      if (!m) throw bad(`files.sha256 has a line that is not in sha256sum format: ${line.slice(0, 60)}`, 'files.sha256');
      const f = byPath.get(m[2]);
      if (!f) throw bad(`files.sha256 lists ${m[2]}, which is not in the folder`, 'files.sha256');
      if (sha256Bytes(f.bytes) !== m[1]) throw bad(`${m[2]} does not match files.sha256: it changed after the render was made`, m[2]);
    }
  }
  return { files: [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1)), bytes: total };
}

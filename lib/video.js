// Video embeds: `video:<key>/<slug>@v<N>` names a release published by hls.webcli.app
// (hls-webCLI) into a "renders" repository, tagged `<slug>/v<N>`. A tag never moves, so
// the reference is pinned by construction. blog.json maps keys to repos and holds the
// player and CDN templates; a post never names a provider.
import { Refusal } from './errors.js';
import { at, isRepoRef, parseRepoRef } from './reporef.js';

const KEY = /^[a-z0-9][a-z0-9_-]*$/;
// hls-webCLI's SLUG_RULE: lowercase words joined by "-", a "+" allowed between words.
const SLUG = /^[a-z0-9]+(?:[+-][a-z0-9]+)*$/;
export const VIDEO_REF = /^video:([a-z0-9][a-z0-9_-]*)\/([a-z0-9]+(?:[+-][a-z0-9]+)*)@v([1-9]\d*)$/;

export const isVideoRef = (s) => typeof s === 'string' && s.startsWith('video:');

export function parseVideoRef(ref) {
  const m = VIDEO_REF.exec(ref || '');
  if (!m || !KEY.test(m[1]) || !SLUG.test(m[2])) {
    throw new Refusal('unresolved-asset', `"${ref}" is not a valid video reference (video:<repo-key>/<name>@v<N>)`);
  }
  const version = Number(m[3]);
  return { key: m[1], slug: m[2], version, tag: `${m[2]}/v${version}` };
}

export const videoLabel = (ref) => {
  const { slug, version } = parseVideoRef(ref);
  return `${slug} v${version}`;
};

function config(blog, ref) {
  const v = blog.video;
  if (!v) throw new Refusal('unresolved-asset', `${ref}: blog.json has no "video" section`);
  return v;
}

// The pinned folder the player is given (hls-webCLI's releaseBase).
export function videoBase(ref, blog) {
  const { key, slug, tag } = parseVideoRef(ref);
  const v = config(blog, ref);
  const repo = v.repos[key];
  if (!repo) throw new Refusal('unresolved-asset', `${ref}: blog.json has no video repo "${key}"`);
  const { repo: full, folder } = parseRepoRef(repo);
  const [owner, name] = full.split('/');
  // In a shared repository the release folder sits inside the video folder.
  return v.base.replace('{owner}', owner).replace('{repo}', name).replace('{tag}', tag).replace('{slug}', at(folder, slug));
}

// The address an <iframe> loads: the player, the pinned folder, and the video-only view.
export function videoEmbedUrl(ref, blog) {
  return `${config(blog, ref).player}#${videoBase(ref, blog)}&present=true`;
}

export function collectVideoRefs(delta) {
  const refs = new Set();
  for (const op of delta.ops) if (op.insert && typeof op.insert === 'object' && isVideoRef(op.insert.video)) refs.add(op.insert.video);
  return [...refs].sort();
}

export function validateVideoConfig(v, bad) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('"video" must be an object');
  if (typeof v.player !== 'string' || !/^https:\/\/[^\s#]+$/.test(v.player)) throw bad('"video.player" must be an https URL');
  if (typeof v.base !== 'string' || !/^https:\/\//.test(v.base) || !['{tag}', '{slug}'].every((t) => v.base.includes(t)) || !v.base.endsWith('/')) {
    throw bad('"video.base" must be an https URL template ending in "/" and containing {tag} and {slug}');
  }
  if (!v.repos || typeof v.repos !== 'object' || !Object.keys(v.repos).length) throw bad('"video.repos" must map keys to owner/name');
  for (const [k, r] of Object.entries(v.repos)) {
    if (!KEY.test(k) || !isRepoRef(r)) throw bad(`video.repos.${k} must be a lowercase key mapped to owner/name or owner/name/folder`);
  }
}

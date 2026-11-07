// A post's cover. `cover: asset:images/x.png` names one; `cover: auto` lets the generator pick the
// post's own picture: its first image, else the poster of its first video (every hls release has a
// poster.jpg, at a pinned address because the tag never moves). An automatic cover is the preview
// image when the post is shared (og:image) and in the index; it is not drawn on the page, where it
// would repeat what the post already shows. With nothing to pick, the blog's own cover applies.
import { isAssetRef } from './assets.js';
import { isVideoRef, videoBase } from './video.js';
import { embedUrls } from './blockrefs.js';

export const AUTO_COVER = 'auto';
export const isCoverValue = (v) => v === AUTO_COVER || (typeof v === 'string' && /^asset:/.test(v));

// -> { ref: 'asset:…' } | { url: 'https://…/poster.jpg' } | null
export function autoCover(delta, blog) {
  const embeds = delta.ops.map((op) => (op.insert && typeof op.insert === 'object' ? op.insert : null)).filter(Boolean);
  const image = embeds.find((e) => isAssetRef(e.image));
  if (image) return { ref: image.image };
  const inBlock = embedUrls(delta).find((u) => u.kind === 'image' && isAssetRef(u.url));
  if (inBlock) return { ref: inBlock.url };
  const video = embeds.find((e) => isVideoRef(e.video));
  if (video) return { url: `${videoBase(video.video, blog)}poster.jpg` };
  return null;
}

// The first picture a post shows, as written: an asset: reference or an http(s) address (an image that stayed linked to
// another site). Looks through paragraphs, tables and HTML blocks in order. Null when there is none.
// Used by card listings for a post with no cover of its own.
export function firstImage(delta) {
  const usable = (u) => typeof u === 'string' && (isAssetRef(u) || /^https?:\/\/[^\s"'<>]+$/i.test(u));
  for (const op of delta.ops || []) {
    const v = op.insert;
    if (!v || typeof v !== 'object') continue;
    if (usable(v.image)) return v.image;
    if (v.mdtable || v.htmlblock) {
      const hit = embedUrls({ ops: [op] }).find((u) => u.kind === 'image' && usable(u.url));
      if (hit) return hit.url;
    }
  }
  return null;
}

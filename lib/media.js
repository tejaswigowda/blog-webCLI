// The media view: what is in the images repository, as tiles an author can pick, see, copy and judge as used or unused.
// Pure: the caller lists the repository (a tree of path -> sha) and reads assets.lock.json and index/posts.json.
// Four jobs only: pick an existing image, see what is there, copy its asset: reference, show what nothing references.
import { parseRepoRef } from './reporef.js';

export const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

// tree: Map(path -> sha) of the whole repository; where: the blog's `assets.repos[key]` (owner/name or owner/name/folder).
// -> the image files inside that folder, as paths relative to it (the path an asset: reference carries).
export function imagePaths(tree, where) {
  const { folder } = parseRepoRef(where);
  const prefix = folder ? `${folder}/` : '';
  return [...tree.keys()].filter((p) => p.startsWith(prefix) && IMAGE_FILE.test(p)).map((p) => p.slice(prefix.length)).sort();
}

// What a post or blog.json names without the lock knowing it yet is not here: the lock pins every asset a published or scheduled
// post or a blog.json field references (the editor refuses to publish otherwise), and the index names each cover. So an image that
// is in neither is referenced by no published page. A draft may still mention one that is not pinned yet.
export function usedRefs(lock, index) {
  const used = new Set(Object.keys(lock || {}));
  for (const e of (index && index.posts) || []) if (typeof e.cover === 'string' && e.cover.startsWith('asset:')) used.add(e.cover.slice('asset:'.length));
  return used;
}

// -> [{ key, path, ref, size?, pinned, unused }] for one asset repository.
export function mediaItems({ key, paths, lock, index }) {
  const used = usedRefs(lock, index);
  return paths.map((path) => ({ key, path, ref: `asset:${key}/${path}`, pinned: !!(lock && lock[`${key}/${path}`]), unused: !used.has(`${key}/${path}`) }));
}

// The address a tile loads from: the pinned CDN address a page would use, or, for an image not pinned yet, the repository's head.
export function tileUrl(blog, key, path, sha) {
  const where = blog.assets && blog.assets.repos && blog.assets.repos[key];
  if (!where || !sha) return null;
  const { repo, folder } = parseRepoRef(where);
  const [owner, name] = repo.split('/');
  return blog.assets.base.replace('{owner}', owner).replace('{repo}', name).replace('{sha}', sha).replace('{path}', enc(folder ? `${folder}/${path}` : path));
}

export const filterMedia = (items, { query = '', onlyUnused = false } = {}) => {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((i) => (!onlyUnused || i.unused) && tokens.every((t) => i.path.toLowerCase().includes(t)));
};

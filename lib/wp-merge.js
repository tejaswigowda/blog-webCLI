// Adding imported posts to a blog that already exists. Nothing in the blog is replaced and its settings and theme are not touched:
// an imported post whose address is already in use is left out and said, an imported old address that the blog already uses for
// something else is dropped and said, and a picture the blog already has pinned is not sent again. Pure: the caller reads the
// blog's files and writes the result.
import { ROOT_NAMES, parseAliases } from './aliases.js';
import { joinFile, parseMeta, setMeta, splitFile } from './frontmatter.js';
import { addrOf } from './permalink.js';

const CONTENT = /^(?:posts|pages)\/([^/]+)\.md$/;
const COMMENTS = /^comments\/([^/]+)\.json$/;
const quiet = (fn, otherwise) => {
  try {
    return fn();
  } catch {
    return otherwise;
  }
};

// existing: [{ path, text }] the posts and pages already in the blog; files: the same, imported; assets: [{ path, bytes }] imported;
// lock: the blog's assets.lock.json. -> { files, skipped: [{ path, why }], assets, reusedAssets, notes: [{ where, text }] }
// importedPermalink: the permalink the import chose for the old site's addresses; intoPermalink: the blog's own. When they differ an
// imported post's old address is no longer where the post lives, so it becomes an alias.
export function mergeImported({ existing, files, assets = [], lock = {}, imagesKey = 'images', importedPermalink = null, intoPermalink = null }) {
  const slugs = new Set();
  const aliases = new Set();
  for (const f of existing) {
    const m = CONTENT.exec(f.path);
    if (!m) continue;
    slugs.add(m[1]);
    for (const a of quiet(() => parseAliases(parseMeta(splitFile(f.text, f.path).front, f.path), f.path), [])) aliases.add(a);
  }
  const skipped = [];
  const kept = [];
  for (const f of files) {
    const m = CONTENT.exec(f.path);
    const c = COMMENTS.exec(f.path); // the comments of an imported post: left out with the post, and never over a file the blog has
    if (m && slugs.has(m[1])) skipped.push({ path: f.path, why: 'a post or page with this address is already in the blog, and an import never replaces one' });
    else if (c && (slugs.has(c[1]) || existing.some((e) => e.path === f.path))) skipped.push({ path: f.path, why: 'the blog already has a post with this address (or comments for it), and an import never replaces one' });
    else kept.push(f);
  }
  const taken = new Set([...slugs, ...kept.map((f) => (CONTENT.exec(f.path) || [])[1]).filter(Boolean)]);
  const notes = [];
  const merged = kept.map((f) => {
    if (!CONTENT.test(f.path)) return f;
    const { front, body } = splitFile(f.text, f.path);
    const meta = quiet(() => parseMeta(front, f.path), {});
    const list = quiet(() => parseAliases(meta, f.path), []);
    const pathOf = (permalink) => addrOf({ permalink }, { slug: CONTENT.exec(f.path)[1], date: meta.date });
    // the import kept this post at a dated address; the blog it lands in does not use that pattern
    if (importedPermalink && importedPermalink !== (intoPermalink || '/{slug}/') && /^posts\//.test(f.path) && meta.date && meta.status === 'published') {
      const was = pathOf(importedPermalink);
      if (was !== pathOf(intoPermalink || '/{slug}/') && !list.includes(was)) list.push(was);
    }
    if (!list.length) return f;
    const ok = list.filter((a) => {
      const first = a.split('/')[0];
      const clash = ROOT_NAMES.has(first.toLowerCase()) || taken.has(first) || aliases.has(a);
      if (clash) notes.push({ where: f.path, text: `its old address /${a}/ could not be kept: the blog already uses it for something else` });
      else aliases.add(a);
      return !clash;
    });
    return ok.length === parseAliases(meta, f.path).length && ok.length === list.length ? f : { ...f, text: joinFile(setMeta(front, 'aliases', ok.length ? ok : null), body) };
  });
  const fresh = assets.filter((a) => !lock[`${imagesKey}/${a.path}`]);
  return { files: merged, skipped, assets: fresh, reusedAssets: assets.length - fresh.length, notes };
}

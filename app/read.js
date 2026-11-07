// Reading a blog from GitHub: the blog.json, the index, a post. Read-only and free of anything that
// publishes, fetches themes, or runs extensions, so the /blog/ reader can import it (gate X1 checks that).
import { Refusal } from '../lib/errors.js';
import { parsePost, validateBlog } from '../lib/blog.js';
import { SLUG_RE, parseMeta, splitFile } from '../lib/frontmatter.js';
import { resolveAsset } from '../lib/assets.js';
import { deltaToHtml } from '../lib/html.js';
import { videoEmbedUrl } from '../lib/video.js';
import { at, parseRepoRef } from '../lib/reporef.js';
import { DEFAULT_ORDER, parseOrderList, resolveOrder, sequenceOf } from '../lib/order.js';
import { readIndex } from '../lib/index-data.js';

export class NotFound extends Error {}

// `owner/name` or `owner/name/folder`; the folder is where the blog lives inside the repository.
export function parseRepo(s) {
  return parseRepoRef(s).ref;
}

// ---------- reading ----------

export async function loadBlog(gh, where, ref) {
  const { repo, folder } = parseRepoRef(where);
  const text = await gh.readText(repo, at(folder, 'blog.json'), ref);
  if (text === null) throw new Refusal('no-blog-json', `${repo} has no ${at(folder, 'blog.json')}`);
  const blog = validateBlog(text);
  const lockText = await gh.readText(repo, at(folder, 'assets.lock.json'), ref);
  return { blog, lock: lockText ? JSON.parse(lockText) : {} };
}

// The generated index when present: its posts in the blog's own order. The order is the build's to decide
// (lib/order.js) and is recorded as `sequence`; this only reads it, so a browser can never disagree with the
// pages. With no index yet (a blog nobody has built), the posts are listed from posts/ and put in order by the
// same module, from `blog` when the caller has it.
export async function loadIndexFull(gh, where, ref, { blog = null } = {}) {
  const { repo, folder } = parseRepoRef(where);
  const index = await readIndex((p) => gh.readText(repo, at(folder, p), ref));
  if (index !== null) {
    // Take the recorded sequence as it is: look each slug up, never compare two posts. (An entry the sequence does
    // not name, which a hand-edited index could have, follows in the order the file gives.)
    const byslug = new Map(index.posts.map((e) => [e.slug, e]));
    const named = (index.sequence || []).filter((s) => byslug.has(s));
    const posts = [...named.map((s) => byslug.get(s)), ...index.posts.filter((e) => !named.includes(e.slug))];
    return { posts, sequence: posts.map((e) => e.slug), order: index.order || { ...DEFAULT_ORDER } };
  }
  const names = await listPostFiles(gh, where, ref);
  const found = [];
  for (const n of names) {
    const raw = await gh.readText(repo, at(folder, `posts/${n}`), ref);
    try {
      const m = parseMeta(splitFile(raw, n).front, n);
      if (m.status === 'published') found.push({ slug: m.slug, path: `posts/${n}`, meta: m, entry: { slug: m.slug, title: m.title, date: m.date, tags: m.tags || [], excerpt: '', cover: m.cover && m.cover !== 'auto' ? m.cover : null, status: 'published' } });
    } catch {
      /* unreadable posts are simply not listed */
    }
  }
  const order = resolveOrder(blog || {});
  const list = order.by === 'manual' ? parseOrderList(await gh.readText(repo, at(folder, order.list), ref), order.list) : null;
  const seq = sequenceOf({ order, posts: found, files: new Set(names.map((n) => n.replace(/\.md$/, ''))), list });
  if (seq.errors.length) throw seq.errors[0];
  const byslug = new Map(found.map((f) => [f.slug, f.entry]));
  return { posts: seq.slugs.map((s) => byslug.get(s)), sequence: seq.slugs, order };
}

export async function loadIndex(gh, where, ref, opts) {
  return (await loadIndexFull(gh, where, ref, opts)).posts;
}

export async function listPostFiles(gh, where, ref) {
  const { repo, folder } = parseRepoRef(where);
  return (await gh.listDir(repo, at(folder, 'posts'), ref)).filter((n) => n.endsWith('.md'));
}

// The standalone pages (pages/<slug>.md): about, contact, …
export async function listPageFiles(gh, where, ref) {
  const { repo, folder } = parseRepoRef(where);
  return (await gh.listDir(repo, at(folder, 'pages'), ref)).filter((n) => n.endsWith('.md'));
}

export async function loadPost(gh, where, slug, ref, { blog, lock }, { allowDraft = false, kind = 'post' } = {}) {
  if (!SLUG_RE.test(slug)) throw new NotFound('No such post.');
  const { repo, folder } = parseRepoRef(where);
  const path = `${kind === 'page' ? 'pages' : 'posts'}/${slug}.md`;
  const text = await gh.readText(repo, at(folder, path), ref);
  if (text === null) throw new NotFound(kind === 'page' ? 'No such page.' : 'No such post.');
  const post = parsePost({ path, text });
  if (post.lossy) throw post.lossy.at(post.path);
  if (post.status !== 'published' && !allowDraft) throw new NotFound(kind === 'page' ? 'No such page.' : 'No such post.');
  const resolve = (r) => resolveAsset(r, blog, lock);
  const contract = blog.theme && typeof blog.theme === 'object' ? blog.theme.contract : undefined;
  return { post, text, html: deltaToHtml(post.delta, { resolve, resolveVideo: (r) => videoEmbedUrl(r, blog), strict: false, contract }) };
}

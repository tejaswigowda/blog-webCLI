// Reading a blog from GitHub: the blog.json, the index, a post. Read-only and free of anything that
// publishes, fetches themes, or runs extensions, so the /blog/ reader can import it (gate X1 checks that).
import { Refusal } from '../lib/errors.js';
import { parsePost, validateBlog } from '../lib/blog.js';
import { SLUG_RE, parseMeta, splitFile } from '../lib/frontmatter.js';
import { resolveAsset } from '../lib/assets.js';
import { deltaToHtml } from '../lib/html.js';
import { videoEmbedUrl } from '../lib/video.js';
import { at, parseRepoRef } from '../lib/reporef.js';

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

// The generated index when present; otherwise list posts/ and read frontmatter.
export async function loadIndex(gh, where, ref) {
  const { repo, folder } = parseRepoRef(where);
  const text = await gh.readText(repo, at(folder, 'index/posts.json'), ref);
  if (text !== null) return JSON.parse(text).posts;
  const names = (await listPostFiles(gh, where, ref));
  const entries = [];
  for (const n of names) {
    const raw = await gh.readText(repo, at(folder, `posts/${n}`), ref);
    try {
      const m = parseMeta(splitFile(raw, n).front, n);
      if (m.status === 'published') entries.push({ slug: m.slug, title: m.title, date: m.date, tags: m.tags || [], excerpt: '', cover: m.cover && m.cover !== 'auto' ? m.cover : null, status: 'published' });
    } catch {
      /* unreadable posts are simply not listed */
    }
  }
  return entries.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function listPostFiles(gh, where, ref) {
  const { repo, folder } = parseRepoRef(where);
  return (await gh.listDir(repo, at(folder, 'posts'), ref)).filter((n) => n.endsWith('.md'));
}

export async function loadPost(gh, where, slug, ref, { blog, lock }, { allowDraft = false } = {}) {
  if (!SLUG_RE.test(slug)) throw new NotFound('No such post.');
  const { repo, folder } = parseRepoRef(where);
  const text = await gh.readText(repo, at(folder, `posts/${slug}.md`), ref);
  if (text === null) throw new NotFound('No such post.');
  const post = parsePost({ path: `posts/${slug}.md`, text });
  if (post.lossy) throw post.lossy.at(post.path);
  if (post.status !== 'published' && !allowDraft) throw new NotFound('No such post.');
  const resolve = (r) => resolveAsset(r, blog, lock);
  const contract = blog.theme && typeof blog.theme === 'object' ? blog.theme.contract : undefined;
  return { post, text, html: deltaToHtml(post.delta, { resolve, resolveVideo: (r) => videoEmbedUrl(r, blog), strict: false, contract }) };
}

// blog.json "content": where the live copy of the blog's files can be read from, so a page can check
// itself against what was just published without waiting for the Pages build. It is a template, set in
// blog.json and nowhere else: no hostname is built into the generator or the page's script. Without
// it, generated pages carry no script and no 404 page is written.
import { Refusal } from './errors.js';
import { parseRepoRef } from './reporef.js';

const TOKENS = ['{owner}', '{repo}', '{ref}', '{path}'];
const bad = (m) => new Refusal('bad-blog-json', `content: ${m}`);

export function validateContent(c, repo) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad('must be an object');
  for (const k of Object.keys(c)) if (k !== 'base' && k !== 'ref') throw bad(`"${k}" is not a field (base, ref)`);
  if (typeof c.base !== 'string' || !/^https?:\/\/[^\s{}]+/.test(c.base)) throw bad('"base" must be an http(s) URL template');
  for (const t of ['{owner}', '{repo}']) if (!c.base.includes(t)) throw bad(`"base" must contain ${t}`);
  if (!c.base.endsWith('/{path}')) throw bad('"base" must end with /{path}');
  const left = c.base.replace(/\{(owner|repo|ref|path)\}/g, '');
  if (/[{}]/.test(left)) throw bad(`"base" may only use ${TOKENS.join(', ')}`);
  if (c.ref !== undefined && !(typeof c.ref === 'string' && /^[A-Za-z0-9][\w./-]{0,99}$/.test(c.ref))) throw bad('"ref" must be a branch name or HEAD');
  if (!repo) throw bad('needs "repo" (owner/name) in blog.json, to know which repository to read');
}

// The URL of the blog's own folder in the live copy, ending in "/" (so "posts/x.md" appends to it); null when
// the blog does not say.
export function contentBase(blog) {
  if (!blog.content || !blog.repo) return null;
  const { repo, folder } = parseRepoRef(blog.repo);
  const [owner, name] = repo.split('/');
  return blog.content.base
    .replace('{owner}', owner)
    .replace('{repo}', name)
    .replace('{ref}', blog.content.ref || 'HEAD')
    .replace('{path}', folder ? `${folder}/` : '');
}

// The path part of where the blog is served ("/blog" for https://me.github.io/blog; "" at a root).
export const domainPath = (blog) => new URL(blog.domain).pathname.replace(/\/+$/, '');

// An extension that frames pinned assets needs more than blog.json records to be rebuilt in a browser,
// so such a blog keeps its pages as the build wrote them.
export const rebuildableInBrowser = (blog) => !(blog.extensions || []).some((e) => e.kind === 'embed' || !Array.isArray(e.hooks));

// A 404.html is only ours to write at the root of the Pages site: a blog in a folder of a repository
// does not own the repository's 404 page.
export const ownsNotFoundPage = (blog) => !!blog.repo && parseRepoRef(blog.repo).folder === '';

// Does this blog ship the live script?
export const liveEnabled = (blog) => !!contentBase(blog) && rebuildableInBrowser(blog);

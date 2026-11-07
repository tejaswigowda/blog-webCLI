// Creating a blog: the blog.json a new blog starts with. Pure, so the browser and tests share it.
import { parseRepoRef } from './reporef.js';

export const DEFAULT_ASSET_BASE = 'https://cdn.jsdelivr.net/gh/{owner}/{repo}@{sha}/{path}';
export const DEFAULT_VIDEO_BASE = 'https://cdn.jsdelivr.net/gh/{owner}/{repo}@{tag}/{slug}/';
export const DEFAULT_PLAYER = 'https://strataeditor.dev/player/';
// Written into a new blog's blog.json; the generator and the page's script only ever read blog.json.
export const DEFAULT_CONTENT_BASE = 'https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}';

// Where GitHub Pages serves a repository by convention: a user site (<owner>.github.io) at the
// root, any other repository under its name.
export function pagesRoot(repo) {
  const [owner, name] = repo.split('/');
  return name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${owner}.github.io` : `https://${owner}.github.io/${name}`;
}

// Where a blog is served: the repository's Pages address (GitHub's own answer, which carries a custom
// domain when there is one, and http: until HTTPS is enforced for it), or the convention when that is
// not known; the blog's folder appended.
export function addressFrom(where, pagesUrl = null) {
  const { repo, folder } = parseRepoRef(where);
  const root = typeof pagesUrl === 'string' && /^https?:\/\/[^\s]+$/.test(pagesUrl) ? pagesUrl.replace(/\/+$/, '') : pagesRoot(repo);
  return folder ? `${root}/${folder}` : root;
}

export const defaultDomain = (where) => addressFrom(where, null);

export function defaultTitle(where) {
  const { repo, folder } = parseRepoRef(where);
  const last = folder ? folder.split('/').pop() : repo.split('/')[1];
  return last.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// fields: { title, description, author, domain?, images?, video? } — `images` and `video`
// are repository references (owner/name or owner/name/folder) and may be left empty.
export function makeBlogJson(where, fields) {
  const clean = (v) => (typeof v === 'string' ? v.trim() : '');
  const blog = {
    title: clean(fields.title),
    description: clean(fields.description),
    author: clean(fields.author),
    domain: (clean(fields.domain) || defaultDomain(where)).replace(/\/+$/, ''),
    repo: parseRepoRef(where).ref,
    theme: 'default',
    content: { base: DEFAULT_CONTENT_BASE },
    search: true,
  };
  if (Number.isInteger(fields.pageSize) && fields.pageSize >= 1 && fields.pageSize <= 100) blog.pagination = { size: fields.pageSize, ...(fields.pageStable ? { stable: true } : {}) };
  if (fields.linkStyle) blog.stylesheet = 'linked';
  if (clean(fields.images)) blog.assets = { base: DEFAULT_ASSET_BASE, repos: { images: parseRepoRef(clean(fields.images)).ref } };
  if (clean(fields.video)) blog.video = { player: DEFAULT_PLAYER, base: DEFAULT_VIDEO_BASE, repos: { videos: parseRepoRef(clean(fields.video)).ref } };
  return blog;
}

export const blogJsonText = (blog) => JSON.stringify(blog, null, 2) + '\n';

// The /blog/ reader's logic, with no DOM. A page address is
//   /blog/#repo=owner/repo[/folder][&post=slug][&ref=branch]
//        [&images=…][&video=…][&audio=…]        optional media repository overrides
//        [&blog=https://…]                      the blog's static site, for the failsafe
// The hash overrides blog.json; blog.json fills in what the hash leaves out.
import { isRepoRef, parseRepoRef } from '../lib/reporef.js';
import { defaultDomain } from '../lib/init.js';
import { withRepoOverrides } from '../lib/blog.js';
import { loadBlog } from './site.js';

export function parseReaderHash(hash) {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const get = (k) => (p.get(k) || '').trim() || null;
  return { repo: get('repo'), post: get('post'), ref: get('ref') || undefined, blogUrl: get('blog'), images: get('images'), video: get('video'), audio: get('audio') };
}

const enc = (v) => encodeURIComponent(v).replace(/%2F/g, '/').replace(/%3A/g, ':');

// A hash that keeps every parameter the reader was opened with.
export function hashFor(parsed, { post = null } = {}) {
  const parts = [];
  for (const k of ['repo']) if (parsed[k]) parts.push(`${k}=${enc(parsed[k])}`);
  if (post) parts.push(`post=${enc(post)}`);
  if (parsed.ref) parts.push(`ref=${enc(parsed.ref)}`);
  for (const k of ['images', 'video', 'audio']) if (parsed[k]) parts.push(`${k}=${enc(parsed[k])}`);
  if (parsed.blogUrl) parts.push(`blog=${enc(parsed.blogUrl)}`);
  return '#' + parts.join('&');
}

// A static blog address from the hash: https only, no credentials, no query or fragment.
export function normalizeBlogUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('The blog address is not a valid URL.');
  }
  if (u.protocol !== 'https:') throw new Error('The blog address must be an https:// URL.');
  if (u.username || u.password) throw new Error('The blog address may not contain credentials.');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

// Opening a link that carries only a blog address is an open redirect unless the host is one
// whose content the owner publishes through GitHub Pages or this app. Others get a confirmation.
export function isTrustedHost(url) {
  const host = new URL(url).hostname.toLowerCase();
  return host.endsWith('.github.io') || host === 'blog.webcli.app';
}

// Where the static site is, and how sure we are: the address in the hash, else the one in
// blog.json, else the usual GitHub Pages address for the repository.
export function staticAddress({ blogUrl, blog, repo }) {
  if (blogUrl) return { base: normalizeBlogUrl(blogUrl), certain: true };
  if (blog && blog.domain) return { base: blog.domain, certain: true };
  return { base: defaultDomain(repo), certain: false };
}

export const staticPostUrl = (base, slug) => `${base}/${slug}/`;

export async function openBlog(gh, parsed) {
  if (!parsed.repo || !isRepoRef(parsed.repo)) throw new Error('Open a blog with #repo=owner/repo, or owner/repo/folder.');
  const { blog, lock } = await loadBlog(gh, parseRepoRef(parsed.repo).ref, parsed.ref);
  return { blog: withRepoOverrides(blog, parsed), lock };
}

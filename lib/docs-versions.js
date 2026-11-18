import { Refusal } from './errors.js';
import { escapeHtml } from './html.js';
import { RESERVED_SLUGS } from './frontmatter.js';
import { sitemapEnabled, sitemapIndexXml, robotsEnabled, robotsTxt } from './seo.js';
import { decodeHtml } from './html-entities.js';

const bad = (message) => new Refusal('bad-blog-json', `versions: ${message}`);

export function validateVersions(versions) {
  if (!Array.isArray(versions) || !versions.length) throw bad('must be a non-empty array');
  const paths = new Set();
  let defaults = 0;
  for (const v of versions) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('each version must be an object');
    for (const key of Object.keys(v)) if (!['path', 'ref', 'label', 'default'].includes(key)) throw bad(`unknown field "${key}"`);
    if (typeof v.path !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.path) || RESERVED_SLUGS.has(v.path) || ['comments', 'images', 'videos'].includes(v.path)) throw bad('path must be a non-reserved lowercase slug');
    if (paths.has(v.path)) throw bad(`duplicate path "${v.path}"`);
    paths.add(v.path);
    if (typeof v.ref !== 'string' || !v.ref || v.ref.length > 200 || v.ref.startsWith('-') || /[\s~^:?*\\[\]]|\.\.|@\{/.test(v.ref)) throw bad('ref must be a Git ref or commit SHA');
    if (typeof v.label !== 'string' || !v.label.trim() || /[\u0000-\u001f\u007f]/.test(v.label)) throw bad('label must be non-empty text');
    if (v.default !== undefined && typeof v.default !== 'boolean') throw bad('default must be true or false');
    if (v.default) defaults++;
  }
  if (defaults !== 1) throw bad('exactly one version must be default');
}

export function versionBlog(blog, version) {
  const copy = { ...blog, domain: `${blog.domain}/${version.path}`, search: version.default ? blog.search : false };
  delete copy.versions;
  delete copy.content;
  return copy;
}

export function versionFiles(blog, version, files) {
  const target = blog.versions.find((v) => v.default);
  const out = {};
  for (const [file, value] of Object.entries(files)) {
    if (file === '.nojekyll' || file === 'robots.txt') continue;
    let text = value;
    if (!version.default && file.endsWith('.html')) {
      const notice = `<aside class="version-notice">You are reading ${escapeHtml(version.label)}, an older version. <a href="${escapeHtml(`${blog.domain}/${target.path}/`)}">Read ${escapeHtml(target.label)}</a>.</aside>`;
      text = text.replace(/<body(?:\s[^>]*)?>/, (tag) => `${tag}\n${notice}`);
    }
    out[`${version.path}/${file}`] = text;
  }
  return out;
}

export function versionRootFiles(blog, versionOutputs = {}, previousSitemap = '') {
  const current = blog.versions.find((v) => v.default);
  const url = `${blog.domain}/${current.path}/`;
  const h = escapeHtml;
  const files = {
    '.nojekyll': '',
    'index.html': `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="generator" content="blog-webcli"><meta name="robots" content="noindex"><link rel="canonical" href="${h(url)}"><meta http-equiv="refresh" content="0; url=${h(`${current.path}/`)}"></head><body><p>Continue to <a href="${h(`${current.path}/`)}">${h(current.label)}</a>.</p></body></html>\n`,
  };
  if (sitemapEnabled(blog)) {
    const previous = [...previousSitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decodeHtml(m[1]));
    const locs = blog.versions.flatMap((v) => {
      const output = versionOutputs[v.path];
      if (output) {
        if (!Object.hasOwn(output, `${v.path}/sitemap.xml`)) return [];
        const children = Object.keys(output).filter((p) => p.startsWith(`${v.path}/sitemaps/`) && p.endsWith('.xml')).sort();
        return (children.length ? children : [`${v.path}/sitemap.xml`]).map((p) => `${blog.domain}/${p}`);
      }
      const old = previous.filter((url) => url.startsWith(`${blog.domain}/${v.path}/`));
      return old.length ? old : [`${blog.domain}/${v.path}/sitemap.xml`];
    });
    files['sitemap.xml'] = sitemapIndexXml(locs);
    if (robotsEnabled(blog) && new URL(blog.domain).pathname.replace(/\/+$/, '') === '') files['robots.txt'] = robotsTxt(blog);
  }
  return files;
}

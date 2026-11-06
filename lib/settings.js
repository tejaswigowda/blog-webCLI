// Blog settings as a flat form, and back to blog.json. Pure, so the Settings screen and
// the tests share it. Unknown keys in blog.json are carried through untouched; anything
// left blank is removed (so the default applies), and the result is validated like any blog.json.
import { Refusal } from './errors.js';
import { authored } from './blog.js';
import { DEFAULT_ASSET_BASE, DEFAULT_CONTENT_BASE, DEFAULT_PLAYER, DEFAULT_VIDEO_BASE } from './init.js';
import { resolveOrder } from './order.js';

const COLORS = ['accent', 'text', 'background', 'muted'];
const LIST_DEFAULTS = { layout: 'list', excerpts: true, dates: true, tags: true };

// "Label | https://…" per line.
export function parseLinks(text, where) {
  const out = [];
  String(text || '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const cut = line.indexOf('|');
    if (cut < 0) throw new Refusal('bad-blog-json', `${where} line ${i + 1}: write it as  Label | https://address`);
    out.push({ label: line.slice(0, cut).trim(), url: line.slice(cut + 1).trim() });
  });
  return out;
}

export const linksToText = (links) => (links || []).map((l) => `${l.label} | ${l.url}`).join('\n');

// "name=value" per line: the attributes of an embedded script, the hidden fields of a form.
export function parseAttrs(text, where) {
  const out = {};
  String(text || '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const cut = line.indexOf('=');
    if (cut < 1) throw new Refusal('bad-blog-json', `${where} line ${i + 1}: write it as  name=value`);
    out[line.slice(0, cut).trim()] = line.slice(cut + 1).trim();
  });
  return out;
}

export const attrsToText = (attrs) => Object.entries(attrs || {}).map(([k, v]) => `${k}=${v}`).join('\n');

const videoKey = (video) => {
  const repos = (video && video.repos) || {};
  const keys = Object.keys(repos);
  return 'videos' in repos ? 'videos' : keys.length === 1 ? keys[0] : 'videos';
};

export function blogToForm(blog) {
  const c = blog.customize || {};
  const colors = c.colors || {};
  const dark = colors.dark || {};
  const header = c.header || {};
  const footer = c.footer || {};
  const list = { ...LIST_DEFAULTS, ...(c.list || {}) };
  // a repository a default supplies is not what the author entered: the form leaves it blank
  const assets = authored(blog, 'assets');
  const video = authored(blog, 'video');
  const order = resolveOrder(blog);
  const f = {
    orderBy: order.by.startsWith('frontmatter:') ? 'frontmatter' : order.by,
    orderField: order.by.startsWith('frontmatter:') ? order.by.slice('frontmatter:'.length) : '',
    orderDir: (blog.order && blog.order.dir) || '',
    orderList: (blog.order && blog.order.list) || '',
    title: blog.title || '',
    description: blog.description || '',
    author: blog.author || '',
    domain: blog.domain || '',
    images: (assets && assets.repos && assets.repos.images) || '',
    audio: (assets && assets.repos && assets.repos.audio) || '',
    video: (video && video.repos && video.repos[videoKey(video)]) || '',
    assetBase: (assets && assets.base) || '',
    videoPlayer: (video && video.player) || '',
    videoBase: (video && video.base) || '',
    live: !!blog.content,
    contentBase: (blog.content && blog.content.base) || '',
    search: blog.search === true,
    pageSize: (blog.pagination && blog.pagination.size) || '',
    seoTwitter: (blog.seo && blog.seo.twitter) || '',
    seoSitemap: !(blog.seo && blog.seo.sitemap === false),
    seoRobots: !(blog.seo && blog.seo.robots === false),
    commentsSrc: (blog.comments && blog.comments.src) || '',
    commentsAttrs: attrsToText(blog.comments && blog.comments.attrs),
    analyticsSrc: (blog.analytics && blog.analytics.src) || '',
    analyticsAttrs: attrsToText(blog.analytics && blog.analytics.attrs),
    subAction: (blog.subscribe && blog.subscribe.action) || '',
    subField: (blog.subscribe && blog.subscribe.field) || '',
    subTitle: (blog.subscribe && blog.subscribe.title) || '',
    subButton: (blog.subscribe && blog.subscribe.button) || '',
    subHidden: attrsToText(blog.subscribe && blog.subscribe.hidden),
    font: c.font || '',
    headingFont: c.headingFont || '',
    width: c.width || '',
    fontSize: c.fontSize || '',
    logo: header.logo || '',
    showTitle: header.showTitle !== false,
    headerLinks: linksToText(header.links),
    footerText: footer.text || '',
    footerLinks: linksToText(footer.links),
    layout: list.layout,
    excerpts: list.excerpts,
    dates: list.dates,
    tags: list.tags,
    css: c.css || '',
  };
  for (const k of COLORS) {
    f[`color_${k}`] = colors[k] || '';
    f[`dark_${k}`] = dark[k] || '';
  }
  return f;
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');

function setRepo(blog, section, key, value, defaults) {
  const v = text(value);
  const repos = (blog[section] && blog[section].repos) || {};
  if (v) {
    blog[section] = blog[section] || { ...defaults, repos: {} };
    blog[section].repos = { ...repos, [key]: v };
  } else if (key in repos) {
    const rest = { ...repos };
    delete rest[key];
    if (Object.keys(rest).length) blog[section].repos = rest;
    else delete blog[section];
  }
}

// Customize section from the form; only what differs from the defaults is written.
export function customizeFromForm(f) {
  const c = {};
  const colors = {};
  const dark = {};
  for (const k of COLORS) {
    if (text(f[`color_${k}`])) colors[k] = text(f[`color_${k}`]);
    if (text(f[`dark_${k}`])) dark[k] = text(f[`dark_${k}`]);
  }
  if (Object.keys(dark).length) colors.dark = dark;
  if (Object.keys(colors).length) c.colors = colors;
  for (const k of ['font', 'headingFont', 'width', 'fontSize']) if (text(f[k])) c[k] = text(f[k]);
  const header = {};
  if (text(f.logo)) header.logo = text(f.logo);
  if (f.showTitle === false) header.showTitle = false;
  const hl = parseLinks(f.headerLinks, 'Header links');
  if (hl.length) header.links = hl;
  if (Object.keys(header).length) c.header = header;
  const footer = {};
  if (text(f.footerText)) footer.text = text(f.footerText);
  const fl = parseLinks(f.footerLinks, 'Footer links');
  if (fl.length) footer.links = fl;
  if (Object.keys(footer).length) c.footer = footer;
  const list = {};
  if (f.layout && f.layout !== LIST_DEFAULTS.layout) list.layout = f.layout;
  for (const k of ['excerpts', 'dates', 'tags']) if (f[k] === false) list[k] = false;
  if (Object.keys(list).length) c.list = list;
  if (text(f.css)) c.css = f.css.replace(/\s+$/, '');
  return Object.keys(c).length ? c : null;
}

// Apply the form to the blog.json object. `base` is not modified.
export function formToBlog(base, f) {
  const blog = structuredClone(base);
  for (const k of ['title', 'description', 'author', 'domain']) blog[k] = text(f[k]);
  setRepo(blog, 'assets', 'images', f.images, { base: DEFAULT_ASSET_BASE });
  setRepo(blog, 'assets', 'audio', f.audio, { base: DEFAULT_ASSET_BASE });
  setRepo(blog, 'video', videoKey(blog.video), f.video, { player: DEFAULT_PLAYER, base: DEFAULT_VIDEO_BASE });
  if (blog.assets) blog.assets.base = text(f.assetBase) || DEFAULT_ASSET_BASE;
  if (blog.video) {
    blog.video.player = text(f.videoPlayer) || DEFAULT_PLAYER;
    blog.video.base = text(f.videoBase) || DEFAULT_VIDEO_BASE;
  }
  // where the live copy is read from: ticked, the blog's pages check themselves against it (lib/live.js)
  if (f.live) blog.content = { ...(blog.content || {}), base: text(f.contentBase) || DEFAULT_CONTENT_BASE };
  else delete blog.content;
  // reader features: each is written only when it differs from the default (off, or on for the sitemap and robots.txt)
  if (f.search) blog.search = true;
  else delete blog.search;
  const size = Number(text(String(f.pageSize ?? '')));
  if (text(String(f.pageSize ?? ''))) blog.pagination = { size };
  else delete blog.pagination;
  const seo = { ...(blog.seo || {}) };
  if (text(f.seoTwitter)) seo.twitter = text(f.seoTwitter);
  else delete seo.twitter;
  for (const [k, on] of [['sitemap', f.seoSitemap], ['robots', f.seoRobots]]) {
    if (on === false) seo[k] = false;
    else delete seo[k];
  }
  if (Object.keys(seo).length) blog.seo = seo;
  else delete blog.seo;
  for (const [key, srcKey, attrsKey, what] of [['comments', 'commentsSrc', 'commentsAttrs', 'Comments'], ['analytics', 'analyticsSrc', 'analyticsAttrs', 'Analytics']]) {
    if (text(f[srcKey])) {
      const attrs = parseAttrs(f[attrsKey], `${what} attributes`);
      blog[key] = { ...(blog[key] || {}), src: text(f[srcKey]) };
      if (Object.keys(attrs).length) blog[key].attrs = attrs;
      else delete blog[key].attrs;
    } else delete blog[key];
  }
  if (text(f.subAction)) {
    const sub = { ...(blog.subscribe || {}), action: text(f.subAction) };
    for (const [k, v] of [['field', f.subField], ['title', f.subTitle], ['button', f.subButton]]) {
      if (text(v)) sub[k] = text(v);
      else delete sub[k];
    }
    const hidden = parseAttrs(f.subHidden, 'Subscribe hidden fields');
    if (Object.keys(hidden).length) sub.hidden = hidden;
    else delete sub.hidden;
    blog.subscribe = sub;
  } else delete blog.subscribe;
  // the order of the posts: only what differs from the default (newest first) is written
  const by = f.orderBy === 'frontmatter' ? `frontmatter:${text(f.orderField)}` : text(f.orderBy) || 'date';
  if (by === 'manual') blog.order = { by: 'manual', ...(text(f.orderList) && text(f.orderList) !== 'order.json' ? { list: text(f.orderList) } : {}), ...(base.order && base.order.by === 'manual' && base.order.unlisted ? { unlisted: base.order.unlisted } : {}) };
  else if (by === 'date' && (!text(f.orderDir) || text(f.orderDir) === 'desc')) delete blog.order;
  else blog.order = { by, ...(text(f.orderDir) && text(f.orderDir) !== (by === 'date' ? 'desc' : 'asc') ? { dir: text(f.orderDir) } : by === 'date' ? { dir: 'asc' } : {}) };
  const c = customizeFromForm(f);
  if (c) blog.customize = c;
  else delete blog.customize;
  return blog;
}

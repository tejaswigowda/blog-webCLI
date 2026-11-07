// Frontmatter: a deliberately small YAML subset (scalars, inline lists, block lists,
// comments). The raw block is preserved verbatim; edits touch one key at a time, so
// a round trip never rewrites what the author wrote.
import { Refusal } from './errors.js';
import { parseAliases } from './aliases.js';

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Paths the generator owns at the top of the site: a post or page with one of these slugs would collide with it.
export const RESERVED_SLUGS = new Set(['posts', 'pages', 'index', 'feed', 'assets', 'static', 'node_modules', 'p', 'tags', 'authors', 'archive', 'search', 'page']);

export function splitFile(text, where) {
  const lines = text.split('\n');
  if (lines[0] !== '---') throw new Refusal('missing-frontmatter', 'file does not start with a --- frontmatter block', where);
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Refusal('missing-frontmatter', 'frontmatter block is not closed with ---', where);
  const front = lines.slice(1, end).join('\n') + (end > 1 ? '\n' : '');
  const rest = lines.slice(end + 1).join('\n');
  const body = rest.startsWith('\n') ? rest.slice(1) : rest;
  return { front, body };
}

export function joinFile(front, body) {
  return `---\n${front}---\n` + (body === '' ? '' : `\n${body}`);
}

function stripComment(v) {
  let q = null;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(v[i - 1]))) return { value: v.slice(0, i).trimEnd(), comment: v.slice(i) };
  }
  return { value: v.trimEnd(), comment: '' };
}

function scalar(v) {
  v = v.trim();
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      throw new Refusal('bad-frontmatter', `cannot read quoted value ${v}`);
    }
  }
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2) throw new Refusal('bad-frontmatter', `unterminated quote in ${v}`);
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

function inlineList(v) {
  const inner = v.slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let cur = '';
  let q = null;
  for (const c of inner) {
    if (q) {
      cur += c;
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ',') {
      items.push(cur);
      cur = '';
    } else cur += c;
  }
  items.push(cur);
  return items.map(scalar).filter((s) => s !== '');
}

const KEY_LINE = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*)|[ \t]*)$/;

export function parseMeta(front, where) {
  const meta = {};
  const blockKeys = new Set();
  const lines = front.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let list = null;
  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) || /^-\s+(.*)$/.exec(line);
    if (item && list) {
      list.push(scalar(stripComment(item[1]).value));
      continue;
    }
    const m = KEY_LINE.exec(line);
    if (!m) throw new Refusal('bad-frontmatter', `cannot read line "${line}"`, where);
    const { value } = stripComment(m[2] || '');
    list = null;
    if (value === '') {
      meta[m[1]] = list = [];
      blockKeys.add(m[1]);
    } else if (value.startsWith('[')) {
      if (!value.endsWith(']')) throw new Refusal('bad-frontmatter', `unterminated list in "${line}"`, where);
      meta[m[1]] = inlineList(value);
    } else meta[m[1]] = scalar(value);
  }
  // `key:` followed by nothing is an empty value, not an empty list.
  for (const k of blockKeys) if (meta[k].length === 0) meta[k] = '';
  return meta;
}

const isDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};

function needsQuote(s) {
  if (s === '') return true;
  if (/^[\s[\]{}&*!|>%@`'"#,-]/.test(s)) return true;
  if (/\s$/.test(s) || s.includes(': ') || / #/.test(s)) return true;
  if (/^(true|false|null|yes|no|~)$/i.test(s)) return true;
  return /^[+-]?\d/.test(s) && !isDate(s);
}

function fmtScalar(s) {
  s = String(s);
  return needsQuote(s) ? JSON.stringify(s) : s;
}

export function fmtValue(v) {
  return Array.isArray(v) ? `[${v.map(fmtScalar).join(', ')}]` : fmtScalar(v);
}

// A switch and a position are written bare (noindex: true, menu: 2), as a person would; both read back as the same text.
const BARE = { noindex: /^(?:true|false)$/, menu: /^\d{1,2}$/ };
const fmtField = (key, v) => (typeof v === 'string' && BARE[key] && BARE[key].test(v) ? v : fmtValue(v));

// Set (or remove, with null) one key, preserving the rest of the block verbatim —
// including a trailing comment on the replaced line.
export function setMeta(front, key, value) {
  const lines = front.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const idx = lines.findIndex((l) => KEY_LINE.test(l) && KEY_LINE.exec(l)[1] === key);
  let comment = '';
  if (idx >= 0) {
    comment = stripComment(KEY_LINE.exec(lines[idx])[2] || '').comment;
    let end = idx + 1;
    while (end < lines.length && (/^\s+-\s/.test(lines[end]) || /^-\s/.test(lines[end]))) end++;
    const repl = value === null ? [] : [`${key}: ${fmtField(key, value)}${comment ? '  ' + comment : ''}`];
    lines.splice(idx, end - idx, ...repl);
  } else if (value !== null) lines.push(`${key}: ${fmtField(key, value)}`);
  return lines.length ? lines.join('\n') + '\n' : '';
}

export function newFront(meta) {
  let f = '';
  for (const k of ['slug', 'title', 'date', 'author', 'tags', 'aliases', 'status', 'menu', 'cover', 'description', 'seo_title', 'image', 'canonical', 'noindex']) {
    if (meta[k] !== undefined && meta[k] !== null && meta[k] !== '') f += `${k}: ${fmtField(k, meta[k])}\n`;
  }
  return f;
}

// kind: 'post' (posts/<slug>.md) or 'page' (pages/<slug>.md: a standalone page, which has no date, author or tags of its own).
// A video's technical facts (its length, poster, renditions, captions, checksums) live in the render's own render.json, published by
// hls.webcli.app. A post references the render (`video:<repo>/<name>@v<N>`) and never restates it: one source of truth, so a post can
// never disagree with the video it embeds.
export const RENDER_FIELDS = Object.freeze(['duration', 'poster', 'renditions', 'rungs', 'bitrate', 'fps', 'framerate', 'codec', 'captions', 'transcript', 'files', 'sha256']);

export function validateMeta(meta, where, kind = 'post') {
  for (const k of RENDER_FIELDS) {
    if (meta[k] !== undefined) throw new Refusal('bad-frontmatter', `"${k}" is a fact about a video, and the render's own render.json holds it. Reference the render in the post (video:<repo>/<name>@v<N>) and do not restate it here.`, where);
  }
  for (const k of kind === 'page' ? ['slug', 'title', 'status'] : ['slug', 'title', 'date', 'status']) {
    if (typeof meta[k] !== 'string' || meta[k] === '') throw new Refusal('missing-frontmatter', `required field "${k}" is missing`, where);
  }
  if (!SLUG_RE.test(meta.slug)) throw new Refusal('bad-frontmatter', `slug "${meta.slug}" must be lowercase letters, digits and hyphens`, where);
  if (meta.date !== undefined && (typeof meta.date !== 'string' || !isDate(meta.date))) throw new Refusal('bad-frontmatter', `date "${meta.date}" must be a real YYYY-MM-DD date`, where);
  if (meta.status !== 'draft' && meta.status !== 'published') throw new Refusal('bad-frontmatter', `status must be "draft" or "published", got "${meta.status}"`, where);
  if (meta.tags !== undefined && !(Array.isArray(meta.tags) && meta.tags.every((t) => typeof t === 'string' && t))) {
    throw new Refusal('bad-frontmatter', 'tags must be a list like [video, git]', where);
  }
  parseAliases(meta, where);
  if (meta.cover !== undefined && meta.cover !== 'auto' && !/^asset:/.test(meta.cover)) throw new Refusal('bad-frontmatter', 'cover must be an asset: reference, or auto', where);
  for (const k of ['author', 'description', 'seo_title']) {
    if (meta[k] !== undefined && typeof meta[k] !== 'string') throw new Refusal('bad-frontmatter', `${k} must be text`, where);
  }
  if (meta.image !== undefined && !(typeof meta.image === 'string' && /^asset:/.test(meta.image))) throw new Refusal('bad-frontmatter', 'image must be an asset: reference', where);
  if (meta.canonical !== undefined && !(typeof meta.canonical === 'string' && /^https?:\/\/[^\s"<>]+$/.test(meta.canonical))) throw new Refusal('bad-frontmatter', 'canonical must be an absolute http(s) address', where);
  if (meta.noindex !== undefined && meta.noindex !== 'true' && meta.noindex !== 'false') throw new Refusal('bad-frontmatter', 'noindex must be true or false', where);
  if (meta.menu !== undefined && !(typeof meta.menu === 'string' && /^\d{1,2}$/.test(meta.menu))) throw new Refusal('bad-frontmatter', 'menu must be a position from 0 to 99 (pages with a menu value are listed in the header, lowest first)', where);
  if (kind === 'page') for (const k of ['tags']) if (meta[k] !== undefined) throw new Refusal('bad-frontmatter', `a page has no ${k} (that belongs to posts)`, where);
}

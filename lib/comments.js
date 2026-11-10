// Comments a blog publishes, as data. A comment is not written on the page: a reader's form posts to a relay (lib/embeds.js), the relay
// tells the author, and the author publishes it by committing it to comments/<slug>.json. That commit is the moderation: nothing appears
// that was not reviewed as a diff, and removing one is a revert.
//
// This file is the one place comments are judged and drawn, so the build, the live renderer and the /blog/ reader cannot disagree.
//
//   { "comments": [ { "id": "c1", "name": "Ada", "date": "2026-11-09", "body": "Two paragraphs.\n\nLike this." },
//                   { "id": "c2", "date": "2026-11-10", "body": "…", "reply_to": "c1" } ] }
//
// The key set is closed (id, name, date, body, reply_to): no email, no address, no user agent, no provider id can be recorded even if the
// relay's message had them. A value that looks like an email address anywhere in the file is refused, so it cannot be pasted in.
// The body is plain text drawn as text: no markdown, no markup, no links (a web address appears as the words it is). That is the one
// place a stranger's words enter the stack, so it gets no path into HTML at all.
import { Refusal } from './errors.js';
import { escapeHtml as h } from './html.js';

export const COMMENT_PATH = /^comments\/([a-z0-9][a-z0-9-]*)\.json$/;
export const COMMENT_KEYS = Object.freeze(['id', 'name', 'date', 'body', 'reply_to']);
export const MAX_COMMENTS = 1000;
export const MAX_BODY = 5000;
export const MAX_NAME = 60;
export const ANONYMOUS = 'Anonymous';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const EMAIL = /[^\s@<>"'()[\]\\,;:]+@[^\s@<>"'()[\]\\,;:]+\.[A-Za-z]{2,}/;
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const bad = (m, where) => new Refusal('bad-comments', m, where);

const realDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

// Oldest first by the day submitted, then by id (ascending, as text): the same order whatever order the file lists them in.
export const sortComments = (list) => [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// text of comments/<slug>.json -> the comments, sorted. Throws Refusal('bad-comments').
export function parseComments(text, where = 'comments file') {
  if (typeof text !== 'string') throw bad('is not text', where);
  if (EMAIL.test(text)) throw bad('contains something that looks like an email address; comments carry no email, and a revert does not remove it from history', where);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw bad('is not valid JSON', where);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw bad('must be an object with a "comments" list', where);
  for (const k of Object.keys(doc)) if (k !== 'comments') throw bad(`"${k}" is not a field (only "comments")`, where);
  if (!Array.isArray(doc.comments)) throw bad('"comments" must be a list', where);
  if (doc.comments.length > MAX_COMMENTS) throw bad(`has ${doc.comments.length} comments; the limit is ${MAX_COMMENTS}`, where);
  const ids = new Set();
  for (const [i, c] of doc.comments.entries()) {
    const at = `comment ${i + 1}`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad(`${at} must be an object`, where);
    for (const k of Object.keys(c)) if (!COMMENT_KEYS.includes(k)) throw bad(`${at}: "${k}" is not a field (${COMMENT_KEYS.join(', ')})`, where);
    if (typeof c.id !== 'string' || !ID.test(c.id)) throw bad(`${at}: "id" must be a short name such as c1 (letters, digits, - and _)`, where);
    if (ids.has(c.id)) throw bad(`${at}: the id "${c.id}" is used twice`, where);
    ids.add(c.id);
    if (c.name !== undefined && (typeof c.name !== 'string' || c.name.length > MAX_NAME || CONTROL.test(c.name) || LONE_SURROGATE.test(c.name))) throw bad(`${at}: "name" must be plain text of at most ${MAX_NAME} characters`, where);
    if (!realDay(c.date)) throw bad(`${at}: "date" must be a real day, YYYY-MM-DD (the day it was submitted)`, where);
    if (typeof c.body !== 'string' || !c.body.trim()) throw bad(`${at}: "body" is required`, where);
    if (c.body.length > MAX_BODY) throw bad(`${at}: "body" is ${c.body.length} characters; the limit is ${MAX_BODY}`, where);
    if (CONTROL.test(c.body.replace(/\n/g, '')) || LONE_SURROGATE.test(c.body)) throw bad(`${at}: "body" has a control character or an unpaired surrogate`, where);
    if (c.reply_to !== undefined && typeof c.reply_to !== 'string') throw bad(`${at}: "reply_to" must be the id of another comment`, where);
  }
  const sorted = sortComments(doc.comments);
  const at = new Map(sorted.map((c, i) => [c.id, i]));
  for (const c of sorted) {
    if (c.reply_to === undefined) continue;
    if (c.reply_to === c.id) throw bad(`"${c.id}" replies to itself`, where);
    if (!at.has(c.reply_to)) throw bad(`"${c.id}" replies to "${c.reply_to}", which is not in the file`, where);
    if (at.get(c.reply_to) > at.get(c.id)) throw bad(`"${c.id}" replies to "${c.reply_to}", which comes after it`, where);
  }
  return sorted;
}

// Plain text -> paragraphs: a blank line breaks one, a single newline stays a line break, everything is escaped. No markup of any kind.
export function bodyHtml(body) {
  return body.trim().split(/\n[ \t]*\n+/).map((p) => `<p>${h(p.trim()).replace(/\n/g, '<br>\n')}</p>`).join('\n');
}

// The section under a post: who, when, what they said. A reply is flat (no nested container) and names whom it answers.
// Markup follows the classic comment-list classes, so a theme that styles them already styles this.
export function commentsSectionHtml(list, { title = 'Comments' } = {}) {
  if (!list || !list.length) return '';
  const byId = new Map(list.map((c) => [c.id, c]));
  const items = list.map((c) => {
    const who = h(c.name && c.name.trim() ? c.name.trim() : ANONYMOUS);
    const to = c.reply_to && byId.get(c.reply_to) ? ` <span class="comment-reply-to">replying to <a href="#comment-${h(c.reply_to)}">${h((byId.get(c.reply_to).name || '').trim() || ANONYMOUS)}</a></span>` : '';
    return `<li id="comment-${h(c.id)}" class="comment${c.reply_to ? ' reply' : ''}"><article class="comment-body"><footer class="comment-meta"><b class="comment-author fn">${who}</b> <span class="comment-metadata"><time datetime="${h(c.date)}">${h(c.date)}</time></span>${to}</footer><div class="comment-content">\n${bodyHtml(c.body)}\n</div></article></li>`;
  });
  return `<section class="comments comments-area" id="comments" aria-label="${h(title)}"><h2 class="comments-title">${h(title)} (${list.length})</h2><ol class="comment-list">\n${items.join('\n')}\n</ol></section>`;
}

export const commentCount = (list) => (list ? list.length : 0);

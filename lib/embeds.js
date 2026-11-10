// Optional embeds a blog can switch on in blog.json: a comments widget, an analytics script, a subscribe form.
// Every one is data (an address and some attributes), never a provider built into the generator, and every
// one is off unless blog.json asks: a page carries no script and makes no request to anyone else by default.
// A script named here runs on the reader's page with the page's own powers; that is the cost of the feature,
// and `integrity` lets a blog pin the exact bytes it trusts.
import { Refusal } from './errors.js';
import { escapeHtml as h } from './html.js';
import { MAX_BODY, MAX_NAME, commentsSectionHtml } from './comments.js';

const bad = (what, m) => new Refusal('bad-blog-json', `${what}: ${m}`);
const ATTR_NAME = /^(?:data-[a-z0-9][a-z0-9-]{0,40}|crossorigin|integrity|referrerpolicy|nonce)$/;
const HTTPS = /^https:\/\/[^\s"'<>{}]+$/;

function checkAttrs(what, attrs) {
  if (attrs === undefined) return;
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) throw bad(what, '"attrs" must be an object of attribute names to text');
  const names = Object.keys(attrs);
  if (names.length > 16) throw bad(what, 'at most 16 attributes');
  for (const [k, v] of Object.entries(attrs)) {
    if (!ATTR_NAME.test(k)) throw bad(what, `attribute "${k}" is not allowed (data-*, crossorigin, integrity, referrerpolicy)`);
    if (typeof v !== 'string' || v.length > 300) throw bad(what, `attribute "${k}" must be text of at most 300 characters`);
  }
}

function checkKeys(what, o, allowed) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad(what, 'must be an object');
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw bad(what, `"${k}" is not a field (${allowed.join(', ')})`);
}

const NAME = /^[A-Za-z][\w-]{0,40}$/;
const RELAY_NAME = /^[A-Za-z_][\w-]{0,40}$/; // a relay's redirect field is often "_next"
const EMAIL_ADDR = /^[^\s@<>"'()[\],;:\\]+@[^\s@<>"'()[\],;:\\]+\.[A-Za-z]{2,}$/;
export const COMMENT_MODES = ['mailto', 'form', 'script'];
const COMMENT_KEYS = { mailto: ['mode', 'to', 'title'], form: ['mode', 'action', 'field', 'nameField', 'hidden', 'return', 'title', 'button', 'placeholder'], script: ['mode', 'src', 'attrs', 'title'] };

// `comments` has a mode: how a reader's comment reaches the author. They are exclusive, and none is on unless blog.json says so.
//   mailto  a link that opens the reader's mail with the post named in the subject: no third party at all
//   form    a plain HTML form posting to a relay (this file's commentFormHtml): no script on the page, works with scripting off
//   script  a third party's script embedded under each post (what `comments: { src }` has always been)
// What is *published* is a separate thing: comments/<slug>.json, committed by the author (lib/comments.js).
export const commentsMode = (c) => (c ? c.mode || 'script' : null);

function validateComments(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad('comments', 'must be an object');
  if (c.mode !== undefined && !COMMENT_MODES.includes(c.mode)) throw bad('comments', `"mode" must be one of ${COMMENT_MODES.join(', ')}`);
  const mode = commentsMode(c);
  checkKeys('comments', c, COMMENT_KEYS[mode]);
  if (c.title !== undefined && !(typeof c.title === 'string' && c.title.length <= 120)) throw bad('comments', '"title" must be text of at most 120 characters');
  if (mode === 'script') {
    if (typeof c.src !== 'string' || !HTTPS.test(c.src)) throw bad('comments', '"src" must be an https address');
    checkAttrs('comments', c.attrs);
  } else if (mode === 'mailto') {
    if (typeof c.to !== 'string' || c.to.length > 120 || !EMAIL_ADDR.test(c.to)) throw bad('comments', '"to" must be the email address comments are sent to');
  } else {
    if (typeof c.action !== 'string' || !HTTPS.test(c.action)) throw bad('comments', '"action" must be the https address the form posts to');
    for (const k of ['field', 'nameField', 'return']) if (c[k] !== undefined && !(typeof c[k] === 'string' && RELAY_NAME.test(c[k]))) throw bad('comments', `"${k}" must be a form field name`);
    const field = c.field || 'comment';
    const nameField = c.nameField || 'name';
    if (field === nameField) throw bad('comments', '"field" and "nameField" must differ');
    if (c.hidden !== undefined) {
      if (!c.hidden || typeof c.hidden !== 'object' || Array.isArray(c.hidden) || Object.keys(c.hidden).length > 8) throw bad('comments', '"hidden" must be an object of at most 8 form fields');
      for (const [k, v] of Object.entries(c.hidden)) {
        if (!NAME.test(k) || typeof v !== 'string' || v.length > 200) throw bad('comments', `hidden field "${k}" must be a name and text`);
        if ([field, nameField, c.return].includes(k)) throw bad('comments', `hidden field "${k}" is also a field the form fills`);
      }
    }
    for (const k of ['button', 'placeholder']) if (c[k] !== undefined && !(typeof c[k] === 'string' && c[k].length <= 120)) throw bad('comments', `"${k}" must be text of at most 120 characters`);
  }
}

export function validateEmbeds(b) {
  if (b.comments !== undefined) validateComments(b.comments);
  for (const key of ['analytics']) {
    if (b[key] === undefined) continue;
    checkKeys(key, b[key], ['src', 'attrs', 'title']);
    if (typeof b[key].src !== 'string' || !HTTPS.test(b[key].src)) throw bad(key, '"src" must be an https address');
    checkAttrs(key, b[key].attrs);
    if (b[key].title !== undefined && typeof b[key].title !== 'string') throw bad(key, '"title" must be text');
  }
  if (b.subscribe !== undefined) {
    const s = b.subscribe;
    checkKeys('subscribe', s, ['action', 'field', 'hidden', 'title', 'button', 'placeholder']);
    if (typeof s.action !== 'string' || !HTTPS.test(s.action)) throw bad('subscribe', '"action" must be the https address the form posts to');
    if (s.field !== undefined && !(typeof s.field === 'string' && /^[A-Za-z][\w-]{0,40}$/.test(s.field))) throw bad('subscribe', '"field" must be a form field name (default "email")');
    if (s.hidden !== undefined) {
      if (!s.hidden || typeof s.hidden !== 'object' || Array.isArray(s.hidden) || Object.keys(s.hidden).length > 8) throw bad('subscribe', '"hidden" must be an object of at most 8 form fields');
      for (const [k, v] of Object.entries(s.hidden)) if (!/^[A-Za-z][\w-]{0,40}$/.test(k) || typeof v !== 'string' || v.length > 200) throw bad('subscribe', `hidden field "${k}" must be a name and text`);
    }
    for (const k of ['title', 'button', 'placeholder']) if (s[k] !== undefined && !(typeof s[k] === 'string' && s[k].length <= 120)) throw bad('subscribe', `"${k}" must be text of at most 120 characters`);
  }
}

const attrs = (o) => Object.entries(o || {}).map(([k, v]) => ` ${k}="${h(v)}"`).join('');

// What sits under a post: the comments the author has published (comments/<slug>.json, drawn by lib/comments.js), then the way to send one.
// `post`: { slug, url, comments } where comments is the parsed, sorted list (or empty). With no mode and no published comment: nothing.
export function commentsHtml(blog, post = {}) {
  const list = post.comments || [];
  const c = blog.comments;
  const mode = commentsMode(c);
  const title = (c && c.title) || 'Comments';
  const published = commentsSectionHtml(list);
  if (!c) return published;
  if (mode === 'script') {
    // unchanged for a blog with no published comment: the widget inserts itself into this section
    const widget = `<script src="${h(c.src)}" async${attrs(c.attrs)}></script>`;
    return published ? `${published}\n<section class="comments-widget" aria-label="${h(title)}">${widget}</section>` : `<section class="comments" id="comments" aria-label="${h(title)}">${widget}</section>`;
  }
  return [published, mode === 'mailto' ? commentMailtoHtml(blog, post) : commentFormHtml(blog, post)].filter(Boolean).join('\n');
}

// Said in plain words, above the button and not in a footnote: a reader who submits sees nothing for hours, which looks like failure.
const SENT_TO = (where) => `Your comment goes to ${where} and is published here if the author approves it, which can take a while: there is no live thread.`;

function commentFormHtml(blog, { slug, url }) {
  const c = blog.comments;
  const field = c.field || 'comment';
  const nameField = c.nameField || 'name';
  const hidden = { ...(c.hidden || {}), slug: slug || '' };
  const fields = Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${h(k)}" value="${h(v)}">`);
  if (c.return && url) fields.push(`<input type="hidden" name="${h(c.return)}" value="${h(url)}">`);
  let host = 'the address this form posts to';
  try { host = new URL(c.action).hostname; } catch { /* validated already */ }
  return `<section class="comment-respond" id="respond" aria-label="${h(c.title || 'Leave a comment')}"><h2 class="comment-reply-title">${h(c.title || 'Leave a comment')}</h2>
<form class="comment-form" method="post" action="${h(c.action)}">
<p class="comment-notes">${h(SENT_TO(host))} No email address is collected or stored. Web addresses are shown as plain text.</p>
<p class="comment-form-author"><label for="comment-${h(nameField)}">Name (optional)</label> <input id="comment-${h(nameField)}" type="text" name="${h(nameField)}" maxlength="${MAX_NAME}" autocomplete="off"></p>
<p class="comment-form-comment"><label for="comment-${h(field)}">Comment</label> <textarea id="comment-${h(field)}" name="${h(field)}" rows="6" maxlength="${MAX_BODY}" placeholder="${h(c.placeholder || '')}" required></textarea></p>
${fields.join('')}<p class="form-submit"><button type="submit">${h(c.button || 'Send comment')}</button></p>
</form></section>`;
}

function commentMailtoHtml(blog, { slug }) {
  const c = blog.comments;
  const subject = `Comment on ${slug || blog.title}`;
  const href = `mailto:${c.to}?subject=${encodeURIComponent(subject)}`;
  return `<section class="comment-respond" id="respond" aria-label="${h(c.title || 'Leave a comment')}"><h2 class="comment-reply-title">${h(c.title || 'Leave a comment')}</h2>
<p class="comment-notes">${h(SENT_TO('the author by email'))} The author sees your email address; it is never published. Web addresses are shown as plain text.</p>
<p class="form-submit"><a class="comment-mailto" href="${h(href)}" rel="nofollow">Comment by email</a></p></section>`;
}
// Analytics is a script at the end of every page.
export const analyticsHtml = (blog) => (blog.analytics ? `<script src="${h(blog.analytics.src)}" defer${attrs(blog.analytics.attrs)}></script>\n` : '');

// A plain HTML form that posts to the address blog.json names: it works with scripting off, and the page
// never sees the address a reader types.
export function subscribeHtml(blog) {
  const s = blog.subscribe;
  if (!s) return '';
  const field = s.field || 'email';
  const hidden = Object.entries(s.hidden || {}).map(([k, v]) => `<input type="hidden" name="${h(k)}" value="${h(v)}">`).join('');
  return `<form class="subscribe" method="post" action="${h(s.action)}"><label for="subscribe-${h(field)}">${h(s.title || 'Subscribe by email')}</label> <input id="subscribe-${h(field)}" type="email" name="${h(field)}" placeholder="${h(s.placeholder || 'you@example.com')}" autocomplete="email" required>${hidden} <button type="submit">${h(s.button || 'Subscribe')}</button></form>`;
}

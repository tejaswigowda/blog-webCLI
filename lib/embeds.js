// Optional embeds a blog can switch on in blog.json: a comments widget, an analytics script, a subscribe form.
// Every one is data (an address and some attributes), never a provider built into the generator, and every
// one is off unless blog.json asks: a page carries no script and makes no request to anyone else by default.
// A script named here runs on the reader's page with the page's own powers; that is the cost of the feature,
// and `integrity` lets a blog pin the exact bytes it trusts.
import { Refusal } from './errors.js';
import { escapeHtml as h } from './html.js';

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

export function validateEmbeds(b) {
  for (const key of ['comments', 'analytics']) {
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

// Comments sit under a post, where the script is placed: the widget inserts itself there.
export const commentsHtml = (blog) => (blog.comments ? `<section class="comments" id="comments" aria-label="${h(blog.comments.title || 'Comments')}"><script src="${h(blog.comments.src)}" async${attrs(blog.comments.attrs)}></script></section>` : '');

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

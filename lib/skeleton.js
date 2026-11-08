// A theme's page skeleton: the structure of a page as the theme draws it (its header, navigation, containers and footer, as elements and
// class names, with every word of demo text removed), with holes where this blog's own content goes. The generator builds the page with
// the markup contract as always and then pours the pieces into the skeleton, so a theme whose CSS targets its own class names (`.ast-container`,
// `.site-header`, `.main-header-bar`, …) finds them. It is data in the theme repository and in the blog's repository, so it is read as
// untrusted: an allow-list of elements and attributes, no text, no links but the blog's own, and exactly the placeholders below.
import { Refusal } from './errors.js';

export const SKELETON_MAX = 60_000;
export const BODY_CLASS_MAX = 300;
export const PLACEHOLDERS = Object.freeze(['content', 'menu', 'site-title', 'site-description', 'footer', 'home']);

const bad = (m) => new Refusal('bad-theme', `skeleton: ${m}`);
const TAGS = new Set(['div', 'span', 'header', 'footer', 'nav', 'main', 'section', 'aside', 'article', 'ul', 'ol', 'li', 'a', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'b', 'i', 'small', 'br', 'hr']);
export const SKELETON_TAGS = TAGS;
const VOID = new Set(['br', 'hr']);
const SAFE_VALUE = /^[A-Za-z0-9 _:./@%-]*$/;
const ROLE = /^(banner|navigation|main|contentinfo|complementary|region|list|listitem|presentation|search|none)$/;
const PLACEHOLDER = /\{\{([a-z-]+)\}\}/g;

// -> the same text; throws a Refusal on anything outside the grammar
export function checkSkeleton(html) {
  if (typeof html !== 'string' || !html.trim()) throw bad('is empty');
  if (html.length > SKELETON_MAX) throw bad(`is ${html.length} characters; the limit is ${SKELETON_MAX}`);
  const counts = {};
  const stack = [];
  let i = 0;
  const TAG = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*(?:="[^"<>]*")?)*)\s*(\/?)>/y;
  while (i < html.length) {
    if (html[i] !== '<') {
      const end = html.indexOf('<', i);
      const text = html.slice(i, end < 0 ? html.length : end);
      const rest = text.replace(PLACEHOLDER, (m, name) => {
        if (!PLACEHOLDERS.includes(name) || name === 'home') throw bad(`{{${name}}} is not a placeholder allowed in text`);
        counts[name] = (counts[name] || 0) + 1;
        return '';
      });
      if (rest.trim() !== '') throw bad(`has text that is not a placeholder ("${rest.trim().slice(0, 30)}")`);
      i = end < 0 ? html.length : end;
      continue;
    }
    TAG.lastIndex = i;
    const m = TAG.exec(html);
    if (!m) throw bad(`has markup that is not a plain element near "${html.slice(i, i + 30).replace(/\s+/g, ' ')}"`);
    const [whole, close, rawName, attrs, selfClose] = m;
    const name = rawName.toLowerCase();
    if (!TAGS.has(name)) throw bad(`<${name}> is not an allowed element`);
    if (close) {
      if (attrs.trim() || selfClose) throw bad(`closing </${name}> has attributes`);
      if (VOID.has(name)) throw bad(`</${name}> closes a void element`);
      if (stack.pop() !== name) throw bad(`</${name}> does not match its opening tag`);
    } else {
      if (selfClose) throw bad(`<${name}/> must not self-close`);
      const seen = new Set();
      for (const a of attrs.matchAll(/\s+([A-Za-z_:][-A-Za-z0-9_:.]*)(?:="([^"<>]*)")?/g)) {
        const key = a[1].toLowerCase();
        const val = a[2];
        if (seen.has(key)) throw bad(`<${name}> repeats ${key}`);
        seen.add(key);
        if (key === 'class' || key === 'id' || /^data-[a-z0-9-]+$/.test(key)) {
          if (val === undefined || !SAFE_VALUE.test(val)) throw bad(`${key} on <${name}> has characters a skeleton may not carry`);
        } else if (key === 'role') {
          if (!ROLE.test(val || '')) throw bad(`role "${val}" is not allowed`);
        } else if (key === 'aria-hidden') {
          if (val !== 'true' && val !== 'false') throw bad('aria-hidden must be true or false');
        } else if (key === 'href' && name === 'a') {
          if (val === '{{home}}') counts.home = (counts.home || 0) + 1;
          else if (val !== '#') throw bad(`a link may only go to {{home}} or #, not "${String(val).slice(0, 30)}"`);
        } else if (key === 'rel' && name === 'a') {
          if (val !== 'home') throw bad('rel may only be "home"');
        } else throw bad(`${key} on <${name}> is not an allowed attribute`);
      }
      if (!VOID.has(name)) stack.push(name);
    }
    i += whole.length;
  }
  if (stack.length) throw bad(`<${stack[stack.length - 1]}> is never closed`);
  if (counts.content !== 1) throw bad(`needs {{content}} exactly once (it has ${counts.content || 0})`);
  if ((counts.footer || 0) > 1) throw bad('has {{footer}} more than once');
  if ((counts.menu || 0) > 3) throw bad('has {{menu}} more than three times (a desktop and a mobile menu, say)');
  return html;
}

export function checkBodyClass(v) {
  if (v === undefined) return '';
  if (typeof v !== 'string' || v.length > BODY_CLASS_MAX || !/^[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*$/.test(v)) throw bad(`body_class must be class names separated by spaces, at most ${BODY_CLASS_MAX} characters`);
  return v;
}

// built: what the markup contract made for this page ({ bodyClass, html }, in the wordpress-classic structure); spec: { html, bodyClass };
// d: { blog, home }. -> { bodyClass, html }. The pieces are taken from the built page by the contract's own landmarks.
export function applySkeleton(spec, built, d) {
  const page = built.html;
  const openMain = /<main id="main" class="site-main">/.exec(page);
  const mainEnd = page.lastIndexOf('</main>');
  if (!openMain || mainEnd < 0) return built; // a page the contract did not build in the classic structure is left as it is
  const content = page.slice(openMain.index + openMain[0].length, mainEnd).trim();
  const menuOpen = /<ul id="primary-menu-list"[^>]*>/.exec(page);
  const menu = menuOpen ? page.slice(menuOpen.index + menuOpen[0].length, page.indexOf('</ul>', menuOpen.index)) : '';
  const infoOpen = '<div class="site-info">';
  const infoAt = page.indexOf(infoOpen);
  const footer = infoAt >= 0 ? page.slice(infoAt + infoOpen.length, page.indexOf('</div></footer>', infoAt)) : '';
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const values = { home: esc(d.home), 'site-title': esc(d.blog.title), 'site-description': esc(d.blog.description), menu, footer, content };
  // one pass over the skeleton only: a placeholder-looking string inside the page's own content or menu is just text
  const html = spec.html.replace(/\{\{([a-z-]+)\}\}/g, (m, name) => (name in values ? values[name] : m));
  return { bodyClass: [spec.bodyClass, built.bodyClass].filter(Boolean).join(' '), html };
}

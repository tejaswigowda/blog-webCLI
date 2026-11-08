// Harvest a theme's page skeleton from its demo page (wp-themes.com/<slug>/): the page's structure as elements and class names, with
// every word of demo text and every outside link taken out, and holes where a blog's content goes (lib/skeleton.js is the grammar and
// the checker; what comes out of here is checked by it before anything is written). Text in, text out: nothing in the page is run.
import { SKELETON_MAX, SKELETON_TAGS, checkBodyClass, checkSkeleton } from '../lib/skeleton.js';

const VOID_IN = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const DROP_BLOCK = /<(script|style|noscript|template|iframe|svg|textarea|select|button|form|video|audio|canvas|object|embed|head|title|picture|map|dialog)\b[\s\S]*?<\/\1\s*>/gi;
const DROP_WHOLE = /(^|[\s_-])(sidebar|widget-area|widget|secondary|skip-link|screen-reader-text|sr-only|search-form|searchform|search-modal|mobile-menu|off-canvas|offcanvas|popup|modal|cookie|breadcrumb|breadcrumbs|comments?|respond|pagination|post-navigation|nav-links|admin-bar|wpadminbar)([\s_-]|$)/i;
const ROUTING = /^(home|blog|single|single-post|single-format-\w+|postid-\d+|page|page-id-\d+|page-template\S*|page-parent|logged-in|admin-bar|no-customize-support|customize-support|wp-singular|wp-embed-responsive|paged|paged-\d+|archive|category|tag|date|author|search|search-results|search-no-results|error404|attachment|post-template-\S*|wp-custom-logo|custom-background|has-sidebar|[\w-]*sidebar[\w-]*|elementor-\S+|woocommerce\S*|jetpack\S*|no-js|js|rtl|wp-theme-\S+|\S*transparent\S*|\S*sticky\S*|\S*overlay\S*)$/; // a demo's hero image, not a blog's

// -> a tolerant tree: { tag, attrs, kids }, with text nodes as strings
function parse(html) {
  const root = { tag: '#root', attrs: {}, kids: [] };
  const stack = [root];
  const TOKEN = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([A-Za-z][\w:-]*)\s*>|<([A-Za-z][\w:-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*)\s*(\/?)>|[^<]+|</g;
  for (const m of html.matchAll(TOKEN)) {
    const [whole, close, open, rawAttrs, selfClose] = m;
    const top = stack[stack.length - 1];
    if (close) {
      const name = close.toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === name) {
          stack.length = i;
          break;
        }
      }
    } else if (open) {
      const tag = open.toLowerCase();
      const attrs = {};
      for (const a of (rawAttrs || '').matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
      const node = { tag, attrs, kids: [] };
      top.kids.push(node);
      if (!VOID_IN.has(tag) && !selfClose) stack.push(node);
    } else if (!whole.startsWith('<!') && whole !== '<') top.kids.push(whole);
  }
  return root;
}

const isEl = (n) => typeof n === 'object';
const classes = (n) => (n.attrs.class || '').split(/\s+/).filter(Boolean);
const matchesAny = (n, re) => re.test(`${classes(n).join(' ')} ${n.attrs.id || ''}`);
function* walk(n) {
  for (const k of n.kids) {
    if (isEl(k)) {
      yield k;
      yield* walk(k);
    }
  }
}

// -> { html, bodyClass } | null when the page has no recognisable main area (or what is left is not a valid skeleton)
export function harvestSkeleton(pageHtml) {
  const body = /<body([^>]*)>([\s\S]*)<\/body>/i.exec(pageHtml);
  if (!body) return null;
  const bodyClassRaw = /class=["']([^"']*)["']/i.exec(body[1]);
  let inner = body[2];
  for (let i = 0; i < 4; i++) inner = inner.replace(DROP_BLOCK, ''); // nested ones take a few passes
  const root = parse(inner);

  // sidebars, search, popups and the like are not part of a blog's pages
  const strip = (n) => {
    n.kids = n.kids.filter((k) => !isEl(k) || !(k.tag === 'aside' || matchesAny(k, DROP_WHOLE)));
    for (const k of n.kids) if (isEl(k)) strip(k);
  };
  strip(root);

  const all = [...walk(root)];
  const main = all.find((n) => n.tag === 'main') || all.find((n) => n.attrs.id === 'main' || classes(n).includes('site-main')) || all.find((n) => n.attrs.id === 'content' || n.attrs.id === 'primary');
  if (!main) return null;
  main.kids = ['{{content}}'];

  const home = all.find((n) => n.tag === 'a' && /\bhome\b/.test(n.attrs.rel || ''));
  if (home) {
    home.attrs = { ...(home.attrs.class ? { class: home.attrs.class } : {}), rel: 'home', href: '{{home}}' };
    home.kids = ['{{site-title}}'];
  } else {
    const t = all.find((n) => classes(n).some((c) => /(^|-)site-title$/.test(c)));
    if (t) t.kids = ['{{site-title}}'];
  }
  // a theme whose demo shows a logo instead of a title still needs the blog's name somewhere
  if (!home && !all.some((n) => n.kids.includes('{{site-title}}'))) {
    const place = all.find((n) => matchesAny(n, /site-branding|site-identity|branding/)) || all.find((n) => n.tag === 'header');
    if (place) place.kids.push({ tag: 'p', attrs: { class: 'site-title' }, kids: [{ tag: 'a', attrs: { rel: 'home', href: '{{home}}' }, kids: ['{{site-title}}'] }] });
  }
  const desc = all.find((n) => classes(n).some((c) => /(^|-)site-description$/.test(c)));
  if (desc) desc.kids = ['{{site-description}}'];

  // the primary menu: the first list with "menu" in its class that sits in a nav or the header
  const ancestors = (target) => {
    const found = [];
    const find = (n, trail) => {
      if (n === target) {
        found.push(...trail);
        return true;
      }
      return n.kids.some((k) => isEl(k) && find(k, [...trail, n.tag]));
    };
    find(root, []);
    return found;
  };
  // a theme draws its menu twice (a desktop one and a mobile one) in separate markup: each gets the blog's menu, the theme's CSS shows the right one
  const menus = all.filter((n) => (n.tag === 'ul' || n.tag === 'ol') && matchesAny(n, /menu/) && !matchesAny(n, /sub-menu|social|footer/) && ancestors(n).some((t) => t === 'nav' || t === 'header')).slice(0, 3);
  for (const m of menus) m.kids = ['{{menu}}'];

  const footers = all.filter((n) => n.tag === 'footer' && !classes(n).includes('entry-footer'));
  const footer = footers[footers.length - 1];
  if (footer) footer.kids = [{ tag: 'div', attrs: { class: 'site-info' }, kids: ['{{footer}}'] }];

  // everything else keeps only its shape
  const SAFE = /^[A-Za-z0-9 _:./@%-]*$/;
  const keepAttr = (k, v) => (k === 'class' || k === 'id' || /^data-[a-z0-9-]+$/.test(k) ? SAFE.test(v) : k === 'role' ? /^(banner|navigation|main|contentinfo|region|list|listitem|presentation|none)$/.test(v) : k === 'aria-hidden' ? v === 'true' || v === 'false' : false);
  const clean = (n) => {
    const kids = [];
    for (const k of n.kids) {
      if (!isEl(k)) {
        if (/^\{\{[a-z-]+\}\}$/.test(k)) kids.push(k);
        continue; // demo text is gone
      }
      if (matchesAny(k, /skip-link|screen-reader-text/)) continue;
      clean(k);
      if (SKELETON_TAGS.has(k.tag)) {
        const attrs = {};
        for (const [a, v] of Object.entries(k.attrs)) {
          if (a === 'href' && k.tag === 'a') attrs.href = v === '{{home}}' ? v : '#';
          else if (a === 'rel' && k.tag === 'a') {
            if (v === 'home') attrs.rel = v;
          } else if (keepAttr(a, v)) attrs[a] = v.trim();
        }
        if (k.tag === 'a' && !attrs.href) attrs.href = '#';
        kids.push({ tag: k.tag, attrs, kids: k.kids });
      } else kids.push(...k.kids); // an element outside the grammar is unwrapped
    }
    n.kids = kids;
  };
  clean(root);

  const out = (n) => (typeof n === 'string' ? n : `<${n.tag}${Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>${n.tag === 'br' || n.tag === 'hr' ? '' : `${n.kids.map(out).join('')}</${n.tag}>`}`);
  const html = root.kids.map(out).join('').replace(/>\s+</g, '><').trim();
  if (html.length > SKELETON_MAX) return null;
  try {
    checkSkeleton(html);
  } catch {
    return null;
  }
  const tokens = (bodyClassRaw ? bodyClassRaw[1] : '').split(/\s+/).filter((t) => /^[A-Za-z0-9_-]+$/.test(t) && !ROUTING.test(t));
  let bodyClass = [...new Set([...tokens, 'no-sidebar'])].join(' ');
  while (bodyClass.length > 300) bodyClass = bodyClass.replace(/\s+\S+$/, '');
  try {
    checkBodyClass(bodyClass);
  } catch {
    bodyClass = '';
  }
  return { html, bodyClass };
}

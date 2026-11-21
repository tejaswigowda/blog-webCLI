// The reserved post-content class contract. Ordinary author classes are not interpreted.
import { Refusal } from './errors.js';
import { parseHtml } from './html-tree.js';
import { counterName } from './counters.js';

export const WIDGET_CLASSES = Object.freeze(['wc-faq', 'wc-note', 'wc-columns', 'wc-col', 'wc-figure', 'wc-credit', 'wc-button', 'wc-quote', 'wc-steps', 'wc-compare', 'wc-embed', 'wc-video', 'wc-film-cards', 'wc-markdown']);
const known = new Set(WIDGET_CLASSES);
const bad = (name, why) => { throw new Refusal('bad-widget', `${name}: ${why}`); };
const distance = (a, b) => {
  let row = [...Array(b.length + 1).keys()];
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(a[i] !== b[j])));
    row = next;
  }
  return row[b.length];
};
export function checkWidgetClass(name) {
  if (name.startsWith('wc-count-') && counterName(name)) return;
  if (name.startsWith('wc-') && !known.has(name)) {
    const nearest = [...known].sort((a, b) => distance(name, a) - distance(name, b) || a.localeCompare(b))[0];
    bad(name, `unknown reserved class; nearest known class is "${nearest}"`);
  }
}

// Also check trusted generated/skeleton markup: the generator may not invent reserved names.
export function checkWidgetMarkup(html) {
  validateWidgetTree(parseHtml(html), true);
}

const VOID = new Set(['br', 'col', 'hr', 'img', 'wbr']);
function widgetTree(tokens) {
  const root = { tag: '', attrs: {}, children: [], parent: null };
  const stack = [root];
  for (const tok of tokens) {
    if (tok.t === 'open') {
      const parent = stack.at(-1);
      const node = { tag: tok.tag, attrs: Object.fromEntries(tok.attrs), children: [], parent };
      parent.children.push(node);
      if (!VOID.has(tok.tag)) stack.push(node);
    } else if (tok.t === 'close') stack.pop();
    else if (tok.t === 'text' && tok.text.trim()) stack.at(-1).children.push(tok.text);
  }
  return root;
}
const has = (n, c) => !!n && typeof n !== 'string' && (n.attrs.class || '').split(/\s+/).includes(c);
const elements = (n) => n.children.filter((c) => typeof c !== 'string');
const content = (n) => n.children.some((c) => typeof c === 'string' ? c.trim() : c.tag === 'img' || content(c));
const only = (n, pred) => n.children.length > 0 && n.children.every((c) => typeof c !== 'string' && pred(c));
const figure = (n, name, credit) => {
  const kids = elements(n);
  if (n.tag !== 'figure' || kids.length !== 2 || kids[0].tag !== 'img' || kids[1].tag !== 'figcaption' || !only(n, (c) => kids.includes(c))) bad(name, 'use figure containing one img followed by one figcaption');
  if (!kids[0].attrs.src?.trim() || !kids[0].attrs.alt?.trim() || !content(kids[1])) bad(name, 'the image needs a source, alternative text and a nonempty caption');
  if (credit && !elements(kids[1]).some((c) => has(c, 'wc-credit'))) bad(name, 'figcaption needs a small.wc-credit credit line');
};

export function validateWidgets(tokens) {
  validateWidgetTree(widgetTree(tokens));
}

export function isEmbedUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function embedSandbox(className = '') {
  return className.split(/\s+/).includes('allow-popups')
    ? 'allow-scripts allow-popups allow-popups-to-escape-sandbox'
    : 'allow-scripts';
}

function validateWidgetTree(root, rendered = false) {
  const prepare = (n, parent) => {
    if (typeof n === 'string') return;
    n.parent = parent;
    n.children = n.children.filter((c) => typeof c !== 'string' || c.trim());
    for (const c of n.children) prepare(c, n);
  };
  prepare(root, null);
  const visit = (n) => {
    if (typeof n === 'string') return;
    const counter = counterName(n.attrs.class);
    if (counter && (n.tag !== 'span' || (!rendered && n.children.length))) bad(`wc-count-${counter}`, 'use an empty span');
    for (const name of (n.attrs.class || '').split(/\s+/)) {
      checkWidgetClass(name);
      if (!known.has(name)) continue;
      const kids = elements(n);
      if (name === 'wc-faq') {
        if (n.tag !== 'div' || !only(n, (c) => c.tag === 'details')) bad(name, 'use div containing one or more details elements');
        for (const d of kids) {
          if (d.children[0]?.tag !== 'summary' || elements(d).filter((c) => c.tag === 'summary').length !== 1 || !content(d.children[0]) || !d.children.slice(1).some((c) => typeof c === 'string' ? c.trim() : content(c))) bad(name, 'each details needs one nonempty summary first, followed by an answer');
        }
      } else if (name === 'wc-note') {
        if (n.tag !== 'aside' || !content(n) || ['note', 'warning', 'tip'].filter((c) => has(n, c)).length !== 1) bad(name, 'use a nonempty aside with exactly one variant: note, warning or tip');
      } else if (name === 'wc-columns') {
        if (n.tag !== 'div' || kids.length < 2 || !only(n, (c) => c.tag === 'div' && has(c, 'wc-col'))) bad(name, 'use div containing at least two div.wc-col children and nothing else');
      } else if (name === 'wc-col') {
        if (n.tag !== 'div' || !has(n.parent, 'wc-columns') || !content(n)) bad(name, 'use a nonempty div directly inside wc-columns');
      } else if (name === 'wc-figure') figure(n, name, true);
      else if (name === 'wc-credit') {
        if (n.tag !== 'small' || n.parent.tag !== 'figcaption' || !has(n.parent.parent, 'wc-figure') || !content(n)) bad(name, 'use nonempty small inside the figcaption of wc-figure');
      } else if (name === 'wc-button') {
        if (n.tag !== 'a' || !n.attrs.href?.trim() || !content(n)) bad(name, 'use a nonempty a with an href, not a button');
      } else if (name === 'wc-quote') {
        if (n.tag !== 'blockquote' || !kids.some((c) => c.tag === 'p' && content(c)) || !only(n, (c) => c.tag === 'p' || c.tag === 'cite') || kids.filter((c) => c.tag === 'cite').length > 1 || (kids.some((c) => c.tag === 'cite') && kids.at(-1).tag !== 'cite')) bad(name, 'use blockquote containing paragraphs and an optional final cite');
      } else if (name === 'wc-steps') {
        const ol = n.tag === 'ol' ? n : n.tag === 'div' && n.children.length === 1 && kids[0]?.tag === 'ol' ? kids[0] : null;
        if (!ol || !only(ol, (c) => c.tag === 'li' && content(c))) bad(name, 'use a nonempty ol of li steps, or a div wrapping that ol');
      } else if (name === 'wc-compare') {
        if (n.tag !== 'div' || kids.length !== 2 || !only(n, (c) => c.tag === 'figure')) bad(name, 'use div containing exactly two figures (side-by-side, not a slider)');
        for (const f of kids) figure(f, name, false);
      } else if (name === 'wc-embed') {
        if (!rendered && (n.parent?.tag !== '' || n.parent.children.length !== 1)) bad(name, 'keep the embed as its own block');
        const frame = rendered && kids[0]?.tag === 'iframe' ? kids[0] : null;
        const link = kids[frame ? 1 : 0];
        if (n.tag !== 'div' || !n.attrs.title?.trim() || kids.length !== (frame ? 2 : 1) || !only(n, (c) => c === frame || c === link) || link?.tag !== 'a' || !content(link) || !isEmbedUrl(link.attrs.href)) bad(name, 'use a titled div with one link to an HTTPS embed');
        if (frame && (frame.attrs.src !== link.attrs.href || frame.attrs.title !== n.attrs.title || frame.attrs.sandbox !== embedSandbox(n.attrs.class) || frame.attrs.referrerpolicy !== 'no-referrer')) bad(name, 'invalid generated iframe');
      } else if (name === 'wc-video') {
        if (!rendered && (n.parent?.tag !== '' || n.parent.children.length !== 1)) bad(name, 'keep the video as its own block');
        const video = rendered && kids[0]?.tag === 'video' ? kids[0] : null;
        const link = kids[video ? 1 : 0];
        if (n.tag !== 'div' || !n.attrs.title?.trim() || kids.length !== (video ? 2 : 1) || !only(n, (c) => c === video || c === link) || link?.tag !== 'a' || !content(link) || !isEmbedUrl(link.attrs.href) || !/\.(?:mp4|webm|ogv)(?:[?#]|$)/i.test(new URL(link.attrs.href).pathname)) bad(name, 'use a titled div with one HTTPS link to an MP4, WebM or Ogg video');
        if (video && (video.attrs.src !== link.attrs.href || video.attrs.title !== n.attrs.title || !('controls' in video.attrs) || video.attrs.preload !== 'metadata')) bad(name, 'invalid generated video');
      } else if (name === 'wc-film-cards') {
        if (n.tag !== 'ul' || !only(n, (c) => c.tag === 'li' && elements(c).length === 1 && elements(c)[0].tag === 'article')) bad(name, 'use a list of film cards');
      } else if (name === 'wc-markdown') {
        if (n.tag !== 'div') bad(name, 'use a div');
        if (!rendered) {
          if (n.parent?.tag !== '' || n.parent.children.length !== 1) bad(name, 'keep the Markdown widget as its own block');
          const pre = kids[0];
          const code = pre && elements(pre)[0];
          if (kids.length !== 1 || !only(n, (c) => c === pre) || pre.tag !== 'pre' || elements(pre).length !== 1 || !only(pre, (c) => c === code) || code.tag !== 'code' || code.children.some((c) => typeof c !== 'string')) bad(name, 'use div containing one pre and one plain-text code element');
        }
      }
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
}

// Structural properties are protected; themes restyle via the --wc-* tokens and ordinary visual rules.
export const WIDGET_CSS = `
:is(.wc-faq,.wc-note,.wc-columns,.wc-col,.wc-figure,.wc-button,.wc-quote,.wc-steps,.wc-compare){box-sizing:border-box;min-width:0;max-width:100%;overflow-wrap:anywhere}
.wc-embed,.wc-video,.wc-film-cards,.wc-markdown{box-sizing:border-box;min-width:0;max-width:100%;overflow-wrap:anywhere}
.wc-video{margin:1.5rem 0}
.wc-video video{display:block;width:100%;height:auto}
.wc-video>a{display:inline-block;margin-top:.4rem}
.wc-embed{margin:1.5rem 0}
.wc-embed iframe{display:block;width:100%;aspect-ratio:16/9;border:0}
.wc-embed>a{display:block;width:fit-content;margin:.4rem 0 0 auto}
.wc-film-cards{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr));gap:1.25rem}
.wc-film-cards .card{height:100%;display:flex;flex-direction:column;border:1px solid var(--wc-border,var(--rule,#aaa));border-radius:var(--wc-radius,.4rem);overflow:hidden}
.wc-film-cards .card-poster img{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:cover}
.wc-film-cards .card-body{padding:.75rem 1rem;display:flex;flex-direction:column;flex:1}
.wc-film-cards .ships{margin-top:auto}
:is(.wc-faq,.wc-note,.wc-figure,.wc-quote,.wc-steps,.wc-compare){margin:1.5rem 0}
.wc-faq{display:block!important}
.wc-faq>details{display:block!important;margin:.6rem 0;padding:1rem;border:1px solid var(--wc-border,var(--rule,#aaa));border-radius:var(--wc-radius,.4rem)}
.wc-faq>details>summary{display:list-item!important;cursor:pointer;font-weight:600}
.wc-faq>details[open]>summary{margin-bottom:.75rem}
.wc-note{display:block!important;padding:1rem 1.25rem;border:1px solid var(--wc-border,var(--rule,#aaa));border-inline-start:4px solid var(--wc-accent,var(--link,#246));border-radius:var(--wc-radius,.4rem);background:var(--wc-surface,var(--code,Canvas));color:inherit}
.wc-note.warning{border-inline-start-color:var(--wc-warning,#a86600)}
.wc-note.tip{border-inline-start-color:var(--wc-tip,#16834b)}
.wc-columns{display:grid!important;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr))!important;gap:var(--wc-gap,1.25rem);margin:1.5rem 0}
.wc-col{display:block!important}
.wc-figure,.wc-compare>figure{display:block!important;float:none!important;width:auto!important;max-width:100%!important;margin:1.5rem 0!important}
.wc-figure>img,.wc-compare>figure>img{display:block!important;width:100%!important;max-width:100%!important;height:auto!important}
.wc-figure>figcaption,.wc-compare figcaption{display:block!important;margin-top:.5rem;font-size:.9em}
.wc-credit{display:block!important;margin-top:.3rem;color:var(--muted,inherit)}
.wc-button{display:inline-block!important;max-width:100%;white-space:normal;padding:.65rem 1rem;border:2px solid var(--wc-accent,var(--link,#246));border-radius:var(--wc-radius,.4rem);color:var(--wc-accent,var(--link,#246));text-decoration:none;font-weight:600}
.wc-button:focus-visible,.toc a:focus-visible,.anchor:focus-visible{outline:2px solid currentColor;outline-offset:3px}
.wc-quote{display:block!important;padding:1rem 1.25rem;border-inline-start:4px solid var(--wc-accent,var(--link,#246));background:var(--wc-surface,var(--code,Canvas));color:inherit}
.wc-quote>cite{display:block!important;font-size:.9em}
.wc-steps:where(ol),.wc-steps>ol{display:block!important;list-style:decimal!important;padding-inline-start:2rem}
.wc-steps>li,.wc-steps>ol>li{display:list-item!important;margin:.75rem 0;padding:.5rem}
.wc-steps li::marker{font-weight:700;color:var(--wc-accent,var(--link,#246))}
.wc-compare{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:var(--wc-gap,1.25rem)}
.wc-compare>figure{min-width:0;margin:0!important}
:is(.wc-note,.wc-col,.wc-quote)>:first-child{margin-top:0}
:is(.wc-note,.wc-col,.wc-quote)>:last-child{margin-bottom:0}
.toc{display:block;margin:1.5rem 0;padding:1rem;border:1px solid var(--rule,#aaa);border-radius:var(--wc-radius,.4rem)}
.toc-title{font-weight:700;margin:0 0 .5rem}
.toc ol{margin:0;padding-inline-start:1.5rem}
.anchor{font-size:.75em;margin-inline-start:.35em;text-decoration:none}
@media(max-width:640px){.wc-columns,.wc-compare{grid-template-columns:minmax(0,1fr)!important}}
`.trim();

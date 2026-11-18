import { Refusal } from './errors.js';
import { escapeHtml as esc } from './html.js';
import { canonHtml, tokenizeHtml } from './rawhtml.js';
import { markdownWidget } from './markdown.js';

export const WIDGET_TYPES = Object.freeze([
  ['faq', 'FAQ accordion'], ['note', 'Note'], ['columns', 'Columns'], ['figure', 'Figure with credit'],
  ['button', 'Button link'], ['quote', 'Quote'], ['steps', 'Steps'], ['compare', 'Side-by-side comparison'], ['definitions', 'Definition list'],
  ['film-cards', 'Film cards'], ['embed', 'Iframe embed'], ['native-video', 'Native video'], ['markdown', 'Markdown'],
]);
const bad = (s) => { throw new Refusal('bad-widget', s); };
const text = (v, name, optional = false) => {
  if (typeof v !== 'string' || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(v) || (!optional && !v.trim())) bad(`${name}: enter text`);
  return esc(v.trim());
};
const paragraphs = (v, name) => text(v, name).split(/\n\s*\n/).map((s) => `<p>${s.replace(/\s*\n\s*/g, ' ')}</p>`).join('\n');
const list = (v, name, min = 1) => {
  if (!Array.isArray(v) || v.length < min) bad(`${name}: use at least ${min} item${min === 1 ? '' : 's'}`);
  return v;
};
const imageFigure = (f, credit = false) => {
  if (!f || typeof f !== 'object') bad('figure: enter image details');
  return `<figure${credit ? ' class="wc-figure"' : ''}>
<img src="${text(f.image, 'Image')}" alt="${text(f.alt, 'Alternative text')}">
<figcaption>${text(f.caption, 'Caption')}${credit ? `<small class="wc-credit">${text(f.credit, 'Credit')}</small>` : ''}</figcaption>
</figure>`;
};

// Dialog fields are plain text. Rich, hand-edited HTML stays in the source editor.
export function widgetHtml(w) {
  let html;
  switch (w.type) {
    case 'faq':
      html = `<div class="wc-faq">\n${list(w.items, 'FAQ').map((i) => `<details${i.open ? ' open' : ''}><summary>${text(i.question, 'Question')}</summary>${paragraphs(i.answer, 'Answer')}</details>`).join('\n')}\n</div>`;
      break;
    case 'note':
      if (!['note', 'warning', 'tip'].includes(w.variant)) bad('wc-note: choose note, warning or tip');
      html = `<aside class="wc-note ${w.variant}">\n${paragraphs(w.text, 'Note')}\n</aside>`;
      break;
    case 'columns':
      html = `<div class="wc-columns">\n${list(w.columns, 'Columns', 2).map((c) => `<div class="wc-col">${paragraphs(c, 'Column')}</div>`).join('\n')}\n</div>`;
      break;
    case 'figure': html = imageFigure(w, true); break;
    case 'button': html = `<a class="wc-button" href="${text(w.url, 'Link address')}">${text(w.label, 'Link label')}</a>`; break;
    case 'quote': html = `<blockquote class="wc-quote">\n${paragraphs(w.text, 'Quote')}${w.citation?.trim() ? `\n<cite>${text(w.citation, 'Citation')}</cite>` : ''}\n</blockquote>`; break;
    case 'steps': html = `<ol class="wc-steps">\n${list(w.items, 'Steps').map((s) => `<li>${paragraphs(s, 'Step')}</li>`).join('\n')}\n</ol>`; break;
    case 'compare':
      if (!Array.isArray(w.figures) || w.figures.length !== 2) bad('wc-compare: use exactly two figures');
      html = `<div class="wc-compare">\n${w.figures.map((f) => imageFigure(f)).join('\n')}\n</div>`;
      break;
    case 'definitions': html = `<dl>\n${list(w.items, 'Definitions').map((i) => `<dt>${text(i.term, 'Term')}</dt><dd>${paragraphs(i.definition, 'Definition')}</dd>`).join('\n')}\n</dl>`; break;
    case 'embed': html = `<div class="wc-embed${w.allowPopups ? ' allow-popups' : ''}" title="${text(w.title, 'Embed title')}"><a href="${text(w.url, 'Embed address')}">Open embed</a></div>`; break;
    case 'native-video': html = `<div class="wc-video" title="${text(w.title, 'Video title')}"><a href="${text(w.url, 'Video address')}">Open video</a></div>`; break;
    case 'markdown':
      if (typeof w.markdown !== 'string' || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(w.markdown)) bad('Markdown: enter text without control characters');
      html = `<div class="wc-markdown"><pre><code>${esc(w.markdown).replace(/\n/g, '&#10;')}</code></pre></div>`;
      markdownWidget(html);
      break;
    case 'film-cards':
      html = `<ul class="wc-film-cards cards"${w.id ? ` id="${text(w.id, 'Section anchor')}"` : ''}>\n${list(w.cards, 'Film cards').map((c) => {
        if (!['demonstration', 'derivation'].includes(c.status)) bad('Film status: choose demonstration or derivation');
        const status = c.status === 'demonstration' ? 'Demonstration' : 'Derivation';
        const gloss = c.status === 'demonstration' ? 'Shows the relationship in particular cases. It does not prove it in general.' : 'An argument that holds for every case its assumptions cover.';
        return `<li><article class="card">
<a class="card-poster" href="${text(c.url, 'Film link')}" aria-hidden="true"><img src="${text(c.image, 'Poster')}" alt="" width="1280" height="720"></a>
<div class="card-body">
<h3><a href="${text(c.url, 'Film link')}">${text(c.title, 'Film title')}</a></h3>
<p class="meta"><span>${text(c.topic, 'Topic')}</span> <span aria-hidden="true">&middot;</span> <span class="duration">${text(c.duration, 'Duration')}</span> <span aria-hidden="true">&middot;</span> <span class="badge badge-${c.status}" title="${gloss}">${status}</span></p>
<p class="claim">${text(c.claim, 'Claim')}</p>
<p class="ships"><span class="ships-label">Ships its own source:</span> <a class="open-scene" href="${text(c.scene, 'Scene link')}">Open the scene</a> <span aria-hidden="true">&middot;</span> <a href="${text(c.tutorial, 'Tutorial link')}">Tutorial</a></p>
</div>
</article></li>`;
      }).join('\n')}\n</ul>`;
      break;
    default: bad(`Unknown widget type "${w.type}"`);
  }
  const src = canonHtml(html);
  tokenizeHtml(src);
  return src;
}

export function newWidget(type) {
  switch (type) {
    case 'faq': return { type, items: [{ question: '', answer: '', open: false }] };
    case 'note': return { type, variant: 'note', text: '' };
    case 'columns': return { type, columns: ['', ''] };
    case 'figure': return { type, image: '', alt: '', caption: '', credit: '' };
    case 'button': return { type, url: '', label: '' };
    case 'quote': return { type, text: '', citation: '' };
    case 'steps': return { type, items: [''] };
    case 'compare': return { type, figures: [0, 1].map(() => ({ image: '', alt: '', caption: '' })) };
    case 'definitions': return { type, items: [{ term: '', definition: '' }] };
    case 'embed': return { type, title: '', url: '' };
    case 'native-video': return { type, title: '', url: '' };
    case 'markdown': return { type, markdown: '' };
    case 'film-cards': return { type, cards: [{ image: '', url: '', title: '', topic: '', duration: '', status: 'demonstration', claim: '', scene: '', tutorial: '' }] };
    default: bad(`Unknown widget type "${type}"`);
  }
}

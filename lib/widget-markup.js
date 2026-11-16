import { Refusal } from './errors.js';
import { escapeHtml as esc } from './html.js';
import { canonHtml, tokenizeHtml } from './rawhtml.js';

export const WIDGET_TYPES = Object.freeze([
  ['faq', 'FAQ accordion'], ['note', 'Note'], ['columns', 'Columns'], ['figure', 'Figure with credit'],
  ['button', 'Button link'], ['quote', 'Quote'], ['steps', 'Steps'], ['compare', 'Side-by-side comparison'], ['definitions', 'Definition list'],
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
    default: bad(`Unknown widget type "${type}"`);
  }
}

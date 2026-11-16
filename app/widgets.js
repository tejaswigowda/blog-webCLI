import { el, dialog } from './block-dialog.js';
import { WIDGET_TYPES, newWidget, widgetHtml } from '../lib/widget-markup.js';
import { deltaToMarkdownChecked } from '../lib/markdown.js';

export const widgetLabel = (type) => WIDGET_TYPES.find(([t]) => t === type)?.[1];
const ps = (n) => [...n.children].filter((c) => c.tagName === 'P').map((p) => p.textContent).join('\n\n');
const figureOf = (n) => ({
  image: n.querySelector('img')?.getAttribute('src') || '',
  alt: n.querySelector('img')?.getAttribute('alt') || '',
  caption: [...(n.querySelector('figcaption')?.childNodes || [])].filter((c) => c.nodeType !== 1 || !c.classList.contains('wc-credit')).map((c) => c.textContent).join(''),
  credit: n.querySelector('.wc-credit')?.textContent || '',
});
export function readWidget(src) {
  const root = new DOMParser().parseFromString(src, 'text/html').body.firstElementChild;
  if (!root) return null;
  let w;
  const has = (c) => root.classList.contains(c);
  if (has('wc-faq')) w = { type: 'faq', items: [...root.children].map((n) => ({ question: n.querySelector('summary')?.textContent || '', answer: ps(n), open: n.hasAttribute('open') })) };
  else if (has('wc-note')) w = { type: 'note', variant: ['note', 'warning', 'tip'].find((c) => has(c)), text: ps(root) };
  else if (has('wc-columns')) w = { type: 'columns', columns: [...root.children].map(ps) };
  else if (has('wc-figure')) w = { type: 'figure', ...figureOf(root) };
  else if (has('wc-button')) w = { type: 'button', url: root.getAttribute('href') || '', label: root.textContent };
  else if (has('wc-quote')) w = { type: 'quote', text: ps(root), citation: root.querySelector('cite')?.textContent || '' };
  else if (has('wc-steps') && root.tagName === 'OL') w = { type: 'steps', items: [...root.children].map(ps) };
  else if (has('wc-compare')) w = { type: 'compare', figures: [...root.children].map(figureOf) };
  else if (root.tagName === 'DL') w = { type: 'definitions', items: [...root.children].filter((n) => n.tagName === 'DT').map((n) => ({ term: n.textContent, definition: n.nextElementSibling?.tagName === 'DD' ? ps(n.nextElementSibling) : '' })) };
  if (!w) return null;
  // This is a losslessness probe, not validation: unrepresentable source keeps its Edit HTML route.
  try { return widgetHtml(w) === src ? w : null; } catch { return null; }
}

export function editWidget(initial, chooseImage) {
  let w = structuredClone(initial || newWidget('faq'));
  const fields = el('div');
  const select = el('select', { 'aria-label': 'Widget type', onchange: () => { w = newWidget(select.value); draw(); } },
    WIDGET_TYPES.map(([type, label]) => el('option', { value: type, selected: type === w.type }, label)));
  const body = el('div', {}, el('p', { class: 'hint' }, 'Native markup, no scripts required. Fields are plain text; separate paragraphs with a blank line. Use Edit HTML afterwards for rich content. Links can be relative, such as ./products/. Comparisons are side-by-side, not sliders.'), el('label', {}, 'Widget type', select), fields);
  const field = (obj, key, label, multiline = false) => el('label', {}, label, el(multiline ? 'textarea' : 'input', { 'aria-label': label, ...(multiline ? { rows: 3 } : { value: obj[key] || '' }), oninput: (e) => { obj[key] = e.target.value; } }, ...(multiline ? [obj[key] || ''] : [])));
  const image = (obj, prefix, credit = false) => {
    const source = field(obj, 'image', `${prefix} image`);
    const input = source.querySelector('input');
    return [source, el('button', { type: 'button', onclick: () => chooseImage((ref) => {
      input.value = ref;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }) }, `Choose ${prefix.toLowerCase()} from Media…`), field(obj, 'alt', `${prefix} alternative text`), field(obj, 'caption', `${prefix} caption`), ...(credit ? [field(obj, 'credit', 'Credit')] : [])];
  };
  const repeat = (items, title, blank, drawItem, min = 1) => [
    ...items.map((item, i) => el('fieldset', {}, el('legend', {}, `${title} ${i + 1}`), drawItem(item, i), el('div', { class: 'actions' },
      el('button', { type: 'button', disabled: i === 0, onclick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; draw(); } }, 'Move up'),
      el('button', { type: 'button', disabled: i === items.length - 1, onclick: () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; draw(); } }, 'Move down'),
      el('button', { type: 'button', disabled: items.length <= min, onclick: () => { items.splice(i, 1); draw(); } }, 'Remove')))),
    el('button', { type: 'button', onclick: () => { items.push(blank()); draw(); } }, `+ ${title}`),
  ];
  const draw = () => {
    let nodes;
    switch (w.type) {
      case 'faq':
        nodes = repeat(w.items, 'Question', () => ({ question: '', answer: '', open: false }), (item, i) => [
          field(item, 'question', `Question ${i + 1}`), field(item, 'answer', `Answer ${i + 1}`, true),
          el('label', {}, el('input', { type: 'checkbox', checked: item.open, onchange: (e) => { item.open = e.target.checked; } }), ' Initially open'),
        ]);
        break;
      case 'note':
        nodes = [el('label', {}, 'Variant', el('select', { 'aria-label': 'Variant', onchange: (e) => { w.variant = e.target.value; } }, ['note', 'warning', 'tip'].map((v) => el('option', { value: v, selected: w.variant === v }, v)))), field(w, 'text', 'Note', true)];
        break;
      case 'columns':
        nodes = repeat(w.columns, 'Column', () => '', (_, i) => field(w.columns, i, `Column ${i + 1}`, true), 2);
        break;
      case 'figure': nodes = image(w, 'Figure', true); break;
      case 'button': nodes = [field(w, 'url', 'Link address'), field(w, 'label', 'Link label')]; break;
      case 'quote': nodes = [field(w, 'text', 'Quote', true), field(w, 'citation', 'Citation (optional)')]; break;
      case 'steps': nodes = repeat(w.items, 'Step', () => '', (_, i) => field(w.items, i, `Step ${i + 1}`, true)); break;
      case 'compare': nodes = w.figures.map((f, i) => el('fieldset', {}, el('legend', {}, i === 0 ? 'Before' : 'After'), image(f, i === 0 ? 'Before' : 'After'))); break;
      case 'definitions': nodes = repeat(w.items, 'Definition', () => ({ term: '', definition: '' }), (item, i) => [field(item, 'term', `Term ${i + 1}`), field(item, 'definition', `Definition ${i + 1}`, true)]); break;
    }
    fields.replaceChildren(...nodes);
    body.dispatchEvent(new Event('change', { bubbles: true }));
  };
  draw();
  const read = () => {
    const src = widgetHtml(w);
    deltaToMarkdownChecked({ ops: [{ insert: { htmlblock: src } }, { insert: '\n' }] });
    return src;
  };
  return dialog(initial ? 'Edit widget' : 'Insert widget', body, { check: read, apply: read });
}

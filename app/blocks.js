// Tables and raw HTML blocks in the editor. Both are block embeds in Quill (as a video is): the document keeps the value
// ({ head, align, rows } or the HTML text) and the page shows a picture of it. Neither picture is ever markup built from the
// value: the table is made with DOM calls and textContent, and an HTML block is shown as its source, so what a post says
// cannot run in the editor, which holds the token. Editing happens in a dialog, because a table or a block is not typed into.
import { canonCell, deltaToMarkdownChecked, parseInline } from '../lib/markdown.js';
import { MAX_BLOCK, canonHtml, tokenizeHtml, ALLOWED_TAGS, htmlBlockClasses, withHtmlBlockClasses } from '../lib/rawhtml.js';
import { Refusal } from '../lib/errors.js';
import { slideshowHtml } from '../lib/slideshow.js';
import { DEFAULT_SLIDE_ANIMATION, SLIDE_ANIMATIONS } from '../lib/animations.js';
import { deltaToHtmlGroup } from '../lib/html.js';
import { el, dialog } from './block-dialog.js';
import { editWidget, readWidget, widgetLabel } from './widgets.js';
import { highlightedTextarea, paintHtmlSource } from './highlight.js';

export const NEW_TABLE = () => ({ head: ['Column 1', 'Column 2'], align: ['', ''], rows: [['', ''], ['', '']] });

// A cell's inline markdown as it reads: the words, with bold, italic and code drawn.
function cellNodes(md) {
  return parseInline(md).map((o) => {
    if (typeof o.insert !== 'string') return document.createTextNode('[image]');
    const a = o.attributes || {};
    let node = document.createTextNode(o.insert);
    for (const [flag, tag] of [['code', 'code'], ['strike', 's'], ['italic', 'em'], ['bold', 'strong'], ['link', 'u']]) if (a[flag]) node = el(tag, {}, node);
    return node;
  });
}

export function paintTable(node, t) {
  const cell = (tag, md, a) => {
    const n = el(tag, {}, cellNodes(md));
    if (a) n.style.textAlign = a;
    return n;
  };
  const table = el('table', {}, el('thead', {}, el('tr', {}, t.head.map((c, i) => cell('th', c, t.align[i])))), el('tbody', {}, t.rows.map((r) => el('tr', {}, r.map((c, i) => cell('td', c, t.align[i]))))));
  node.replaceChildren(el('div', { class: 'blk-bar', contenteditable: 'false' }, el('span', {}, `Table · ${t.head.length} columns, ${t.rows.length} rows`), el('button', { type: 'button', class: 'blk-edit' }, 'Edit table')), table);
}

export function paintHtml(node, src) {
  const slides = readSlideshow(src);
  const widget = !slides && readWidget(src);
  let classes;
  if (!slides && !widget) {
    let names;
    let problem = 'Classes: use Edit HTML to add one outer wrapper first.';
    try {
      names = htmlBlockClasses(src);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      problem = `Class editing unavailable: ${e.detail}`;
    }
    classes = names == null ? el('span', { class: 'blk-class-help' }, problem) : el('form', {
      class: 'blk-classes',
      onkeydown: (e) => e.stopPropagation(),
    }, el('label', {}, 'Classes', el('input', { value: names, 'aria-label': 'HTML block CSS classes', placeholder: 'testimonial featured' })),
    el('button', { type: 'submit' }, 'Apply classes'),
    el('span', { class: 'blk-class-error', role: 'alert' }));
  }
  const source = el('pre');
  paintHtmlSource(source, src);
  node.replaceChildren(el('div', { class: 'blk-bar', contenteditable: 'false' }, el('span', {}, slides ? `Slideshow · ${slides.length} slides` : widget ? widgetLabel(widget.type) : 'HTML block'), classes, el('button', { type: 'button', class: 'blk-edit' }, slides ? 'Edit slideshow' : widget ? 'Edit widget' : 'Edit HTML'), widget && el('button', { type: 'button', class: 'blk-source' }, 'Edit HTML')), source);
}

function readSlideshow(src) {
  if (!src.startsWith('<section class="webcli-slideshow"')) return null;
  const doc = new DOMParser().parseFromString(src, 'text/html');
  const animationOf = (node) => node && [...node.classList].find((name) => name.startsWith('webcli-animate-'))?.slice('webcli-animate-'.length);
  const slides = [...doc.querySelectorAll('figure.webcli-slide')].map((figure) => ({
    image: figure.querySelector('img')?.getAttribute('src') || '',
    alt: figure.querySelector('img')?.getAttribute('alt') || '',
    title: figure.querySelector('h2')?.textContent || '',
    text: figure.querySelector('p')?.textContent || '',
    label: figure.querySelector('a')?.textContent || '',
    url: figure.querySelector('a')?.getAttribute('href') || '',
    animation: animationOf(figure),
    imageAnimation: animationOf(figure.querySelector('img')) ?? undefined,
    titleAnimation: animationOf(figure.querySelector('h2')) ?? undefined,
    textAnimation: animationOf(figure.querySelector('p')) ?? undefined,
    labelAnimation: animationOf(figure.querySelector('a')) ?? undefined,
  }));
  // Hand-edited HTML must stay in the HTML editor rather than lose anything this form cannot express.
  try {
    return slideshowHtml(slides) === src ? slides : null;
  } catch {
    return null;
  }
}

const fixed = (t) => ({ head: t.head.map(canonCell), align: t.align.map((a) => a || ''), rows: t.rows.map((r) => r.map(canonCell)) });
const provable = (t) => deltaToMarkdownChecked({ ops: [{ insert: { mdtable: t } }, { insert: '\n' }] });

// -> the new { head, align, rows }, or null when cancelled
export function editTable(initial = NEW_TABLE()) {
  const state = { head: [...initial.head], align: [...initial.align], rows: initial.rows.map((r) => [...r]) };
  const grid = el('div', { class: 'blk-grid' });
  const sync = (fromDom) => {
    if (!fromDom) return;
    grid.querySelectorAll('input[data-r]').forEach((i) => {
      const r = Number(i.dataset.r);
      const c = Number(i.dataset.c);
      if (r < 0) state.head[c] = i.value;
      else state.rows[r][c] = i.value;
    });
    grid.querySelectorAll('select[data-c]').forEach((s) => {
      state.align[Number(s.dataset.c)] = s.value;
    });
  };
  const draw = () => {
    const cols = state.head.length;
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(7rem, 1fr)) auto`;
    const cells = [];
    state.head.forEach((_, c) => cells.push(el('select', { 'data-c': c, 'aria-label': `Column ${c + 1} alignment` }, [['', 'Default'], ['left', 'Left'], ['right', 'Right'], ['center', 'Centre']].map(([v, t]) => el('option', { value: v, selected: state.align[c] === v }, t)))));
    cells.push(el('span'));
    state.head.forEach((v, c) => cells.push(el('input', { value: v, 'data-r': -1, 'data-c': c, class: 'blk-head', 'aria-label': `Header ${c + 1}` })));
    cells.push(el('button', { type: 'button', title: 'Remove the last column', disabled: cols < 2, onclick: () => { sync(true); state.head.pop(); state.align.pop(); state.rows.forEach((r) => r.pop()); draw(); } }, '− col'));
    state.rows.forEach((row, r) => {
      row.forEach((v, c) => cells.push(el('input', { value: v, 'data-r': r, 'data-c': c, 'aria-label': `Row ${r + 1}, column ${c + 1}` })));
      cells.push(el('button', { type: 'button', title: `Remove row ${r + 1}`, onclick: () => { sync(true); state.rows.splice(r, 1); draw(); } }, '× row'));
    });
    grid.replaceChildren(...cells);
    // inputs hold the state while the dialog is open; the selects are read the same way
    grid.querySelectorAll('input').forEach((i) => i.setAttribute('autocomplete', 'off'));
  };
  draw();
  const add = (what) => el('button', { type: 'button', onclick: () => {
    sync(true);
    if (what === 'row') state.rows.push(state.head.map(() => ''));
    else if (state.head.length < 50) {
      state.head.push(`Column ${state.head.length + 1}`);
      state.align.push('');
      state.rows.forEach((r) => r.push(''));
    }
    draw();
  } }, what === 'row' ? '+ Row' : '+ Column');
  const body = el('div', {}, el('p', { class: 'hint' }, 'Each cell is one line of inline markdown: **bold**, _italic_, `code`, [text](https://…), ![alt](asset:images/…). A | is fine.'), grid, el('div', { class: 'actions' }, add('row'), add('col')));
  const read = () => {
    sync(true);
    return fixed({ head: state.head, align: state.align, rows: state.rows });
  };
  return dialog('Table', body, { applyLabel: 'Apply', check: () => provable(read()), apply: () => read() });
}

// -> the block's canonical source, or null when cancelled
export function editHtml(initial = '') {
  const area = el('textarea', { rows: 12, class: 'mono', spellcheck: 'false', 'aria-label': 'HTML', placeholder: '<div class="note">\n  <p>Some <b>HTML</b></p>\n</div>' });
  area.value = initial;
  const source = highlightedTextarea(area, area.ownerDocument, (pre, html, doc) => paintHtmlSource(pre, `${html}\n`, doc));
  const body = el('div', {}, el('p', { class: 'hint' }, `A block of HTML, shown as written. Allowed tags: ${ALLOWED_TAGS.join(' ')}. No scripts, styles, frames, forms or event handlers; addresses are http(s), mailto, relative or asset: references. Blank lines end a block, so they are removed.`), source);
  const read = () => {
    const src = canonHtml(area.value);
    if (!src) throw new Error('Write some HTML.');
    if (src.length > MAX_BLOCK) throw new Error(`An HTML block may be at most ${MAX_BLOCK} characters.`);
    tokenizeHtml(src);
    return src;
  };
  return dialog('HTML block', body, { check: read, apply: read });
}

function editClasses(delta) {
  const input = el('input', { 'aria-label': 'CSS classes', placeholder: 'order-step featured', autocomplete: 'off' });
  const body = el('div', {},
    el('p', { class: 'hint' }, 'Complete selected blocks (or the current block) become one <div> HTML group. Formatting, links and images are kept. Afterwards use Edit HTML to change the content or classes. Style the group in Settings > Custom CSS, for example .order-step { border: 2px solid gray; }.'),
    el('label', {}, 'CSS classes (without dots)', input));
  const read = () => deltaToHtmlGroup(delta, input.value);
  return dialog('Group with CSS classes', body, { check: read, apply: read });
}

const blankSlide = () => ({ image: '', alt: '', title: '', text: '', label: '', url: '', animation: DEFAULT_SLIDE_ANIMATION });

export function editSlideshow(initial = [blankSlide(), blankSlide()], chooseImage) {
  const slides = initial.map((slide) => ({ ...slide }));
  let expanded = slides[0];
  const rows = el('div');
  const body = el('div', {}, el('p', { class: 'hint' }, '2-10 slides. Expand a slide to edit its content and animations. New slides open automatically.'),
    el('details', { class: 'more' }, el('summary', {}, 'Images, links and animations'), el('p', { class: 'hint' }, 'Choose an image from Media, upload a new image from the picker, or enter an asset: reference or https:// image address. New images upload only when you publish or save the draft. Choose effects for the whole slide and its image, heading, caption and link label. Set the whole slide to None to animate only individual elements. Use relative link addresses such as ./products/ for nearby pages. Slides rotate every 6 seconds. Reduced motion disables animation and starts paused. Without JavaScript, every slide stays visible.')), rows);
  const draw = () => {
    rows.replaceChildren(...slides.map((slide, i) => {
      const labelText = () => `Slide ${i + 1}${slide.title || slide.alt ? `: ${slide.title || slide.alt}` : ''}`;
      const summary = el('summary', {}, labelText());
      const animation = (key, title, fallback) => el('label', {}, title, el('select', { 'aria-label': `Slide ${i + 1} ${title.toLowerCase()}`, onchange: (e) => { slide[key] = e.target.value; } },
        SLIDE_ANIMATIONS.map((name) => el('option', { value: name, selected: (slide[key] ?? fallback) === name }, name === 'none' ? 'None' : name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()))),
      ));
      const fields = [['image', 'Image', 'asset:images/photo.jpg'], ['alt', 'Alternative text', 'Describe the picture'], ['title', 'Heading', 'Optional'], ['text', 'Caption', 'Optional'], ['label', 'Link label', 'Optional'], ['url', 'Link address', './products/']].map(([key, title, placeholder]) => {
        const input = el('input', { value: slide[key], placeholder, 'aria-label': `Slide ${i + 1} ${title.toLowerCase()}`, oninput: (e) => { slide[key] = e.target.value; summary.textContent = labelText(); } });
        const label = el('label', {}, title, input);
        if (['title', 'text', 'label'].includes(key)) return el('div', { class: 'blk-slide-row' }, label, animation(`${key}Animation`, `${title} animation`, 'none'));
        if (key !== 'image') return label;
        return el('div', {}, el('div', { class: 'blk-slide-row' }, label, animation('imageAnimation', 'Image animation', 'none')), el('button', { type: 'button', class: 'blk-slide-media', 'aria-label': `Choose image for slide ${i + 1}`, onclick: () => chooseImage((ref) => {
          input.value = ref;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }) }, 'Choose from Media…'));
      });
      const move = (offset) => {
        [slides[i], slides[i + offset]] = [slides[i + offset], slides[i]];
        expanded = slide;
        draw();
      };
      return el('details', { class: 'blk-slide', name: 'blk-slides', open: slide === expanded, ontoggle: (e) => {
        if (!e.currentTarget.isConnected) return;
        if (e.currentTarget.open) expanded = slide;
        else if (expanded === slide) expanded = null;
      } }, summary, el('div', { class: 'blk-slide-fields' }, ...fields, animation('animation', 'Animation', DEFAULT_SLIDE_ANIMATION), el('div', { class: 'actions' },
        el('button', { type: 'button', disabled: i === 0, onclick: () => move(-1), 'aria-label': `Move slide ${i + 1} up` }, 'Move up'),
        el('button', { type: 'button', disabled: i === slides.length - 1, onclick: () => move(1), 'aria-label': `Move slide ${i + 1} down` }, 'Move down'),
        el('button', { type: 'button', disabled: slides.length <= 2, onclick: () => { if (expanded === slide) expanded = slides[i + 1] || slides[i - 1]; slides.splice(i, 1); draw(); }, 'aria-label': `Remove slide ${i + 1}` }, 'Remove'),
      )));
    }));
    add.disabled = slides.length >= 10;
    body.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const add = el('button', { type: 'button', onclick: () => { expanded = blankSlide(); slides.push(expanded); draw(); } }, '+ Slide');
  body.append(add);
  draw();
  const read = () => slideshowHtml(slides);
  return dialog('Slideshow', body, { check: read, apply: read });
}

// ---------- Quill ----------
const ICONS = {
  mdtable: '<svg viewBox="0 0 18 18"><rect class="ql-stroke" x="2" y="3" width="14" height="12" fill="none"/><line class="ql-stroke" x1="2" x2="16" y1="7" y2="7"/><line class="ql-stroke" x1="2" x2="16" y1="11" y2="11"/><line class="ql-stroke" x1="9" x2="9" y1="3" y2="15"/></svg>',
  htmlblock: '<svg viewBox="0 0 18 18"><polyline class="ql-even ql-stroke" points="5 5 2 9 5 13"/><polyline class="ql-even ql-stroke" points="13 5 16 9 13 13"/><line class="ql-stroke" x1="10" x2="8" y1="4" y2="14"/></svg>',
  slideshow: '<svg viewBox="0 0 18 18"><rect class="ql-stroke" x="2" y="2" width="14" height="11" fill="none"/><polyline class="ql-stroke" points="4 10 7 6 10 9 12 7 14 10" fill="none"/><circle class="ql-fill" cx="6" cy="16" r="1"/><circle class="ql-fill" cx="9" cy="16" r="1"/><circle class="ql-fill" cx="12" cy="16" r="1"/></svg>',
  cssclasses: '<svg viewBox="0 0 18 18"><path class="ql-stroke" fill="none" d="M6 2H3v14h3M12 2h3v14h-3M8 5v8M11 5v8M6 7h7M6 11h7"/></svg>',
  widget: '<svg viewBox="0 0 18 18"><path class="ql-stroke" fill="none" d="M2 2h6v6H2zM11 2h5v6h-5zM2 11h6v5H2zM11 11h5v5h-5z"/></svg>',
};

// Register the two block embeds with Quill.
export function registerBlocks(Quill) {
  const BlockEmbed = Quill.import('blots/block/embed');
  class MdTable extends BlockEmbed {
    static create(value) {
      const node = super.create();
      node.setAttribute('contenteditable', 'false');
      node.setAttribute('data-mdtable', JSON.stringify(value));
      paintTable(node, value);
      return node;
    }

    static value(node) {
      return JSON.parse(node.getAttribute('data-mdtable'));
    }
  }
  MdTable.blotName = 'mdtable';
  MdTable.tagName = 'div';
  MdTable.className = 'ql-mdtable';
  class HtmlBlock extends BlockEmbed {
    static create(value) {
      const node = super.create();
      node.setAttribute('contenteditable', 'false');
      node.setAttribute('data-htmlblock', value);
      paintHtml(node, value);
      return node;
    }

    static value(node) {
      return node.getAttribute('data-htmlblock');
    }
  }
  HtmlBlock.blotName = 'htmlblock';
  HtmlBlock.tagName = 'div';
  HtmlBlock.className = 'ql-htmlblock';
  Quill.register('formats/mdtable', MdTable, true);
  Quill.register('formats/htmlblock', HtmlBlock, true);
  const icons = Quill.import('ui/icons');
  icons.mdtable = ICONS.mdtable;
  icons.htmlblock = ICONS.htmlblock;
  icons.slideshow = ICONS.slideshow;
  icons.cssclasses = ICONS.cssclasses;
  icons.widget = ICONS.widget;
  icons.codewidget = '<svg viewBox="0 0 18 18"><polyline class="ql-stroke" fill="none" points="6 4 2 9 6 14"/><polyline class="ql-stroke" fill="none" points="12 4 16 9 12 14"/><line class="ql-stroke" x1="10" x2="8" y1="3" y2="15"/></svg>';
}

// Insert and edit from the toolbar and by clicking a block's Edit button.
export function wireBlocks(quill, Quill, { chooseImage }) {
  // the cursor is read before the dialog opens: the dialog takes focus, and the editor has no selection when it closes
  const cursor = () => {
    const range = quill.getSelection(true);
    return range ? range.index : Math.max(0, quill.getLength() - 1);
  };
  const insert = async (kind, edit) => {
    const index = cursor();
    const v = await edit();
    if (!v) return;
    const history = quill.getModule('history');
    history.cutoff();
    quill.insertEmbed(index, kind, v, 'user');
    history.cutoff();
    quill.setSelection(index + 1, 0, 'silent');
  };
  const tableHandler = () => insert('mdtable', () => editTable());
  const htmlHandler = () => insert('htmlblock', () => editHtml());
  const slideshowHandler = () => insert('htmlblock', () => editSlideshow(undefined, chooseImage));
  const widgetHandler = () => insert('htmlblock', () => editWidget(undefined, chooseImage));
  const classesHandler = async () => {
    const range = quill.getSelection(true) || { index: Math.max(0, quill.getLength() - 1), length: 0 };
    const [first] = quill.getLine(range.index);
    const [last] = quill.getLine(range.index + Math.max(0, range.length - 1));
    const start = quill.getIndex(first);
    const length = quill.getIndex(last) + last.length() - start;
    const next = await editClasses(quill.getContents(start, length));
    if (next) {
      const Delta = Quill.import('delta');
      const history = quill.getModule('history');
      history.cutoff();
      quill.updateContents(new Delta().retain(start).delete(length).insert({ htmlblock: next }), 'user');
      history.cutoff();
    }
    quill.setSelection(next ? start + 1 : range.index, next ? 0 : range.length, 'silent');
  };
  quill.root.addEventListener('submit', (e) => {
    const form = e.target.closest('.blk-classes');
    if (!form) return;
    e.preventDefault();
    const node = form.closest('.ql-htmlblock');
    const src = node.getAttribute('data-htmlblock');
    let next;
    try {
      next = withHtmlBlockClasses(src, form.querySelector('input').value);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      form.querySelector('.blk-class-error').textContent = error.detail;
      form.querySelector('input').setAttribute('aria-invalid', 'true');
      return;
    }
    if (next === src) {
      form.querySelector('.blk-class-error').textContent = '';
      form.querySelector('input').removeAttribute('aria-invalid');
      return;
    }
    const index = quill.getIndex(Quill.find(node));
    const Delta = Quill.import('delta');
    const history = quill.getModule('history');
    history.cutoff();
    quill.updateContents(new Delta().retain(index).delete(1).insert({ htmlblock: next }), 'user');
    history.cutoff();
    quill.setSelection(index + 1, 0, 'silent');
  });
  quill.root.addEventListener('click', async (e) => {
    const button = e.target.closest && e.target.closest('.blk-edit, .blk-source');
    const node = button && button.closest('.ql-mdtable, .ql-htmlblock');
    if (!node) return;
    e.preventDefault();
    const blot = Quill.find(node);
    const index = quill.getIndex(blot);
    const isTable = node.classList.contains('ql-mdtable');
    const src = node.getAttribute('data-htmlblock');
    const slides = !isTable && readSlideshow(src);
    const widget = !isTable && !slides && readWidget(src);
    const next = isTable ? await editTable(JSON.parse(node.getAttribute('data-mdtable'))) : slides ? await editSlideshow(slides, chooseImage) : widget && !button.classList.contains('blk-source') ? await editWidget(widget, chooseImage) : await editHtml(src);
    if (!next) return;
    const Delta = Quill.import('delta');
    const history = quill.getModule('history');
    history.cutoff();
    quill.updateContents(new Delta().retain(index).delete(1).insert({ [isTable ? 'mdtable' : 'htmlblock']: next }), 'user');
    history.cutoff();
  });
  return { mdtable: tableHandler, htmlblock: htmlHandler, slideshow: slideshowHandler, cssclasses: classesHandler, widget: widgetHandler };
}

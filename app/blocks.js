// Tables and raw HTML blocks in the editor. Both are block embeds in Quill (as a video is): the document keeps the value
// ({ head, align, rows } or the HTML text) and the page shows a picture of it. Neither picture is ever markup built from the
// value: the table is made with DOM calls and textContent, and an HTML block is shown as its source, so what a post says
// cannot run in the editor, which holds the token. Editing happens in a dialog, because a table or a block is not typed into.
import { canonCell, deltaToMarkdownChecked, parseInline } from '../lib/markdown.js';
import { MAX_BLOCK, canonHtml, tokenizeHtml, ALLOWED_TAGS } from '../lib/rawhtml.js';
import { slideshowHtml } from '../lib/slideshow.js';
import { DEFAULT_SLIDE_ANIMATION, SLIDE_ANIMATIONS } from '../lib/animations.js';

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  n.append(...kids.flat().filter((k) => k != null && k !== false));
  return n;
};

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
  node.replaceChildren(el('div', { class: 'blk-bar', contenteditable: 'false' }, el('span', {}, slides ? `Slideshow · ${slides.length} slides` : 'HTML block'), el('button', { type: 'button', class: 'blk-edit' }, slides ? 'Edit slideshow' : 'Edit HTML')), el('pre', {}, src));
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

// ---------- dialogs ----------
function dialog(title, body, { apply, applyLabel = 'Apply', check }) {
  return new Promise((resolve) => {
    const dlg = el('dialog', { class: 'blk-dialog' });
    const msg = el('p', { class: 'blk-msg', role: 'alert' });
    const ok = el('button', { type: 'button', class: 'primary' }, applyLabel);
    const cancel = el('button', { type: 'button' }, 'Cancel');
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    const refresh = () => {
      let problem = '';
      try {
        check();
      } catch (e) {
        problem = e && (e.detail || e.message) ? e.detail || e.message : String(e);
      }
      msg.textContent = problem;
      ok.disabled = !!problem;
    };
    ok.addEventListener('click', () => {
      refresh();
      if (!ok.disabled) done(apply());
    });
    cancel.addEventListener('click', () => done(null));
    dlg.addEventListener('cancel', () => done(null));
    dlg.addEventListener('input', refresh);
    dlg.addEventListener('change', refresh);
    dlg.append(el('h2', {}, title), body, msg, el('div', { class: 'actions' }, ok, cancel));
    document.body.append(dlg);
    refresh();
    dlg.showModal();
  });
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
  const body = el('div', {}, el('p', { class: 'hint' }, `A block of HTML, shown as written. Allowed tags: ${ALLOWED_TAGS.join(' ')}. No scripts, styles, frames, forms or event handlers; addresses are http(s), mailto, relative or asset: references. Blank lines end a block, so they are removed.`), area);
  const read = () => {
    const src = canonHtml(area.value);
    if (!src) throw new Error('Write some HTML.');
    if (src.length > MAX_BLOCK) throw new Error(`An HTML block may be at most ${MAX_BLOCK} characters.`);
    tokenizeHtml(src);
    return src;
  };
  return dialog('HTML block', body, { check: read, apply: read });
}

const blankSlide = () => ({ image: '', alt: '', title: '', text: '', label: '', url: '', animation: DEFAULT_SLIDE_ANIMATION });

export function editSlideshow(initial = [blankSlide(), blankSlide()], chooseImage) {
  const slides = initial.map((slide) => ({ ...slide }));
  const rows = el('div');
  const body = el('div', {}, el('p', { class: 'hint' }, '2-10 slides. Choose an image from Media, upload a new image from the picker, or enter an asset: reference or https:// image address. New images upload only when you publish or save the draft. Choose effects for the whole slide and its image, heading, caption and link label. Set the whole slide to None to animate only individual elements. Use relative link addresses such as ./products/ for nearby pages. Slides rotate every 6 seconds. Reduced motion disables animation and starts paused. Without JavaScript, every slide stays visible.'), rows);
  const draw = () => {
    rows.replaceChildren(...slides.map((slide, i) => {
      const animation = (key, title, fallback) => el('label', {}, title, el('select', { 'aria-label': `Slide ${i + 1} ${title.toLowerCase()}`, onchange: (e) => { slide[key] = e.target.value; } },
        SLIDE_ANIMATIONS.map((name) => el('option', { value: name, selected: (slide[key] ?? fallback) === name }, name === 'none' ? 'None' : name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()))),
      ));
      const fields = [['image', 'Image', 'asset:images/photo.jpg'], ['alt', 'Alternative text', 'Describe the picture'], ['title', 'Heading', 'Optional'], ['text', 'Caption', 'Optional'], ['label', 'Link label', 'Optional'], ['url', 'Link address', './products/']].map(([key, title, placeholder]) => {
        const input = el('input', { value: slide[key], placeholder, 'aria-label': `Slide ${i + 1} ${title.toLowerCase()}`, oninput: (e) => { slide[key] = e.target.value; } });
        const label = el('label', {}, title, input);
        if (['title', 'text', 'label'].includes(key)) return el('div', {}, label, animation(`${key}Animation`, `${title} animation`, 'none'));
        if (key !== 'image') return label;
        return el('div', {}, label, el('button', { type: 'button', 'aria-label': `Choose image for slide ${i + 1}`, onclick: () => chooseImage((ref) => {
          input.value = ref;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }) }, 'Choose from Media…'), animation('imageAnimation', 'Image animation', 'none'));
      });
      const move = (offset) => {
        [slides[i], slides[i + offset]] = [slides[i + offset], slides[i]];
        draw();
      };
      return el('fieldset', {}, el('legend', {}, `Slide ${i + 1}`), ...fields, animation('animation', 'Animation', DEFAULT_SLIDE_ANIMATION), el('div', { class: 'actions' },
        el('button', { type: 'button', disabled: i === 0, onclick: () => move(-1), 'aria-label': `Move slide ${i + 1} up` }, 'Move up'),
        el('button', { type: 'button', disabled: i === slides.length - 1, onclick: () => move(1), 'aria-label': `Move slide ${i + 1} down` }, 'Move down'),
        el('button', { type: 'button', disabled: slides.length <= 2, onclick: () => { slides.splice(i, 1); draw(); }, 'aria-label': `Remove slide ${i + 1}` }, 'Remove'),
      ));
    }));
    add.disabled = slides.length >= 10;
    body.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const add = el('button', { type: 'button', onclick: () => { slides.push(blankSlide()); draw(); } }, '+ Slide');
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
    quill.insertEmbed(index, kind, v, 'user');
    quill.setSelection(index + 1, 0, 'silent');
  };
  const tableHandler = () => insert('mdtable', () => editTable());
  const htmlHandler = () => insert('htmlblock', () => editHtml());
  const slideshowHandler = () => insert('htmlblock', () => editSlideshow(undefined, chooseImage));
  quill.root.addEventListener('click', async (e) => {
    const button = e.target.closest && e.target.closest('.blk-edit');
    const node = button && button.closest('.ql-mdtable, .ql-htmlblock');
    if (!node) return;
    e.preventDefault();
    const blot = Quill.find(node);
    const index = quill.getIndex(blot);
    const isTable = node.classList.contains('ql-mdtable');
    const src = node.getAttribute('data-htmlblock');
    const slides = !isTable && readSlideshow(src);
    const next = isTable ? await editTable(JSON.parse(node.getAttribute('data-mdtable'))) : slides ? await editSlideshow(slides, chooseImage) : await editHtml(src);
    if (!next) return;
    quill.deleteText(index, 1, 'user');
    quill.insertEmbed(index, isTable ? 'mdtable' : 'htmlblock', next, 'user');
  });
  return { mdtable: tableHandler, htmlblock: htmlHandler, slideshow: slideshowHandler };
}

import { registerBlocks, wireBlocks } from './blocks.js';

// Quill as a *view over markdown*. Only what markdown can express is offered; the
// image blot keeps the logical `asset:` reference in the document and shows a
// resolved URL on screen.
let loading = null;
let resolver = () => '';
let videoResolver = () => 'about:blank';

export function setAssetResolver(fn) {
  resolver = fn;
}

export function setVideoResolver(fn) {
  videoResolver = fn;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(s);
  });
}

export async function loadQuill() {
  if (!loading) {
    loading = loadScript('vendor/quill/quill.js').then(() => {
      const Quill = window.Quill;
      const ImageBlot = Quill.import('formats/image');
      class AssetImage extends ImageBlot {
        static create(value) {
          const node = super.create(value);
          if (typeof value === 'string' && value.startsWith('asset:')) {
            node.setAttribute('data-asset', value);
            node.setAttribute('src', resolver(value));
          }
          return node;
        }

        static value(node) {
          return node.getAttribute('data-asset') || super.value(node);
        }
      }
      Quill.register('formats/image', AssetImage, true);

      // The document keeps `video:<key>/<name>@vN`; the iframe shows the player.
      const VideoBlot = Quill.import('formats/video');
      class ReleaseVideo extends VideoBlot {
        static create(value) {
          const node = super.create(value);
          node.setAttribute('data-video', value);
          node.setAttribute('src', videoResolver(value));
          node.setAttribute('sandbox', 'allow-scripts');
          node.setAttribute('referrerpolicy', 'no-referrer');
          return node;
        }

        static value(node) {
          return node.getAttribute('data-video');
        }
      }
      Quill.register('formats/video', ReleaseVideo, true);
      registerBlocks(Quill);
      // a paragraph style is a class on the line (ql-para-lead), the one block format markdown writes as "{.lead} "
      const { ClassAttributor, Scope } = Quill.import('parchment');
      Quill.register({ 'formats/layout': new ClassAttributor('layout', 'ql-layout', { scope: Scope.INLINE, whitelist: IMAGE_PRESETS.map(([v]) => v).filter(Boolean) }) }, true);
      Quill.register({ 'formats/para': new ClassAttributor('para', 'ql-para', { scope: Scope.BLOCK, whitelist: ['lead', 'small'] }) }, true);
      Quill.import('formats/link').PROTOCOL_WHITELIST.push('asset');
      return Quill;
    });
  }
  return loading;
}

// how a picture sits: the presets lib/delta.js IMAGE_LAYOUTS names, chosen from a small bar that appears on the picture
export const IMAGE_PRESETS = [['', 'Default'], ['inline', 'Inline'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['full', 'Full width'], ['left', 'Float left'], ['right', 'Float right']];

export const FORMATS = ['header', 'para', 'layout', 'bold', 'italic', 'strike', 'code', 'link', 'blockquote', 'code-block', 'list', 'indent', 'image', 'video', 'mdtable', 'htmlblock'];

export async function createEditor(el, { onImage, onVideo }) {
  const Quill = await loadQuill();
  // the table and HTML block buttons need the editor to exist, so their handlers close over it
  const blocks = {};
  const quill = new Quill(el, {
    theme: 'snow',
    formats: FORMATS,
    modules: {
      toolbar: {
        container: [[{ header: [1, 2, 3, 4, false] }, { para: [false, 'lead', 'small'] }], ['bold', 'italic', 'strike', 'code'], ['link'], ['blockquote', 'code-block'], [{ list: 'ordered' }, { list: 'bullet' }, { indent: '-1' }, { indent: '+1' }], ['image', 'video', 'mdtable', 'htmlblock'], ['clean']],
        handlers: { image: onImage, video: onVideo, mdtable: () => blocks.mdtable(), htmlblock: () => blocks.htmlblock() },
      },
    },
  });
  Object.assign(blocks, wireBlocks(quill, Quill));
  // a paragraph style and another block format (heading, list, quote, code) cannot share a line: the one applied last wins
  const OTHER = ['header', 'list', 'blockquote', 'code-block', 'indent'];
  quill.getModule('toolbar').addHandler('para', (v) => {
    const r = quill.getSelection();
    if (!r) return;
    if (v) for (const k of OTHER) quill.formatLine(r.index, r.length, k, false, 'user');
    quill.formatLine(r.index, r.length, 'para', v || false, 'user');
  });
  wireImageBar(quill, Quill);
  quill.on('text-change', (_d, _o, source) => {
    if (source !== 'user') return;
    const r = quill.getSelection();
    if (!r) return;
    for (const line of quill.getLines(r.index, r.length || 1)) {
      const f = line.formats();
      if (f.para && OTHER.some((k) => f[k])) quill.formatLine(quill.getIndex(line), 1, 'para', false, 'api');
    }
  });
  const bar = quill.getModule('toolbar').container;
  for (const [name, title] of [['mdtable', 'Insert a table'], ['htmlblock', 'Insert an HTML block']]) {
    const b = bar.querySelector(`.ql-${name}`);
    if (b) {
      b.title = title;
      b.setAttribute('aria-label', title);
    }
  }
  return quill;
}

// Click a picture and a bar of presets appears over it: Default, Inline, Small, Medium, Large, Full width, Float left, Float right.
function wireImageBar(quill, Quill) {
  const bar = document.createElement('div');
  bar.className = 'img-bar';
  bar.hidden = true;
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Picture size and position');
  quill.container.append(bar);
  let at = -1;
  const hide = () => {
    bar.hidden = true;
    at = -1;
  };
  for (const [value, label] of IMAGE_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.value = value;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      if (at < 0) return;
      quill.formatText(at, 1, 'layout', value || false, 'user');
      hide();
    });
    bar.append(b);
  }
  quill.root.addEventListener('click', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return hide();
    const blot = Quill.find(img);
    if (!blot) return hide();
    at = quill.getIndex(blot);
    const current = quill.getFormat(at, 1).layout || '';
    for (const b of bar.children) b.setAttribute('aria-pressed', String(b.dataset.value === current));
    const host = quill.container.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    bar.style.top = `${Math.max(0, r.top - host.top + quill.container.scrollTop - 38)}px`;
    bar.style.left = `${Math.max(0, r.left - host.left)}px`;
    bar.hidden = false;
  });
  quill.on('text-change', (_d, _o, source) => {
    if (source === 'user' && !bar.hidden) hide();
  });
}

import { dialog, el } from './block-dialog.js';

export function wireCounterWidget(quill, getDeclarations) {
  return async () => {
    const declarations = typeof getDeclarations === 'function' ? getDeclarations() : getDeclarations;
    const names = Object.keys(declarations || {});
    if (!names.length) return;
    const range = quill.getSelection(true) || { index: Math.max(0, quill.getLength() - 1), length: 0 };
    const select = el('select', { 'aria-label': 'Counter' }, names.map((name) => el('option', { value: name }, name)));
    const name = await dialog('Insert counter', el('label', {}, 'Counter ', select), {
      check: () => { if (!names.includes(select.value)) throw new Error('Choose a declared counter.'); },
      apply: () => select.value,
      applyLabel: 'Insert',
    });
    if (!name) {
      quill.setSelection(range.index, range.length, 'silent');
      return;
    }
    quill.deleteText(range.index, range.length, 'user');
    quill.insertEmbed(range.index, 'counter', { name, source: `<span class="wc-count-${name}"></span>` }, 'user');
    quill.setSelection(range.index + 1, 0, 'silent');
  };
}

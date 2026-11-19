import { CODE_LANGUAGES, highlightedCode, supportsCodeLanguage } from '../lib/code-highlight.js';
import { deltaToMarkdownChecked } from '../lib/markdown.js';
import { el, dialog } from './block-dialog.js';
import { highlightedTextarea } from './highlight.js';

function editCode(initial) {
  const known = CODE_LANGUAGES.some(([value]) => value === initial.language);
  const select = el('select', { 'aria-label': 'Code language' },
    CODE_LANGUAGES.map(([value, label]) => el('option', { value }, label)),
    el('option', { value: '__custom__' }, 'Custom language'));
  select.value = known ? initial.language : '__custom__';
  const custom = el('input', { 'aria-label': 'Custom code language', placeholder: 'Language identifier', autocomplete: 'off' });
  custom.value = known ? '' : initial.language;
  const area = el('textarea', { rows: 12, spellcheck: 'false', 'aria-label': 'Code', class: 'mono' });
  area.value = initial.code;
  const hint = el('p', { class: 'hint' });
  const language = () => select.value === '__custom__' ? custom.value : select.value;
  const paint = (pre, source) => {
    pre.innerHTML = highlightedCode(source, language()) + '\n';
  };
  const source = highlightedTextarea(area, area.ownerDocument, paint);
  const refresh = () => {
    custom.hidden = select.value !== '__custom__';
    const lang = language();
    hint.textContent = lang === 'math'
      ? 'The math language is published as a display equation.'
      : lang && !supportsCodeLanguage(lang)
      ? 'This language is saved as written but displayed without highlighting.'
      : 'The code is saved as a fenced Markdown block.';
    area.dispatchEvent(new Event('change'));
  };
  select.addEventListener('change', refresh);
  custom.addEventListener('input', refresh);
  refresh();
  const read = () => {
    const lang = language();
    if (select.value === '__custom__' && !lang) throw new Error('Enter a custom language identifier.');
    if (lang && !/^[^\s`]+$/.test(lang)) throw new Error('Use a single language identifier without spaces or backticks.');
    if (lang === 'plain') throw new Error('Use None for plain text; "plain" is reserved by the editor.');
    const ops = [];
    for (const line of area.value.split('\n')) {
      if (line) ops.push({ insert: line });
      ops.push({ insert: '\n', attributes: { 'code-block': lang || true } });
    }
    deltaToMarkdownChecked({ ops });
    return { ops };
  };
  return dialog('Code block', el('div', {},
    el('label', {}, 'Highlighting language ', select), custom, hint, source),
  { check: read, apply: read });
}

export function wireCodeWidget(quill, Quill) {
  return async () => {
    const range = quill.getSelection(true) || { index: Math.max(0, quill.getLength() - 1), length: 0 };
    const lines = quill.getLines(0, quill.getLength());
    const [current] = quill.getLine(range.index);
    const position = lines.indexOf(current);
    const format = current?.formats()['code-block'];
    let start = quill.getIndex(current);
    let length = 0;
    let code = '';
    const language = format === true ? '' : String(format || '');
    if (format && position >= 0) {
      let first = position, last = position;
      const same = (line) => (line.formats()['code-block'] || false) === format;
      while (first > 0 && same(lines[first - 1])) first--;
      while (last + 1 < lines.length && same(lines[last + 1])) last++;
      start = quill.getIndex(lines[first]);
      length = quill.getIndex(lines[last]) + lines[last].length() - start;
      code = quill.getText(start, length).slice(0, -1);
    }
    const next = await editCode({ code, language });
    if (!next) {
      quill.setSelection(range.index, range.length, 'silent');
      return;
    }
    const Delta = Quill.import('delta');
    let change = new Delta().retain(start).delete(length);
    for (const op of next.ops) change = change.insert(op.insert, op.attributes);
    const history = quill.getModule('history');
    history.cutoff();
    quill.updateContents(change, 'user');
    history.cutoff();
    quill.setSelection(start, 0, 'silent');
  };
}

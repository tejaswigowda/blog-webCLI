// A list of the blog's existing tags under the tags field, narrowing as the author types; Up/Down and Enter or Tab (or a click) complete one.
import { completeTag, suggestTags } from '../lib/tag-suggest.js';

let uid = 0;

// input: the tags <input>; entries(): the blog's index entries (read when needed, so it may fill in after the page is drawn)
export function attachTagSuggest(input, entries) {
  for (const old of document.querySelectorAll('.tag-suggest')) old.remove(); // one editor at a time: the last page's list is gone
  const id = `tag-suggest-${++uid}`;
  const list = document.createElement('ul');
  list.id = id;
  list.className = 'tag-suggest';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  document.body.append(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', id);
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('autocomplete', 'off');
  let items = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const mark = () => {
    [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${id}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const accept = (tag) => {
    input.value = completeTag(input.value, tag);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    show();
  };
  function show() {
    items = suggestTags(entries(), input.value);
    if (!items.length || document.activeElement !== input) return close();
    list.replaceChildren(...items.map((x, i) => {
      const li = document.createElement('li');
      li.id = `${id}-${i}`;
      li.setAttribute('role', 'option');
      li.textContent = x.tag;
      const n = document.createElement('span');
      n.className = 'muted';
      n.textContent = ` ${x.count}`;
      li.append(n);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // the field keeps focus
        accept(x.tag);
      });
      return li;
    }));
    const r = input.getBoundingClientRect();
    Object.assign(list.style, { left: `${r.left + window.scrollX}px`, top: `${r.bottom + window.scrollY + 2}px`, minWidth: `${r.width}px` });
    list.hidden = false;
    active = -1;
    input.setAttribute('aria-expanded', 'true');
    mark();
  }

  input.addEventListener('input', show);
  input.addEventListener('focus', show);
  input.addEventListener('blur', () => setTimeout(close, 100));
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (e.key === 'ArrowDown') active = active + 1 >= items.length ? -1 : active + 1;
      else active = active - 1 < -1 ? items.length - 1 : active - 1;
      mark();
    } else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0) {
      e.preventDefault();
      accept(items[active].tag);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  window.addEventListener('scroll', close, true);
  return { destroy: () => list.remove() };
}

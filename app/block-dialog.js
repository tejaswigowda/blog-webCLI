export const el = (tag, attrs = {}, ...kids) => {
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

export function dialog(title, body, { apply, applyLabel = 'Apply', check }) {
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
    dlg.append(
      el('div', { class: 'blk-dialog-header' },
        el('div', { class: 'blk-dialog-heading' }, el('h2', {}, title), msg),
        el('div', { class: 'actions' }, ok, cancel)),
      el('div', { class: 'blk-dialog-body' }, body),
    );
    document.body.append(dlg);
    refresh();
    dlg.showModal();
  });
}

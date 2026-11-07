// Notices: toasts for results (success, error, info) and an activity indicator for work in progress.
// Nothing here knows about GitHub or blogs. A modal <dialog> makes the rest of the page inert, so the
// notices live inside the dialog while one is open (then they can still be read and dismissed) and in
// the page otherwise.
import { Refusal } from '../lib/errors.js';
import { icon } from './icons.js';

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  e.append(...kids.flat().filter((k) => k != null && k !== false));
  return e;
};

export const MAX_TOASTS = 4;
export const DEFAULT_TIMEOUT = { success: 6000, info: 6000, error: 0 }; // an error stays until dismissed
export const ACTIVITY_DELAY = 150; // work that finishes sooner than this shows no indicator

let layer = null;
let toasts = null;
let activity = null;

function ensure() {
  if (layer) return;
  toasts = el('div', { class: 'toasts' });
  activity = el('div', { class: 'activity', role: 'status', 'aria-live': 'polite' });
  activity.hidden = true;
  layer = el('div', { class: 'notices', 'aria-label': 'Notifications' }, activity, toasts);
  document.body.append(layer);
  const dlg = document.getElementById('dlg');
  if (dlg) {
    const place = () => {
      const host = dlg.open ? dlg : document.body;
      if (layer.parentNode !== host) host.append(layer);
    };
    new MutationObserver(place).observe(dlg, { attributes: true, attributeFilter: ['open'], childList: true });
  }
}

export const spinner = () => el('span', { class: 'spinner', 'aria-hidden': 'true' });

// A line of progress text with a spinner, for inside a view.
export const progressLine = (text) => el('p', { class: 'hint progress' }, spinner(), ' ', text);

export function describeError(e) {
  if (e instanceof Refusal) return { title: `Refused: ${e.code}`, message: e.detail || '' };
  return { title: 'Something went wrong', message: (e && e.message) || String(e) };
}

// toast({ kind, title, message, links: [{ href, text }], action: { label, onClick }, timeout })
export function toast({ kind = 'info', title = '', message = '', links = [], action = null, timeout } = {}) {
  ensure();
  const ms = timeout === undefined ? DEFAULT_TIMEOUT[kind] : timeout;
  const glyph = icon({ success: 'check', error: 'alert-circle', info: 'info' }[kind] || 'info');
  const node = el('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    el('span', { class: 'toast-icon', 'aria-hidden': 'true' }, glyph),
    el('div', { class: 'toast-body' },
      title ? el('div', { class: 'toast-title' }, title) : null,
      message ? el('div', { class: 'toast-message' }, message) : null,
      links.length ? el('div', { class: 'toast-links' }, links.map((l) => el('button', { type: 'button', class: 'link', 'data-href': l.href, onclick: () => window.open(l.href, '_blank', 'noopener') }, l.text))) : null,
      action ? el('div', { class: 'toast-actions' }, el('button', { class: 'primary', type: 'button', onclick: () => { close(); action.onClick(); } }, action.label)) : null),
    el('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', onclick: () => close() }, '×'));
  let timer = null;
  let left = ms;
  let started = 0;
  const arm = () => {
    if (!left) return;
    started = Date.now();
    timer = setTimeout(close, left);
  };
  const pause = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    left -= Date.now() - started;
  };
  function close() {
    clearTimeout(timer);
    timer = null;
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 160);
  }
  node.addEventListener('mouseenter', pause);
  node.addEventListener('focusin', pause);
  node.addEventListener('mouseleave', arm);
  node.addEventListener('focusout', arm);
  toasts.append(node);
  while (toasts.children.length > MAX_TOASTS) toasts.firstElementChild.remove();
  arm();
  return { close, node };
}

// Work in progress: an indicator after a short delay (instant work shows none). Returns end(); end.update(label, { stop }) changes
// what it says while the work goes on (a long job's progress), and gives it a Stop button when it can be stopped.
const running = new Set();
export function busy(label) {
  ensure();
  const job = { label, stop: null, timer: null };
  running.add(job);
  job.timer = setTimeout(draw, ACTIVITY_DELAY);
  function draw() {
    const last = [...running].pop();
    if (!last) return;
    activity.replaceChildren(spinner(), ' ', last.label, running.size > 1 ? ` (+${running.size - 1})` : '', last.stop ? el('button', { type: 'button', class: 'activity-stop', onclick: last.stop }, 'Stop') : null);
    activity.hidden = false;
  }
  const end = () => {
    clearTimeout(job.timer);
    running.delete(job);
    if (!running.size) activity.hidden = true;
    else draw();
  };
  end.update = (text, { stop = job.stop } = {}) => {
    job.label = text;
    job.stop = stop;
    if (!activity.hidden || !job.timer) draw();
  };
  return end;
}

// Run fn with the indicator, and the pressed button marked busy.
// fn is given end.update, to report progress.
export async function working(label, fn, { button = null } = {}) {
  const end = busy(label);
  if (button) {
    button.classList.add('busy');
    button.setAttribute('aria-busy', 'true');
  }
  try {
    return await fn(end.update);
  } finally {
    end();
    if (button) {
      button.classList.remove('busy');
      button.removeAttribute('aria-busy');
    }
  }
}

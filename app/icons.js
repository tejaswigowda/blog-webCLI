// Inline SVG icons, so the page loads no icon font and no third-party file (its CSP allows neither).
// The shapes are from Feather (https://feathericons.com, MIT, © Cole Bemis), drawn on a 24x24 grid.
// Built with createElementNS, never innerHTML.
const NS = 'http://www.w3.org/2000/svg';

const p = (d) => ['path', { d }];
const l = (x1, y1, x2, y2) => ['line', { x1, y1, x2, y2 }];
const pl = (points) => ['polyline', { points }];
const pg = (points) => ['polygon', { points }];
const c = (cx, cy, r) => ['circle', { cx, cy, r }];

export const ICONS = {
  eye: [p('M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'), c(12, 12, 3)],
  user: [p('M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'), c(12, 7, 4)],
  'log-in': [p('M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4'), pl('10 17 15 12 10 7'), l(15, 12, 3, 12)],
  'log-out': [p('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'), pl('16 17 21 12 16 7'), l(21, 12, 9, 12)],
  plus: [l(12, 5, 12, 19), l(5, 12, 19, 12)],
  x: [l(18, 6, 6, 18), l(6, 6, 18, 18)],
  check: [pl('20 6 9 17 4 12')],
  'arrow-left': [l(19, 12, 5, 12), pl('12 19 5 12 12 5')],
  'arrow-right': [l(5, 12, 19, 12), pl('12 5 19 12 12 19')],
  sliders: [l(4, 21, 4, 14), l(4, 10, 4, 3), l(12, 21, 12, 12), l(12, 8, 12, 3), l(20, 21, 20, 16), l(20, 12, 20, 3), l(1, 14, 7, 14), l(9, 8, 15, 8), l(17, 16, 23, 16)],
  'external-link': [p('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'), pl('15 3 21 3 21 9'), l(10, 14, 21, 3)],
  'file-text': [p('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'), pl('14 2 14 8 20 8'), l(16, 13, 8, 13), l(16, 17, 8, 17)],
  save: [p('M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z'), pl('17 21 17 13 7 13 7 21'), pl('7 3 7 8 15 8')],
  send: [l(22, 2, 11, 13), pg('22 2 15 22 11 13 2 9 22 2')],
  upload: [p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), pl('17 8 12 3 7 8'), l(12, 3, 12, 15)],
  trash: [pl('3 6 5 6 21 6'), p('M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'), l(10, 11, 10, 17), l(14, 11, 14, 17)],
  zap: [pg('13 2 3 14 12 14 11 22 21 10 12 10 13 2')],
  edit: [p('M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z')],
  message: [p('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z')],
  droplet: [p('M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z')],
  box: [p('M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z'), pl('3.27 6.96 12 12.01 20.73 6.96'), l(12, 22.08, 12, 12)],
  shield: [p('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z')],
  'git-commit': [c(12, 12, 4), l(1.05, 12, 7, 12), l(17.01, 12, 22.96, 12)],
  film: [['rect', { x: 2, y: 2, width: 20, height: 20, rx: 2.18, ry: 2.18 }], l(7, 2, 7, 22), l(17, 2, 17, 22), l(2, 12, 22, 12), l(2, 7, 7, 7), l(2, 17, 7, 17), l(17, 17, 22, 17), l(17, 7, 22, 7)],
  copy: [['rect', { x: 9, y: 9, width: 13, height: 13, rx: 2, ry: 2 }], p('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1')],
  'alert-circle': [c(12, 12, 10), l(12, 8, 12, 12), l(12, 16, 12.01, 16)],
  info: [c(12, 12, 10), l(12, 16, 12, 12), l(12, 8, 12.01, 8)],
};

// icon('plus') -> <svg class="icon" aria-hidden="true">…</svg>; an unknown name gives nothing
export function icon(name) {
  const shapes = ICONS[name];
  if (!shapes) return null;
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'icon', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.append(shape);
  }
  return svg;
}

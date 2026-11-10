// Migration: lifts the "## Comments (N)" section an earlier import wrote into a post's markdown out into comments/<slug>.json,
// so that comments have one source. Pure: text in, { post, sidecar } out.
import { parseComments, ANONYMOUS } from './comments.js';

const HEAD = /^## Comments \((\d+)\)[ \t]*$/;
const META = /^\*\*(.+?)\*\*(?: · (\d{4}-\d{2}-\d{2}))?(?: — replying to (.+))?$/;
const EMAIL = /[^\s@<>()[\]]+@[^\s@<>()[\]]+/g;

export function liftComments(markdown, { fallbackDate = '1970-01-01' } = {}) {
  const lines = markdown.split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (HEAD.test(lines[i])) { at = i; break; }
  if (at < 0) return null;
  const items = [];
  let cur = null;
  for (const line of lines.slice(at + 1)) {
    const m = META.exec(line);
    if (m && !line.startsWith('>')) {
      cur = { name: m[1], date: m[2] || fallbackDate, to: m[3] || null, paras: [[]] };
      items.push(cur);
    } else if (cur && line.startsWith('>')) {
      const t = line.replace(/^>\s?/, '');
      if (t.trim() === '') cur.paras.push([]);
      else cur.paras[cur.paras.length - 1].push(t);
    } else if (line.trim() !== '') return null; // something else follows: not the section an import wrote
  }
  const notes = [];
  const scrub = (s) => s.replace(EMAIL, () => { notes.push('an email address was removed'); return '[email removed]'; });
  const list = [];
  items.forEach((c, i) => {
    const out = { id: `c${i + 1}`, name: scrub(c.name).slice(0, 60), date: c.date, body: scrub(c.paras.map((p) => p.join(' ')).filter(Boolean).join('\n\n')) };
    if (out.name === ANONYMOUS) delete out.name;
    if (c.to) for (let j = i - 1; j >= 0; j--) if ((items[j].name === c.to)) { out.reply_to = list[j].id; break; }
    list.push(out);
  });
  const text = `${JSON.stringify({ comments: list }, null, 2)}\n`;
  parseComments(text, 'lifted comments'); // refuse here rather than write a file the build would refuse
  const post = `${lines.slice(0, at).join('\n').replace(/\s+$/, '')}\n`;
  return { post, sidecar: text, count: list.length, notes: [...new Set(notes)] };
}

// Old listing addresses. A WordPress site has /category/foo/, /tag/foo/, /author/ada/, /2019/03/ and /2019/, all with inbound links.
// blog.json says which bases the old site used:
//   "archiveAliases": { "tags": ["tag", "category"], "authors": ["author"], "dates": true }
// and the generator writes one small page per tag, per author, per year and per month with posts, each sending the reader (and a
// crawler, by canonical and noindex) to the page that replaced it. An old address that is also the address of a post or page is
// refused, naming both: a stub must never replace content.
import { Refusal } from './errors.js';
import { AUTHORS_DIR, ARCHIVE_DIR, TAGS_DIR } from './site-model.js';
import { SPLIT_OVER } from './listings.js';
import { byYear, groupAuthors } from './taxonomy.js';
import { ROOT_NAMES } from './aliases.js';

const SEGMENT = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const bad = (detail) => new Refusal('bad-alias', `archiveAliases: ${detail}`);

export function validateArchiveAliases(b) {
  const a = b.archiveAliases;
  if (a === undefined) return;
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw bad('must be an object like {"tags": ["tag"], "authors": ["author"], "dates": true}');
  for (const k of Object.keys(a)) if (!['tags', 'authors', 'dates'].includes(k)) throw bad(`"${k}" is not a field (tags, authors, dates)`);
  for (const k of ['tags', 'authors']) {
    if (a[k] === undefined) continue;
    if (!Array.isArray(a[k]) || a[k].length > 4 || !a[k].every((s) => typeof s === 'string' && SEGMENT.test(s))) throw bad(`"${k}" must be up to four plain words, like ["tag", "category"]`);
    for (const s of a[k]) if (ROOT_NAMES.has(s)) throw bad(`"${s}" is a folder the generator or the host owns`);
  }
  if (a.dates !== undefined && typeof a.dates !== 'boolean') throw bad('"dates" must be true or false');
}

// entries: published posts ({ date, author }); site: the site model. -> [{ from, to, title }]
export function archiveStubs({ blog, entries, site }) {
  const cfg = blog.archiveAliases;
  if (!cfg) return [];
  const out = [];
  for (const base of cfg.tags || []) for (const t of site.tags) out.push({ from: `${base}/${t.slug}`, to: `${TAGS_DIR}/${t.slug}`, title: `Tag: ${t.label}` });
  if (site.authors) for (const base of cfg.authors || []) for (const a of groupAuthors(entries)) out.push({ from: `${base}/${a.slug}`, to: `${AUTHORS_DIR}/${a.slug}`, title: `Author: ${[...a.labels][0] || a.slug}` });
  if (cfg.dates && entries.length) {
    const split = entries.length > SPLIT_OVER;
    for (const y of byYear(entries)) {
      const to = split ? `${ARCHIVE_DIR}/${y.year}` : ARCHIVE_DIR;
      out.push({ from: y.year, to, title: `Archive: ${y.year}` });
      for (const m of [...new Set(y.entries.map((e) => e.date.slice(5, 7)))].sort()) out.push({ from: `${y.year}/${m}`, to, title: `Archive: ${y.year}-${m}` });
    }
  }
  return out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

// the stubs that can be written, and a refusal for each that would replace a post or page (or another stub), naming both
export function checkArchiveStubs(stubs, { owners, taken }) {
  const errors = [];
  const records = [];
  const claimed = new Map(taken);
  for (const s of stubs) {
    const parts = s.from.split('/');
    const hit = parts.map((_, i) => parts.slice(0, i + 1).join('/')).find((p) => owners.has(p));
    if (owners.has(s.from)) errors.push(new Refusal('alias-collision', `the old archive address ${s.from}/ is the address of ${owners.get(s.from)}`, owners.get(s.from)));
    else if (hit) errors.push(new Refusal('alias-collision', `the old archive address ${s.from}/ is below ${hit}/, the address of ${owners.get(hit)}`, owners.get(hit)));
    else if (claimed.has(s.from)) errors.push(new Refusal('alias-collision', `the old archive address ${s.from}/ is claimed by both ${claimed.get(s.from)} and ${s.title}`, claimed.get(s.from)));
    else {
      claimed.set(s.from, s.title);
      records.push(s);
    }
  }
  return { records, errors };
}

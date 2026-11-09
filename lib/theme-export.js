// A blog's theme as one JSON file: the pinned theme (by address and hash) and the whole `customize` block (colours, fonts, width, size,
// custom CSS, list layout, header, footer, top bar), so the look can be carried to another blog. Importing re-verifies the pin against the
// theme repository, judges the customize block by the same closed grammar as a blog's own, and drops what belongs to the blog it came
// from: the logo and link icons are pictures in that blog's images repository, so they are not exported and the receiving blog keeps its own.
import { Refusal } from './errors.js';
import { validateCustomize } from './customize.js';
import { validatePin } from './pin.js';

export const THEME_FILE_FORMAT = 'blog-webcli-theme';
export const THEME_FILE_VERSION = 1;
export const THEME_FILE_MAX = 200_000;
const bad = (m) => new Refusal('bad-blog-json', `theme file: ${m}`);

const noPictures = (customize) => {
  const c = structuredClone(customize || {});
  if (c.header) delete c.header.logo;
  for (const k of ['topbar', 'header', 'footer']) if (c[k] && Array.isArray(c[k].links)) c[k].links = c[k].links.map(({ icon, ...l }) => l);
  for (const k of ['topbar', 'header', 'footer']) if (c[k] && !Object.keys(c[k]).length) delete c[k];
  return Object.keys(c).length ? c : null;
};

// blog -> the object to write as JSON
export function exportTheme(blog, { from = null, now = new Date() } = {}) {
  const t = blog.theme;
  const theme = t && typeof t === 'object' ? { repo: t.repo, ref: t.ref, sha256: t.sha256, name: t.name, version: t.version, licence: t.licence, contract: t.contract, ...(t.base ? { base: t.base } : {}) } : typeof t === 'string' ? t : null;
  return {
    format: THEME_FILE_FORMAT,
    version: THEME_FILE_VERSION,
    exported: now.toISOString().slice(0, 10),
    ...(from ? { from } : {}),
    theme,
    ...(blog.stylesheet === 'linked' ? { stylesheet: 'linked' } : {}),
    customize: noPictures(blog.customize),
    note: 'A blog.webcli.app theme: the pinned theme and the blog\'s customization. Import it with Settings, Import theme from JSON. The logo and link icons are not included.',
  };
}

// text -> { theme, stylesheet, customize } or a Refusal. The theme pin is checked for shape here; its hash is checked against the repository by the caller.
export function parseThemeFile(text) {
  if (typeof text !== 'string' || text.length > THEME_FILE_MAX) throw bad(`it is over ${THEME_FILE_MAX / 1000} KB`);
  let f;
  try { f = JSON.parse(text); } catch { throw bad('it is not JSON'); }
  if (!f || typeof f !== 'object' || Array.isArray(f) || f.format !== THEME_FILE_FORMAT) throw bad(`it is not a ${THEME_FILE_FORMAT} file (format "${f && f.format}")`);
  if (f.version !== THEME_FILE_VERSION) throw bad(`it is version ${JSON.stringify(f.version)}; this app reads version ${THEME_FILE_VERSION}`);
  for (const k of Object.keys(f)) if (!['format', 'version', 'exported', 'from', 'theme', 'stylesheet', 'customize', 'note'].includes(k)) throw bad(`"${k}" is not a field`);
  let theme = null;
  if (f.theme && typeof f.theme === 'object') {
    for (const k of Object.keys(f.theme)) if (!['repo', 'ref', 'sha256', 'name', 'version', 'licence', 'contract', 'base'].includes(k)) throw bad(`theme.${k} is not a field`);
    validatePin(f.theme, 'theme file: theme');
    theme = f.theme;
  } else if (f.theme !== null && f.theme !== undefined && typeof f.theme !== 'string') throw bad('"theme" must be a pin, a built-in theme name or null');
  else if (typeof f.theme === 'string') theme = f.theme;
  if (f.stylesheet !== undefined && f.stylesheet !== 'linked') throw bad('"stylesheet" can only be "linked"');
  let customize = null;
  if (f.customize !== null && f.customize !== undefined) {
    customize = noPictures(f.customize);
    if (customize) validateCustomize(customize);
  }
  return { theme, stylesheet: f.stylesheet === 'linked' ? 'linked' : undefined, customize };
}

// The blog with the file's look applied. `pin` is the verified pin (or the file's built-in name, or null for the default theme).
// The receiving blog keeps its own logo and everything that is not the look.
export function applyThemeFile(blog, file, pin) {
  const out = structuredClone(blog);
  if (pin && (typeof pin === 'object' || typeof pin === 'string')) out.theme = pin;
  else delete out.theme;
  if (file.stylesheet === 'linked') out.stylesheet = 'linked';
  const logo = blog.customize && blog.customize.header && blog.customize.header.logo;
  const c = structuredClone(file.customize || {});
  if (logo) c.header = { ...(c.header || {}), logo };
  if (Object.keys(c).length) out.customize = c;
  else delete out.customize;
  return out;
}

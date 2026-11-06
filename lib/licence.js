// Licence discipline. A theme or extension with no declared licence is refused, not warned
// about: an unlicensed repository is not usable, and pretending otherwise hands the problem to
// whoever publishes. Licences are SPDX identifiers or expressions.
import { Refusal } from './errors.js';

const SPDX = /^[A-Za-z0-9][A-Za-z0-9.+-]*(?: (?:AND|OR|WITH) [A-Za-z0-9][A-Za-z0-9.+-]*)*$/;
const NOT_A_LICENCE = /^(none|unlicensed|unlicenced|unknown|proprietary|commercial|todo|tbd|n\/a|all rights reserved|custom|see license|see licence)$/i;

export const GPL_FAMILY = ['GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later'];

export function checkLicence(value, what) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw new Refusal('no-licence', `${what} declares no licence. An unlicensed repository is not usable; ask its author to add one.`);
  if (NOT_A_LICENCE.test(v) || !SPDX.test(v)) throw new Refusal('bad-licence', `${what} declares "${v}", which is not a usable licence. Use an SPDX identifier such as MIT or GPL-2.0-or-later.`);
  return v;
}

// A WordPress-directory theme must be GPL-compatible *including assets*; we only take the GPL family.
export const isGplFamily = (spdx) => GPL_FAMILY.includes(spdx);

// Language that marks split licensing: GPL code with assets under something else. Heuristic and
// deliberately conservative: a hit is a refusal, never an adjudication. Compatible third-party
// credits (MIT, CC0, OFL fonts) do not match.
const SPLIT = [
  /split[- ]licen[cs]/i,
  /\b(envato|themeforest|codecanyon)\b/i,
  /\b(regular|extended|standard) licen[cs]e\b/i,
  /\bproprietary\b/i,
  /\bcommercial (licen[cs]e|use only|theme)\b/i,
  /\bnon-?gpl\b/i,
  /\bnot (covered|licensed|released|distributed) (by|under) (the )?(gnu )?(gpl|general public)/i,
  /\b(css|javascript|js|images?|fonts?|icons?|assets?|graphics?)\b[^.\n]{0,60}\b(licen[cs]ed|released|distributed) (separately|under (a )?(separate|different|commercial|proprietary))/i,
  /\bseparate(ly)? licen[cs]/i,
  /\ball rights reserved\b[^.\n]{0,40}\b(images?|fonts?|css|assets?|graphics?|icons?)\b/i,
];

export function splitLicensingLanguage(text) {
  for (const re of SPLIT) {
    const m = re.exec(text || '');
    if (m) return m[0];
  }
  return null;
}

// "GNU General Public License v2 or later", "GPLv2+", "GPL-2.0-or-later" -> SPDX, else null.
export function normaliseGpl(header) {
  const h = String(header || '').trim();
  if (GPL_FAMILY.includes(h)) return h;
  const m = /(?:gnu general public licen[cs]e|\bgpl)\s*[-,]?\s*(?:v(?:ersion)?\s*)?(\d)(?:\.0)?(\s*(?:\+|or later|or any later version|-or-later)|\s*(?:only|-only))?/i.exec(h);
  if (!m || !['2', '3'].includes(m[1])) return null;
  const later = /\+|or later|or any later|-or-later/i.test(m[2] || '');
  return `GPL-${m[1]}.0-${later ? 'or-later' : 'only'}`;
}

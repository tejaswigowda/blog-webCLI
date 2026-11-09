// Where a theme came from, and whether it may be redistributed. Three origins:
//   imported  : taken from a directory (the importer's safety and licence rules already applied)
//   authored  : written by a person
//   generated : written by an agent against the markup contract, from a reference (a page or an image)
// A generated theme says what it looked at, how it relates to it, who wrote it and when. `inspired-by` means original CSS written after
// looking (what a designer does). `derived-from` means declarations were lifted; that is a derivative work, so it is refused unless the
// source's licence permits it. Both are *declarations*: nothing here can verify them (lib/overlap.js gives a warning, not a verdict).
// Every asset of an authored or generated theme carries its own declared licence, so a font or a picture cannot ride in under the theme's.
import { checkLicence, isGplFamily } from './licence.js';
import { Refusal } from './errors.js';

export const ORIGINS = ['authored', 'imported', 'generated'];
export const RELATIONS = ['inspired-by', 'derived-from'];
export const PROVENANCE_KEYS = ['origin', 'reference', 'relation', 'agent', 'generated', 'source_licence', 'asset_licences'];

// Licences under which another's declarations may be reused, with the notice they require kept (hence the attribution below).
const PERMITS = new Set(['MIT', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'CC0-1.0', 'Unlicense', 'CC-BY-4.0', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later']);
export function permitsReuse(spdx) {
  const orTerms = String(spdx).split(/ OR /).map((t) => t.trim());
  return orTerms.some((t) => t.split(/ AND /).every((x) => PERMITS.has(x.replace(/ WITH .*/, '').trim())));
}

// a licence that forbids what a published theme does with its files (copy them, to anyone, for any use)
const NO_REDISTRIBUTION = /(^|-)(NC|ND)(-|$)|\b(proprietary|reserved|unlicensed)\b/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const refuseAs = (rule, reason, fix) => ({ rule, where: 'theme.json', reason, fix });

// Every problem in a manifest's provenance, as { rule, where, reason, fix }.
export function provenanceFindings(m) {
  const out = [];
  const add = (rule, reason, fix) => out.push(refuseAs(rule, reason, fix));
  // A theme from before this field has no origin and is left as it was (its pinned copies must keep verifying); new tools and the registry
  // ask for one. Only a theme that says it is authored or generated is held to a licence for each of its files.
  const origin = m.origin;
  if (m.origin !== undefined && !ORIGINS.includes(m.origin)) add('prov-origin', `"origin" must be one of ${ORIGINS.join(', ')}`, 'set "origin" to authored, imported or generated');
  if (m.origin === 'imported' && !m.source) add('prov-imported-source', 'an imported theme names where it was imported from ("source")', 'add "source": the https address of the listing');
  if (origin === 'generated') {
    if (!(typeof m.reference === 'string' && /^https:\/\/[^\s]+$/.test(m.reference) && m.reference.length <= 300)) add('prov-reference', 'a generated theme records what it looked at: "reference" must be an https address', 'add "reference": "https://…"');
    if (!RELATIONS.includes(m.relation)) add('prov-relation', `"relation" must be one of ${RELATIONS.join(', ')}`, 'say whether the CSS is inspired-by the reference (original) or derived-from it (declarations lifted)');
    if (!(typeof m.agent === 'string' && m.agent.trim() && m.agent.length <= 100)) add('prov-agent', 'a generated theme records which agent wrote it ("agent": model and version)', 'add "agent"');
    if (!(typeof m.generated === 'string' && validDate(m.generated))) add('prov-generated', '"generated" must be a date, YYYY-MM-DD', 'add "generated"');
  } else if (origin !== undefined) {
    for (const k of ['reference', 'relation', 'agent', 'generated']) if (m[k] !== undefined) add('prov-field-unexpected', `"${k}" belongs to a generated theme (origin "generated")`, `remove "${k}" or set "origin": "generated"`);
  }
  if (m.relation === 'derived-from') {
    let ok = false;
    try { ok = typeof m.source_licence === 'string' && !!checkLicence(m.source_licence, 'the source') && permitsReuse(m.source_licence); } catch { /* reported below */ }
    if (!ok) add('prov-source-licence', `"derived-from" needs "source_licence": the licence the reference carries, and one that permits reuse of its declarations (${[...PERMITS].join(', ')}); ${m.source_licence ? `"${m.source_licence}" does not` : 'none is declared'}`, 'rewrite the CSS as inspired-by (original), or derive only from a source whose licence permits it');
    else {
      if (!(typeof m.attribution === 'string' && m.attribution.trim())) add('prov-attribution', 'a derived theme keeps the source\'s notice: "attribution" is required', 'add "attribution": the source\'s copyright line and licence');
      if (/^GPL/.test(m.source_licence) && !isGplFamily(m.licence)) add('prov-licence-compat', `derived from a ${m.source_licence} source, the theme must be GPL-family (it is "${m.licence}")`, 'license the theme under the same GPL family');
    }
  } else if (m.source_licence !== undefined) add('prov-field-unexpected', '"source_licence" belongs to a "derived-from" theme', 'remove it');
  // assets
  const assets = Array.isArray(m.assets) ? m.assets : [];
  const al = m.asset_licences;
  if (al !== undefined && (!al || typeof al !== 'object' || Array.isArray(al))) add('asset-licence-shape', '"asset_licences" must be an object of path: licence', 'use { "fonts/a.woff2": "OFL-1.1" }');
  else if (origin === 'authored' || origin === 'generated') {
    for (const p of assets) {
      const v = al && al[p];
      if (v === undefined) { add('asset-no-licence', `asset "${p}" declares no licence; a theme that is authored or generated declares one for every file it ships`, `add "${p}": an SPDX licence (or LicenseRef-… for a custom grant) to "asset_licences", or remove the file`); continue; }
      try { checkLicence(v, `asset "${p}"`); } catch (e) { add('asset-bad-licence', e.detail, 'use an SPDX identifier that permits redistribution'); continue; }
      if (NO_REDISTRIBUTION.test(v)) add('asset-bad-licence', `asset "${p}" is licensed "${v}", which does not permit redistributing it in a theme (non-commercial, no-derivatives or reserved)`, 'use a file whose licence allows redistribution and modification, or remove it');
    }
  }
  if (al && typeof al === 'object' && !Array.isArray(al)) for (const p of Object.keys(al)) if (!assets.includes(p)) add('asset-licence-orphan', `asset_licences names "${p}", which is not listed under "assets"`, 'remove it or list the file under "assets"');
  return out;
}

// The first problem as a refusal (what validateThemeManifest throws).
export function checkProvenance(m) {
  const f = provenanceFindings(m);
  if (f.length) throw new Refusal('bad-theme', `theme.json: ${f[0].reason}`, undefined, f[0].rule);
}

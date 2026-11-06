// Extensions are repositories. They are code, so they are fenced hard:
//   * they run at PUBLISH, never at read, in a sandbox (app/sandbox.js): no DOM, no network, no credentials;
//   * what they return is DATA, committed as extension-outputs.json and then regenerated from
//     that file alone. The generator, the CLI and CI never execute extension code;
//   * their HTML is rebuilt from an allow-list (lib/sanitize.js) before it reaches a page.
import { Refusal } from './errors.js';
import { checkLicence } from './licence.js';
import { sha256 } from './sha256.js';
import { filesDigest, validatePin } from './pin.js';
import { sanitizeHtml } from './sanitize.js';

export const HOOKS = ['post:markdown', 'post:html', 'index:html'];
export const KINDS = ['build', 'embed'];
export const MAX_OUTPUT = 1_000_000;

const bad = (m) => new Refusal('bad-extension', m);
const KEYS = ['name', 'version', 'licence', 'kind', 'hooks', 'capabilities', 'pinned_assets', 'entry', 'description', 'source', 'attribution'];
const SEG = '[A-Za-z0-9_][A-Za-z0-9_.-]*';
const REL = new RegExp(`^${SEG}(?:/${SEG})*\\.(?:mjs|js)$`);
const dec = new TextDecoder('utf-8', { fatal: true });
const text = (v) => (typeof v === 'string' ? v : dec.decode(v));

// An address that names one immutable thing: @<tag or sha>/ (jsDelivr style) or /<40-hex>/ in the path.
export const isPinnedUrl = (u) => /^https:\/\/[^\s]+$/.test(u) && (/@(?:[0-9a-f]{40}|v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)(?:[/?#]|$)/.test(u) || /\/[0-9a-f]{40}\//.test(u));

export function validateExtensionManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad('extension.json must be an object');
  for (const k of Object.keys(m)) if (!KEYS.includes(k)) throw bad(`extension.json: "${k}" is not a field (${KEYS.join(', ')})`);
  for (const k of ['name', 'version']) if (typeof m[k] !== 'string' || !m[k].trim() || m[k].length > 80) throw bad(`extension.json: "${k}" is required`);
  checkLicence(m.licence, `extension "${m.name}"`);
  if (!KINDS.includes(m.kind)) throw bad(`extension.json: kind must be one of ${KINDS.join(', ')}`);
  if (!Array.isArray(m.hooks) || !m.hooks.length || !m.hooks.every((h) => HOOKS.includes(h))) throw bad(`extension.json: hooks must be a non-empty list from ${HOOKS.join(', ')}`);
  if (m.capabilities !== undefined && !(Array.isArray(m.capabilities) && m.capabilities.length === 0)) throw bad('extension.json: capabilities must be empty; no capability is defined, so none can be granted');
  if (m.entry !== undefined && !(typeof m.entry === 'string' && REL.test(m.entry))) throw bad('extension.json: entry must be a relative .mjs or .js path');
  const assets = m.pinned_assets;
  if (assets !== undefined) {
    if (!Array.isArray(assets) || assets.length > 16) throw bad('extension.json: pinned_assets must be a list of at most 16');
    if (m.kind !== 'embed' && assets.length) throw bad('extension.json: only an embed may declare pinned_assets');
    for (const a of assets) {
      if (!a || typeof a.url !== 'string' || !isPinnedUrl(a.url)) throw bad(`extension.json: pinned_assets url "${a && a.url}" must be https and name a tag or commit (…@v1.0.0/… or …@<sha>/…), never a branch`);
      if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) throw bad(`extension.json: pinned_assets "${a.url}" needs a sha256`);
    }
  }
  if (m.kind === 'embed' && !(assets && assets.length)) throw bad('extension.json: an embed must declare the pinned_assets it may frame');
  return m;
}

export const extensionEntry = (m) => m.entry || 'index.mjs';
export const extensionFilePaths = (m) => ['extension.json', extensionEntry(m)].sort();

// files: { path: string | bytes } read at the pinned ref. Verified, never executed here.
export function loadExtension(pin, files) {
  validatePin(pin, 'extension');
  if (!('extension.json' in files)) throw bad(`${pin.repo}@${pin.ref} has no extension.json`);
  let manifest;
  try {
    manifest = JSON.parse(text(files['extension.json']));
  } catch (e) {
    throw bad(`extension.json is not valid JSON (${e.message})`);
  }
  validateExtensionManifest(manifest);
  const digest = filesDigest(files, extensionFilePaths(manifest), bad);
  if (digest !== pin.sha256) throw new Refusal('pin-mismatch', `${pin.repo}@${pin.ref} hashes to ${digest}, but blog.json pins ${pin.sha256}. The extension changed after it was pinned; review it and pin it again, or revert.`);
  for (const k of ['licence', 'name', 'version', 'kind']) {
    if (pin[k] !== undefined && pin[k] !== manifest[k]) throw new Refusal('pin-mismatch', `blog.json records ${k} "${pin[k]}" for this extension but extension.json says "${manifest[k]}"`);
  }
  if (pin.hooks !== undefined && JSON.stringify(pin.hooks) !== JSON.stringify(manifest.hooks)) throw new Refusal('pin-mismatch', 'blog.json records different hooks than extension.json declares');
  return { pin, manifest, digest, source: text(files[extensionEntry(manifest)]) };
}

export function pinForExtension(repo, ref, manifest, digest) {
  return { repo, ref, sha256: digest, name: manifest.name, version: manifest.version, licence: manifest.licence, kind: manifest.kind, hooks: manifest.hooks };
}

// ---------- the hook pipeline (pure) ----------

export const extensionKey = (digest, hook, ctx, input) => sha256(`${digest}\n${hook}\n${JSON.stringify(ctx)}\n${input}`);

// outputs: the parsed `outputs` map of extension-outputs.json. Misses are collected, not run.
export function makeHooks({ extensions = [], outputs = {} }) {
  const used = {};
  const missing = [];
  return {
    used,
    missing,
    apply(hook, input, ctx = {}) {
      let value = input;
      for (const [index, ext] of extensions.entries()) {
        if (!ext.manifest.hooks.includes(hook)) continue;
        const key = extensionKey(ext.digest, hook, ctx, value);
        const hit = outputs[key];
        if (!hit) {
          // Later extensions would be asked about this output, which does not exist yet: stop here.
          missing.push({ index, key, hook, ctx, input: value, extension: `${ext.pin.repo}@${ext.pin.ref}` });
          break;
        }
        if (typeof hit.output !== 'string' || hit.output.length > MAX_OUTPUT) throw new Refusal('extension-failed', `${ext.manifest.name}: its recorded output for ${hook} is not text under ${MAX_OUTPUT} characters`);
        used[key] = { extension: `${ext.pin.repo}@${ext.pin.ref}`, hook, output: hit.output };
        value = hit.output;
        if (hook !== 'post:markdown') {
          const iframes = new Set(ext.manifest.kind === 'embed' ? (ext.manifest.pinned_assets || []).map((a) => a.url) : []);
          try {
            value = sanitizeHtml(value, { iframes });
          } catch (e) {
            throw e instanceof Refusal ? new Refusal(e.code, `${ext.manifest.name} (${hook}): ${e.detail}`) : e;
          }
        }
      }
      return value;
    },
  };
}

export const outputsFile = (used) => {
  const sorted = Object.fromEntries(Object.entries(used).sort(([a], [b]) => (a < b ? -1 : 1)));
  return JSON.stringify({ version: 1, outputs: sorted }, null, 2) + '\n';
};

export const parseOutputsFile = (textOrNull) => {
  if (!textOrNull) return {};
  const o = JSON.parse(textOrNull);
  return o && o.version === 1 && o.outputs && typeof o.outputs === 'object' ? o.outputs : {};
};

// A repository reference with an optional folder: `owner/name` or `owner/name/some/folder`.
// The blog itself, and every asset and video repo, may share one repository by each
// taking a folder of it.
const SEG = '[\\w.-]+';
const RE = new RegExp(`^(${SEG})/(${SEG})((?:/${SEG})*)$`);

const DOTS = new Set(['.', '..', '.git']);

export function parseRepoRef(s) {
  const m = RE.exec((s || '').trim());
  const folder = m ? m[3].replace(/^\//, '') : '';
  const parts = m ? [m[1], m[2], ...(folder ? folder.split('/') : [])] : [];
  if (!m || parts.some((p) => DOTS.has(p))) throw new Error('Enter a repository as owner/name, or owner/name/folder.');
  return { repo: `${m[1]}/${m[2]}`, folder, ref: folder ? `${m[1]}/${m[2]}/${folder}` : `${m[1]}/${m[2]}` };
}

export const isRepoRef = (s) => {
  try {
    parseRepoRef(s);
    return true;
  } catch {
    return false;
  }
};

// Join a folder and a path without doubling or leading slashes.
export const at = (folder, path) => (folder ? `${folder}/${path}` : path);

// Do two references name the same place?
export const sameSpot = (a, b) => {
  const x = parseRepoRef(a);
  const y = parseRepoRef(b);
  return x.repo === y.repo && x.folder === y.folder;
};

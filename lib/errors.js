// Every refusal has a stable code. Callers refuse rather than guess.
export const CODES = Object.freeze({
  'no-blog-json': 'The repository has no blog.json.',
  'bad-blog-json': 'blog.json is present but invalid.',
  'missing-frontmatter': 'A post lacks frontmatter or a required field.',
  'bad-frontmatter': 'Frontmatter has an invalid value.',
  'slug-mismatch': 'The slug in frontmatter does not match the file name.',
  'slug-collision': 'Two posts, or a post and a reserved path, share a slug.',
  'unresolved-asset': 'An asset reference has no pinned file behind it.',
  'provider-url': 'A post names an asset provider instead of an asset: reference.',
  'unsafe-url': 'A link or image uses a URL scheme that is not allowed.',
  'lossy-round-trip': 'Content cannot be expressed in markdown without loss.',
  'draft-in-publish': 'Attempted to generate output for a draft.',
  'classic-token': 'Classic tokens grant write to every repository; use a fine-grained token.',
});

export class Refusal extends Error {
  constructor(code, detail, where) {
    if (!(code in CODES)) throw new Error(`Unknown refusal code: ${code}`);
    super(`${code}${where ? ` (${where})` : ''}: ${detail || CODES[code]}`);
    this.name = 'Refusal';
    this.code = code;
    this.detail = detail || CODES[code];
    this.where = where || null;
  }

  // Attach the file a refusal came from, once.
  at(where) {
    if (!this.where) {
      this.where = where;
      this.message = `${this.code} (${where}): ${this.detail}`;
    }
    return this;
  }
}

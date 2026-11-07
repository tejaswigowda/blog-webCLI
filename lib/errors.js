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
  'unpinned-ref': 'A theme or extension must be pinned to a tag or a commit, never a branch.',
  'missing-source': 'A file the repository lists could not be read.',
  'bad-alias': 'An alias (an old address a page used to have) is not a plain path.',
  'alias-collision': 'An alias would write over an address the generator, the repository or another page owns.',
  'bad-html': 'An HTML block uses a tag, attribute or address that is not allowed, or is not balanced.',
  'registry-mismatch': 'The registry says this theme or extension has a different sha256 or licence than the repository actually has.',
  'pin-mismatch': 'What was fetched does not match the sha256 the blog pinned.',
  'bad-theme': 'A theme is missing, invalid, or contains something that is not allowed.',
  'bad-extension': 'An extension is missing, invalid, or asks for something that is not allowed.',
  'no-licence': 'A theme or extension declares no licence.',
  'bad-licence': 'A theme or extension declares a licence that cannot be used here.',
  'not-in-directory': 'WordPress themes are ingested only from the wordpress.org directory.',
  'extension-output-missing': 'An extension has not run for this content; publish from the editor to run it.',
  'extension-failed': 'An extension failed, timed out, or broke its limits.',
  'bad-release': 'A video release is missing master.m3u8, holds something a release may not, or is too large.',
  'unsafe-extension-output': 'An extension returned something that is not allowed in a page.',
  'unknown-slug-in-order': 'order.json names a slug that has no post.',
  'duplicate-slug-in-order': 'order.json names the same slug twice.',
  'missing-order-field': 'A post lacks the frontmatter field the blog is ordered by.',
  'mixed-order-field-types': 'The ordering field holds both numbers and text.',
  'bad-order-field': 'The ordering field holds something that cannot be sorted (a list).',
  'bad-order-list': 'order.json is missing, or is not {"order": [slugs]}.',
  'bad-wp-export': 'The file is not a WordPress export (Tools → Export → All content).',
  'bad-wp-site': 'The address does not answer as a WordPress site with a public REST API.',
  'import-refused': 'The WordPress import cannot be written as asked.',
  cancelled: 'Stopped before it finished.',
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

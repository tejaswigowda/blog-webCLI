# blog-registry

The list of themes and extensions that blog.webcli.app offers. Two static files:

- `themes.json`
- `extensions.json`

**Adding one is a pull request against a JSON file.** There is no app release and no app review. The list is *data*: it
is a convenience, never authority.

- A theme or extension **works by its address** (`owner/repo[/folder]@tag`) whether or not it is listed here.
- A listed theme is still **pinned by the app** to the ref and the sha256 it computes from the repository, not to what this file says.
  If an entry gives a `sha256` or a `licence` that does not match what the app finds, the app refuses it.
- An entry is read as exactly `{ name, repo, ref, licence, blurb, screenshot?, sha256? }`. Nothing else in the file reaches the app,
  a screenshot is an https address, and everything is shown as plain text.

```json
{
  "name": "Essay",
  "repo": "me/blog-themes/essay",
  "ref": "v1.0.0",
  "licence": "MIT",
  "blurb": "Long-form reading: a serif face and a narrow measure.",
  "screenshot": "https://example.com/essay.png",
  "sha256": "optional, 64 lowercase hex digits"
}
```

Run `node validate.mjs` before you open the pull request (CI runs it too).

**Run your own.** Fork this repository and change `registry` in the app's `app/config.js` to your copy's raw address
(`https://raw.githubusercontent.com/you/blog-registry/main/`), or serve the two files from anywhere.

The files are data under [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/); `registry.js` is MIT (it is blog-webCLI's `lib/registry.js`, copied by `node cli/registry.js scaffold`).

# Theming rules: measure, never extract

Two acts look alike and are not.

| | **Measuring** | **Extracting** |
|---|---|---|
| what it does | reads computed values off a *rendered* page: the colours a reader sees, the nearest of five type stacks, the width of the text, whether posts are cards | lifts declarations from a stylesheet, or downloads font files |
| what it produces | *facts about that page*, as a `customize` block | a *derivative work* |
| where it may be pointed | **any** site, politely | **directory-only**: wordpress.org themes, where GPL compatibility, *including assets*, is a listing requirement |
| the code | `lib/measure.js`, `cli/measure.mjs` | `cli/wp-import.js` (maintainer-only) |

**The rule, as a rule and not a current fact:** nothing in the measuring path reads a stylesheet, a font file or the text of a page, and nothing it writes can hold CSS. If a request is "just copy their CSS", the answer is already here: that is extraction, it is a different act with a different licence story, and it stays directory-only. A theme that needs CSS is written against the markup contract *from the measured values*, never from the reference's stylesheet (`cli/theme-check.mjs`, with its provenance and overlap checks).

## Why the output cannot be a copy

`customize` is a closed grammar validated against a closed set: colours (accent, text, background, muted), one of five font stacks, a width, a size, a list layout, and links. The measuring path writes only the *enumerable* fields (`colors`, `font`, `headingFont`, `width`, `fontSize`, `list`). It never writes `css`, which takes 16,000 characters of anything and is the one field a copy could hide in, nor the links, logos or text, which are content.

- `assertMeasured` refuses any other field, and `css` by name; the Theme screen's "paste a measured look" accepts nothing but that;
- a theme's `kit.customize` is a measurement too, and carries no `css`;
- tests (`test/measure.test.js`) fail if the measuring files mention `styleSheets`, `cssRules`, `cssText`, `@font-face`, font files or page text.

## What a measurement cannot do

The typeface will not match. `font` is one of five system stacks, so a reference using a webfont measures to the nearest stack (serif, sans, humanist, slab, mono) and renders in it. That is the most visible difference between a measured look and its reference, and the grammar forces it: matching the face would need the font file, which is extraction.

## Pointing it at a site

The first case is your own old site. For anyone else's, `cli/measure.mjs` is one page load. It sends an identifying user agent (`blog-webcli-measure/…`, with this repository's address), fetches `robots.txt` first and obeys it (RFC 9309: our group over `*`, the longest rule wins, a 5xx reads as "do not fetch"), and does not crawl.

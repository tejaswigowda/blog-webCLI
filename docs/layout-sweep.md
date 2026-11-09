# Layout sweep of the imported themes

Run by `node cli/wp-sweep.mjs`: every theme in `blog-webCLI-themes/wp` is built over the layout corpus (the example posts, `test/golden/`, `test/corpus/` and `test/layout/`; the index in list and cards layouts, a second page, a tag page, the tag list, the archive, a standalone page, and 11 posts), opened in headless Chrome at 1280 and 390 px wide, and measured. Nothing is judged by pixel distance.

| verdict | themes |
|---|---|
| usable | 17 |
| usable (soft) | 44 |
| degraded | 11 |
| unportable? | 5 |

**usable**: no signature. **usable (soft)**: only a measure wider than 1180 px (no maximum width on the text). **degraded**: a signature that hides, covers or loses content, or the page scrolls sideways. **unportable?**: a hole signature on the post page *and* the theme targets a sidebar the generator does not emit; confirmed or cleared by eye on the contact sheet, and a candidate until then.

## Signatures

| signature | meaning |
|---|---|
| overflow | the page is wider than the viewport |
| header-zero / main-zero | the header or `main` has no height or is hidden |
| title-hidden | no post title a reader can see |
| title-below-fold | the title starts below 70% of the viewport (a hero or slider pushed the content down) |
| covered | something is painted over the title or the text (a preloader, an overlay) |
| column-narrow / column-wide / off-centre | the text column is under 320 px (55% of a phone), over 1180 px, or not centred |
| contrast-body / contrast-title | under 3:1 against the nearest opaque background (unknown when the background is an image) |

## Themes that are not usable as they are

| theme | verdict | signatures | targets a sidebar |
|---|---|---|---|
| blogsy | degraded | title-below-fold@desktop |  |
| customify | degraded | column-narrow@phone | yes |
| newsblogger | degraded | title-below-fold@phone |  |
| newsgoal | degraded | title-below-fold@desktop, title-below-fold@phone |  |
| newsup | degraded | title-below-fold@desktop, title-below-fold@phone |  |
| oceanly-green | degraded | title-below-fold@phone |  |
| prespa | degraded | covered@desktop, covered@phone | yes |
| sinatra | degraded | overflow@desktop | yes |
| sydney | degraded | covered@desktop | yes |
| twentyfourteen | degraded | contrast-title@desktop, contrast-title@phone | yes |
| twentyten | degraded | header-zero@desktop, header-zero@phone | yes |
| bloghash | unportable? | overflow@desktop, title-below-fold@phone | yes |
| hybridmag | unportable? | title-below-fold@desktop, title-below-fold@phone, off-centre@desktop | yes |
| newscircuit | unportable? | title-below-fold@desktop, title-below-fold@phone | yes |
| rubik-news | unportable? | title-below-fold@desktop, title-below-fold@phone | yes |
| twentyseventeen | unportable? | title-below-fold@desktop, covered@desktop, title-below-fold@phone, main-zero@desktop | yes |

## Known holes

- Horizontal overflow: 0 page renders at 390 px, so `THEME_RESPONSIVE` holds on a phone across the corpus. At 1280 px two themes (`sinatra`, `bloghash`) scroll sideways: an off-canvas or hidden menu of the theme's own skeleton sits past the right edge. Recorded as a known hole, not patched: a global `overflow-x:clip` would change every themed blog's CSS, and it belongs in contract v2.
- No `404.html` and no author page are generated yet, so neither is in the corpus.
- Contrast is unknown over a background image, so a theme that sets its text over a photograph is not checked there.
- The sweep says whether a page is readable and fits. It cannot say whether it looks like the theme; that is not its job.

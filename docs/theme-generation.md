# Writing themes outside the editor (by a person or an agent)

A theme is CSS over a closed set of classes, judged by a closed grammar, and rendered deterministically, so a theme can be written against a checker. The checker is `cli/theme-check.mjs`. It runs locally or in CI. It has no token and no way to publish: generating a theme and publishing one are separate acts.

```
node cli/theme-check.mjs --classes                    # the vocabulary wordpress-classic-2 emits: what the CSS may target
node cli/theme-check.mjs --new ./my-theme --reference https://example.com/ --agent "model 1"
node cli/theme-check.mjs ./my-theme [--reference-url https://example.com/ | --reference-css ref.css] [--json]
```

A run says, in order:

1. **What would be refused**: *every* problem, not the first. Each one is `{ rule, where, reason, fix }` (`css-import`, `css-foreign-url`, `css-undeclared-asset`, `css-image-function`, `css-script-hook`, `css-style-close`, `file-missing`, `prov-*`, `asset-*`, …). The loader refuses on the same rule it lists first (`Refusal.rule`), with the same words as before.
2. **How it renders**, only if nothing is refused: the whole layout corpus (`test/layout/` plus the golden and example posts; the index in list and cards layouts, a second page, a tag page, the tag list, the archive, a standalone page) at 1280 and 390 px, measured for the failure signatures in [layout-sweep.md](layout-sweep.md).
3. **Overlap** with a reference stylesheet, if one is given (below).

**Accepted** = nothing refused **and** the verdict is *usable* or *usable (soft)* on every page at both widths. The measure is the signatures and the validator, never pixel distance (against a page with different content it is neither achievable nor wanted). The run writes a contact sheet; a person approves last.

## What it can and cannot do

The grammar forbids `@import`, foreign `url()`, `image-set()` and script hooks. So a theme can match **palette, type scale, spacing rhythm, borders, radii and column widths**. It **cannot** match a typeface or a background picture unless the file ships as a declared theme asset, and then it needs a licence (below). It cannot add markup: the contract is the interface, and new markup goes into the contract ([contract-v2.md](contract-v2.md)), not into one theme.

## Provenance

`theme.json` may carry (and a generated theme must):

| field | meaning |
|---|---|
| `origin` | `authored`, `imported` or `generated` (absent in themes from before the field; left as they were so pinned copies still verify) |
| `reference`, `relation`, `agent`, `generated` | generated themes only: what it looked at (https), `inspired-by` or `derived-from`, the model and version, the date |
| `source_licence` | `derived-from` only: the licence the reference carries |
| `asset_licences` | `{ "fonts/a.woff2": "OFL-1.1" }`: a licence for each file |

- **`inspired-by`**: original CSS written after looking at a reference, as a designer does.
- **`derived-from`**: declarations were lifted. That is a derivative work, so it is refused unless `source_licence` is one that permits reuse (MIT, ISC, 0BSD, BSD-2/3-Clause, Apache-2.0, CC0-1.0, Unlicense, CC-BY-4.0, the GPL family), the source's notice is kept in `attribution`, and a GPL source gives a GPL-family theme.
- **Every file of an authored or generated theme declares a licence** that permits redistribution; a file with none refuses the theme, and so does a non-commercial, no-derivatives or reserved licence. A custom grant is `LicenseRef-…`. An imported theme's files carry the theme's own (GPL-family) licence, which the importer checked.

**These are declarations, not detections.** Nothing here can tell whether a theme is truly inspired-by or derived-from, or whether a file is what its licence says. A theme that simply leaves out `origin` is held to none of this: the validator cannot demand the field without breaking every pinned theme, so the checker, `--new` and the registry ask for it, and the licence gate applies to a theme that says it is authored or generated. What *is* mechanical is `lib/overlap.js`: it compares the generated CSS's declaration blocks (three or more declarations, normalised) with the reference's, and warns on a high share. It is a signal. A low number proves nothing, and a high one is a reason to look; it is not a gate and not proof.

## The registry

A registry entry carries `origin` (and, for generated themes, `relation`, `reference`, `agent`, `generated`). The list is a record of what exists and where it came from, not a catalogue to pick from; a theme with no entry still works by its address.

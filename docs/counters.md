# Counters

Counters are opt-in. The original source format and generated output stay unchanged
unless a blog explicitly uses `schemaVersion: 2` and a declared counter.

## Minimum generator version

Schema 2 declares its minimum supported generator:

```json
{
  "schemaVersion": 2,
  "minGeneratorVersion": "0.5.1"
}
```

Generators older than `minGeneratorVersion` refuse to build or render the blog.
Schema 1 remains the default and does not enable counters. Keep the minimum at or
above the first generator that understands every feature the blog uses.

## Declare and use counters

Declare one or more names in a post or page's front matter:

```yaml
counters:
  step: { start: 1, style: decimal }
  figure: { start: 1, style: upper-roman }
```

Use an empty reserved span in Markdown headings or an HTML block:

```markdown
## <span class="wc-count-step"></span> Prepare the scene

<figure><img src="asset:images/scene.png" alt="The scene"><figcaption><span class="wc-count-figure"></span> Scene setup</figcaption></figure>
```

Supported styles are `decimal`, `lower-alpha`, `upper-alpha`, `lower-roman` and
`upper-roman`. Alpha numbering is spreadsheet-style (`z`, `aa`, `ab`); Roman
numerals are limited to 3999. A used name must be declared or the build is refused.
Resolution follows source order, before heading anchors or other presentation
transforms. The generator and client renderer share the same resolver. Published
pages contain literal number text; no counter script or CSS counter is involved.

The editor offers an **Insert counter** toolbar control for the current page's
declared names and a resolved preview. The source remains the empty-span syntax;
the visible number in Quill is only an editing placeholder.

The `links --counters` maintainer report proposes consecutive hand-numbered
`span.step` sequences. It is report-only and does not change sources. Conversion
is a deliberate per-page edit.

Across the 27 Strata tutorials in the reference inventory, the first-parent
history (September 16–November 19, 2026) contains 12 observed commits that inserted
one or more numbered steps between existing steps, across 267 tutorial-file
revisions. Five tutorials have at least one such insertion. This is repository
history evidence, not a forecast of future author behavior; manual inserted steps
were a real recurring edit in the inspected period.

Cross-references, nested counters, cross-page scope and author-defined block types
remain deferred.

## Compatibility verification

The first full-corpus run compared the pre-counter `0.5.0` generator with `0.5.1`.
It normalizes only the generator-version string in generated HTML and index files;
all other bytes are still compared. A separate raw-origin audit found that live
Deals output already differs from current regeneration (for example, the published
AirPods page has a cover image absent from current output). That pre-existing drift
is not treated as a counter regression and is not repaired by this feature.

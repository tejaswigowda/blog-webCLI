# blog-webCLI

Build and publish a text-first site or blog from GitHub repositories. The browser editor and reader work directly with the repository; publishing commits canonical Markdown and generated static HTML. No application server or per-site deployment is required.

## Start here

- [Open the editor](https://blog.webcli.app/) or read the [About page](about/).
- [Documentation map](docs/README.md) for tutorials, migration guides and project notes.
- [Quick WordPress migration guide](about/WP-MIGRATION-GUIDE.md).
- [Full technical reference](docs/reference.md) for the Markdown dialect, configuration, themes, publishing, CLI, security boundaries and limits.

## Four live examples

The [About page](about/) includes screenshots captured November 18, 2026:

| Site | Shape | Live site |
|---|---|---|
| Lyceum Shorts | Educational film catalogue with source scenes and tutorials | [lyceumshorts.com](https://lyceumshorts.com/) |
| webcli.app | Product directory generated from structured tool data | [webcli.app](https://webcli.app/) |
| Strata tutorials | Hierarchical library of 27 searchable tutorials | [strataeditor.dev](https://strataeditor.dev/about/tutorials/) |
| Deals in AZ | WordPress-imported commercial blog with 8,000+ posts | [dealsinaz.com](https://dealsinaz.com/) |

Lyceum Shorts' live catalogue is a sample; the separate editor-publishing prototype is not yet safe because its custom player integration is incomplete. See the [case studies and tutorials](about/tutorials/).

## Compatibility

The 1.x promise is stable configuration meaning, source-derived public addresses, non-reinterpreting additions to the Markdown dialect, and a versioned post-index shape. New `blog.json` files use `schemaVersion: 1`; older files without the field are read as schema 1. See the [compatibility contract](docs/reference.md#1x-compatibility-contract) and the [scheduled reference-CI workflow](.github/workflows/references.yml).

## Development

## URL render

Blog also exposes a read-only Markdown render interface:

```text
https://blog.webcli.app/#run=render&markdown=%23%20Hello%0A%0AA%20%2A%2Abold%2A%2A%20paragraph.&download=1
https://blog.webcli.app/#run=render&src=https%3A%2F%2Fexample.com%2Fpost.md&download=1
```

`run=render` accepts inline `markdown=` text or a credential-free HTTP(S), data, or blob `src=` URL. It produces an HTML artifact in `window.__webcli_result`; `format=HTML` is the only format. Publishing, repository access and GitHub commits remain separate, user-initiated actions.

Edit About content in `docs/about.md`; edit tutorials in `docs/`. Run `npm run build:about` to regenerate the static pages and `npm run check:about` to verify them. Run `npm test` for the unit suite and see the [reference guide](docs/README.md) for the rest of the documentation map.

The repository is split-license: [MIT runtime](lib/LICENSE) and [GPL-3.0-only tool](LICENSE-GPL-3.0). Third-party licenses are listed in [licences-inventory.json](licences-inventory.json); see [LICENSE](LICENSE).

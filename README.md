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

Edit About content in `docs/about.md`; edit tutorials in `docs/`. Run `npm run build:about` to regenerate the static pages and `npm run check:about` to verify them. Run `npm test` for the unit suite and see the [reference guide](docs/README.md) for the rest of the documentation map.

The repository is split-license: [MIT runtime](lib/LICENSE) and [GPL-3.0-only tool](LICENSE-GPL-3.0). Third-party licenses are listed in [licences-inventory.json](licences-inventory.json); see [LICENSE](LICENSE).

## Reference section links

The complete text moved to [docs/reference.md](docs/reference.md). The headings below preserve the former README section URLs while linking directly to the corresponding reference section.

## [1.x compatibility contract](docs/reference.md#1x-compatibility-contract)
## [A post](docs/reference.md#a-post)
### [Canonical markdown](docs/reference.md#canonical-markdown)
### [LaTeX math](docs/reference.md#latex-math)
### [Tables](docs/reference.md#tables)
### [Icons](docs/reference.md#icons)
### [Slideshows](docs/reference.md#slideshows)
### [Widgets and automatic navigation](docs/reference.md#widgets-and-automatic-navigation)
### [HTML blocks](docs/reference.md#html-blocks)
### [CSS class groups](docs/reference.md#css-class-groups)
## [Creating a blog](docs/reference.md#creating-a-blog)
## [Importing from WordPress](docs/reference.md#importing-from-wordpress)
## [The /blog/ reader](docs/reference.md#the-blog-reader)
## [The address the blog is served at](docs/reference.md#the-address-the-blog-is-served-at)
## [Configuration reference](docs/reference.md#configuration-reference)
### [blog.json](docs/reference.md#blogjson)
### [Post frontmatter](docs/reference.md#post-frontmatter)
### [Old addresses (redirects)](docs/reference.md#old-addresses-redirects)
### [Where the browser keeps things](docs/reference.md#where-the-browser-keeps-things)
## [Scheduled publishing](docs/reference.md#scheduled-publishing)
## [Related posts](docs/reference.md#related-posts)
## [Search engines and migrating a site, at a glance](docs/reference.md#search-engines-and-migrating-a-site-at-a-glance)
## [Addresses: permalinks, old archive addresses](docs/reference.md#addresses-permalinks-old-archive-addresses)
## [Headings and paragraph styles](docs/reference.md#headings-and-paragraph-styles)
## [About this post](docs/reference.md#about-this-post)
## [Media](docs/reference.md#media)
## [Settings screen](docs/reference.md#settings-screen)
### [Custom JS (CDN links only)](docs/reference.md#custom-js-cdn-links-only)
## [Customization](docs/reference.md#customization)
### [A designed front page](docs/reference.md#a-designed-front-page)
## [Responsive pages](docs/reference.md#responsive-pages)
## [Themes](docs/reference.md#themes)
### [First-party generation](docs/reference.md#first-party-generation)
### [Extension retirement audit (2026-11-15)](docs/reference.md#extension-retirement-audit-2026-11-15)
### [Pinning](docs/reference.md#pinning)
### [A theme repository](docs/reference.md#a-theme-repository)
### [Markup contracts](docs/reference.md#markup-contracts)
### [Export and import a blog's theme](docs/reference.md#export-and-import-a-blogs-theme)
### [The Media tab](docs/reference.md#the-media-tab)
### [Make a blog look like an existing site: measure it](docs/reference.md#make-a-blog-look-like-an-existing-site-measure-it)
### [Theme bootstrap kits](docs/reference.md#theme-bootstrap-kits)
### [Measuring themes](docs/reference.md#measuring-themes)
### [Writing themes outside the editor](docs/reference.md#writing-themes-outside-the-editor)
### [Ingesting a WordPress theme](docs/reference.md#ingesting-a-wordpress-theme)
### [Sandboxed embeds](docs/reference.md#sandboxed-embeds)
### [Licences](docs/reference.md#licences)
### [The registry](docs/reference.md#the-registry)
## [Dependencies and licences](docs/reference.md#dependencies-and-licences)
## [One renderer](docs/reference.md#one-renderer)
## [Assets](docs/reference.md#assets)
## [Video](docs/reference.md#video)
### [Embedding a video](docs/reference.md#embedding-a-video)
## [Site features](docs/reference.md#site-features)
## [Publish latency: not waiting for GitHub Pages](docs/reference.md#publish-latency-not-waiting-for-github-pages)
## [CLI](docs/reference.md#cli)
## [Sign in with GitHub](docs/reference.md#sign-in-with-github)
## [Token permissions](docs/reference.md#token-permissions)
### [Troubleshooting: `403 Resource not accessible by personal access token`](docs/reference.md#troubleshooting-403-resource-not-accessible-by-personal-access-token)
## [Editing, auth, egress](docs/reference.md#editing-auth-egress)
## [Refusals](docs/reference.md#refusals)
## [Gates](docs/reference.md#gates)
## [Large blogs](docs/reference.md#large-blogs)
## [Known limits](docs/reference.md#known-limits)

# About blog-webCLI

{.lead} A blog is a GitHub repository. blog-webCLI is a browser editor, reader and shared static-site generator for publishing that repository as a site you can inspect, copy and keep.

## Your content, in your repository

Posts and standalone pages are canonical markdown with frontmatter. Site settings live in blog.json. Publishing commits the source and regenerated HTML, index and feed to GitHub; GitHub Pages can serve the result without an application server.

The editor uses Quill, but markdown is the stored format. A round-trip check refuses content that cannot survive conversion without loss. HTML blocks have an allowlist; CSS classes connect authored structure to the site's styling.

Themes, system typography, Custom CSS, widgets, slideshows, heading anchors, optional contents and publish-time MathML provide presentation without embedding arbitrary code in a post.

## What runs where

The editor and the token-free reader are JavaScript applications. The editor talks directly to GitHub for repository operations; an optional GitHub sign-in configuration can use an OAuth exchange proxy. A fine-grained token is another supported sign-in method.

Publishing is egress: source, generated pages and any selected media are sent to the repositories shown in the pre-flight. The egress ledger makes those requests visible. Nothing is published until you confirm the operation.

Published content is static HTML and remains readable without scripting. Optional search, live updates and slideshow playback add first-party scripts for those features. Math is rendered at publish time rather than requiring a reader-side math library.

Comments scripts, analytics and Custom JS CDN links are explicit opt-ins. Custom JS accepts approved HTTPS CDN links with required integrity hashes, never inline JavaScript. These scripts run with the published page's full powers, not inside a sandbox; they can make further requests. The editor and reader preview do not execute them.

## Sample sites

These four live sites show different shapes blog-webCLI can publish: a film catalogue, a structured tool directory, a deep tutorial library and a large WordPress-imported blog. Screenshots were captured November 18, 2026; each image links to its live site.

### Lyceum Shorts

[![Lyceum Shorts film catalogue, with grouped films and links to their source scenes and tutorials](tutorials/lyceumshorts-home.jpg)](https://lyceumshorts.com/)

A film catalogue where each entry connects a short film to the editable scene that produced it and a tutorial. The live catalogue is the sample; the separate [editor integration prototype](/about/tutorials/rebuild-lyceumshorts.html) is not yet safe to use for publishing because its custom player integration is incomplete.

### webcli.app

[![webCLI tool directory showing its contract and grouped browser tools](tutorials/webcli-home.jpg)](https://webcli.app/)

A product index rebuilt from structured tool data and static pages, with its repeated cards generated at build time. Read the [rebuild case study](/about/tutorials/recreate-webcli-app.html).

### Strata tutorials

[![Strata tutorial library showing 27 tutorials, topic filters and search](tutorials/strata-tutorials.jpg)](https://strataeditor.dev/about/tutorials/)

A hierarchical, searchable library of 27 hands-on tutorials, grouped by scenes, games, animation, characters and motion capture.

### Deals in AZ

[![Deals in AZ home page with its branded navigation and latest deals](tutorials/dealsinaz-home.jpg)](https://dealsinaz.com/)

An actively updated commercial blog imported from WordPress, with more than 8,000 posts and owner-published updates. The [case study](/about/tutorials/update-dealsinaz.html) records the update and address checks.

The [tutorials and guides](/about/tutorials/) also cover the Swim Platform migration, with additional screenshots and a downloadable theme recipe. For a shorter starting point, read the [WordPress migration guide](/about/WP-MIGRATION-GUIDE.md).

## Inspect the implementation

The shared lib code is used by the generator and live renderer so that publishing and rebuilding follow the same rules. Tests cover round trips, validation, generated output, runtime boundaries and browser workflows.

The [technical reference](https://github.com/tejaswigowda/blog-webCLI/blob/main/docs/reference.md) describes the Markdown dialect, configuration, commands, limitations and verification gates. The [source repository](https://github.com/tejaswigowda/blog-webCLI) holds the implementation and issue tracker.

## Licences and contributions

The runtime library and generated-page code are MIT-licensed. The editor, reader and command-line tool are GPL-3.0-only. Third-party components retain their own licences; see [Licences and dependencies](/#licences) for the generated inventory and the repository's licence files for the terms.

Report a problem or propose an improvement through [GitHub issues](https://github.com/tejaswigowda/blog-webCLI/issues). A useful report names the command or editor action, expected result and refusal or error, without including tokens or other secrets.

[Tutorial: webcli.app](/about/tutorials/recreate-webcli-app.html) · [Tutorial: Lyceum Shorts](/about/tutorials/rebuild-lyceumshorts.html) · [Open the editor](/)

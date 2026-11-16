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

## Not just chronological blogs

Standalone pages, home-page slots, reusable content widgets and Custom CSS can make a portfolio, documentation site or directory. The [webcli.app tutorial](/about/tutorials/recreate-webcli-app.html) explains a real rebuild: an existing tool directory recreated with structured data, canonical pages and CSS, without its former client-side rendering dependency.

The [tutorials and guides](/about/tutorials/) also cover the Swim Platform migration, with screenshots and a downloadable theme recipe. For a shorter starting point, read the [WordPress migration guide](/about/WP-MIGRATION-GUIDE.md).

## Inspect the implementation

The shared lib code is used by the generator and live renderer so that publishing and rebuilding follow the same rules. Tests cover round trips, validation, generated output, runtime boundaries and browser workflows.

The [README](https://github.com/tejaswigowda/blog-webCLI#readme) describes the markdown dialect, configuration, commands, limitations and verification gates. The [source repository](https://github.com/tejaswigowda/blog-webCLI) holds the implementation and issue tracker.

## Licences and contributions

The runtime library and generated-page code are MIT-licensed. The editor, reader and command-line tool are GPL-3.0-only. Third-party components retain their own licences; see [Licences and dependencies](/#licences) for the generated inventory and the repository's licence files for the terms.

Report a problem or propose an improvement through [GitHub issues](https://github.com/tejaswigowda/blog-webCLI/issues). A useful report names the command or editor action, expected result and refusal or error, without including tokens or other secrets.

[Tutorial: recreating webcli.app](/about/tutorials/recreate-webcli-app.html) · [Open the editor](/)

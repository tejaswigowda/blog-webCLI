# Rebuilding Lyceum Shorts with blog-webCLI

{.lead} Six short educational films, their source scenes and tutorials, an existing HLS player and 131 MB of locally hosted video: this migration uses blog-webCLI for the shared site renderer while keeping Lyceum's specialized publishing pipeline.

The [live site](https://lyceumshorts.com/) is driven by [`lyceum.json`](https://github.com/tejaswigowda/lyceumshorts.com/blob/main/lyceum.json). The migration preserves its public paths, metadata, scenes, captions, video renditions and no-third-party-request policy.

## 1. Keep the data model

Each film already has a structured record: claim, assumptions, demonstration-or-derivation status, colour key, scene repository and pinned render facts. Replacing that with hand-maintained HTML would create another source of truth. `lyceum.json` remains authoritative for those fields; the site generator turns each record into page content and canonical Markdown for the shared renderer.

The film files keep their existing addresses:

```text
films/pythagoras/
films/a-plus-b-cubed/
films/hardy-weinberg/
films/area-volume/
films/projectile/
films/piston/
```

Preserving the path preserves existing links and embeds. The root index, About, Contribute and 404 pages are also generated through blog-webCLI. The six films are rendered in a separate folder-scoped blog build, so the index can retain its curated grouping by subject without making a second all-films feed.

## 2. Generate, round-trip and render

`scripts/generate.mjs` adapts each structured record to the page content, converts it to the app's canonical Markdown, then calls the pinned blog-webCLI `buildSite` for the actual pages. The generated `pages/*.md` files make the renderer input inspectable alongside its HTML output.

The HTML round trip is not a way around the authored-HTML allowlist. It normalizes the source template into Markdown first; blog-webCLI parses, validates and re-serializes its content before output. Site-owned player wiring happens afterwards in this explicit build adapter, not in an author's post or Custom JS setting.

## 3. Preserve the specialized player locally

The editor does not provide an adaptive HLS player, a caption-aware video element or transcript time links. Rather than add a provider-specific feature or move the 131 MB of renditions to a third party, the site build restores Lyceum's first-party player to film pages:

- the HLS playlists, segments, posters, captions and vendored hls.js remain in this repository;
- Safari uses native HLS; other supporting browsers use the local hls.js and player scripts;
- the full transcript remains readable without scripting, and timestamp links seek when playback is available;
- films retain their VideoObject metadata, exact scene links and existing canonical addresses.

This is a narrow, named integration in `scripts/generate.mjs`. It does not enable local or inline JavaScript in blog-webCLI. Index cards and ordinary content still use the shared renderer; the film page's trusted integration is kept distinct so it can be audited and tested.

## 4. Keep presentation and requests honest

The existing `assets/style.css` remains first-party and preserves the mobile-first light/dark palette, film cards, transcript and player. Its `prefers-reduced-motion` rules disable animation and transitions; scroll behavior is left intact so transcript navigation still works.

The build removes blog-webCLI's default Font Awesome link, then Lyceum's gate checks generated resource references. The only external URLs are ordinary links a person can choose to follow; the page itself fetches from its own origin. Player libraries and video files remain self-hosted.

## 5. Rebuild and verify from a clean checkout

The repository pins the shared renderer by commit in `.blog-webcli-ref`. From a checkout:

```sh
git clone https://github.com/tejaswigowda/lyceumshorts.com.git
cd lyceumshorts.com
git clone https://github.com/tejaswigowda/blog-webCLI.git .blog-webcli
git -C .blog-webcli checkout --detach "$(cat .blog-webcli-ref)"
npm run build
npm test
npm run check:page
```

The build verifies the pinned generator, regenerates Markdown and static pages, then installs the player integration. `npm test` checks reproducibility, every original Lyceum content/media/accessibility gate, and local paths. `npm run check:page` exercises the rendered index and film player in Chrome, including responsive layout and transcript seeking.

The resulting `x-generator` metadata identifies blog-webCLI output. The site remains static and is served from the repository root by GitHub Pages; no app server or new deployment workflow is required.

## Why use both showcases?

[webcli.app](https://webcli.app/) demonstrates a structured tool directory rebuilt as canonical pages and CSS. Lyceum Shorts demonstrates the other boundary: share rendering and publishing machinery, preserve a specialized local media pipeline, and make the integration explicit. Together they show a static site tool can be useful without pretending every feature is a generic blog post.

[Tutorials and guides](/about/tutorials/) · [About blog-webCLI](/about/) · [Open Lyceum Shorts](https://lyceumshorts.com/)

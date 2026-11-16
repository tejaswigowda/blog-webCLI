# Recreating webcli.app with blog-webCLI

{.lead} A practical case study: rebuilding an existing tool directory as canonical markdown, structured content and Custom CSS, while keeping its appearance and removing its browser-side rendering dependency.

The result is [webcli.app](https://webcli.app/). Its [source repository](https://github.com/tejaswigowda/webcli.app) contains the tool manifest, page sources, build scripts and generated HTML. This tutorial describes that restoration, not a requirement that every blog needs a custom build script.

## 1. Separate appearance from behavior

The previous site used system fonts, light and dark colors, section links, bordered tool cards, screenshots and a worked example. Its JavaScript fetched a tool manifest and assembled the cards in the visitor's browser.

We kept the design, but moved card generation to publish time. The current twelve tools, their grouping, states and limitations remained authoritative. Restoring an old layout did not mean restoring old privacy claims or presenting an old roadmap as current.

The [pre-migration version](https://github.com/tejaswigowda/webcli.app/tree/5256335a84029e24970fea147df98f7b974fb219) supplied the visual reference and screenshots.

## 2. Open the repository in blog-webCLI

Enter owner/repository in the repository field. A blog in a subfolder uses owner/repository/folder. Sign in only when you need to save changes; publishing uses your repository access.

Use the Pages tab for standalone pages. Settings controls the title, address, typography, colors, layout and Custom CSS. Save and Publish show a pre-flight of the files and destinations before anything is sent.

The site is made from these pieces:

```text
blog.json              Site settings and Custom CSS
tools.json             Authoritative tool data
pages/home.md          Introduction, cards and example
pages/home-after.md    Claims, ledger, measurements and licences
scripts/render.mjs     Tool data to canonical home markdown
scripts/build.mjs      Full site build and resource checks
shots/                 Committed screenshots
index.html             Generated front page
```

The repeating directory comes from structured data. Ordinary authored pages do not need that extra renderer.

## 3. Use the home-page slots

A standalone page with the slug home supplies the front of the index, replacing the generic title and description. A page with the slug home-after supplies content below the post list.

For webcli.app, the first holds the introduction, section navigation, contract, tool cards and example. The second holds the shared claims, ledger, speed measurement, agent information and licences. Both use noindex because they are building blocks of the main index.

A home-page source starts like this:

```markdown
---
slug: home
title: webCLI
status: published
noindex: true
---

# webCLI

An introduction to the tools.
```

The filename and slug must agree. Keep published slugs stable so existing links continue to work.

## 4. Generate the repeating cards

The site's renderer reads tools.json and writes the two home pages. Each tool becomes an allowlisted HTML block with a heading, badges, a definition list, limitations and a source link.

For example:

```html
<article class="tool" id="tool-example">
<h4><a href="https://example.com/">example</a></h4>
<dl><dt>in</dt><dd>A local file</dd><dt>out</dt><dd>A downloadable artifact</dd></dl>
<p class="caveat">Its current limitations.</p>
</article>
```

Keep all of a raw HTML block's tags together, without blank lines inside it. blog-webCLI validates and re-serializes the markup. Scripts, event handlers and inline styles are not allowed in authored HTML.

The renderer escapes manifest text before inserting it into HTML. An input description containing angle brackets remains text, not markup.

For this site, edit tools.json to change a card and rebuild. Editing the generated home markdown directly would be overwritten by the next run of the site's renderer. This is a property of that pipeline, not of all blog-webCLI pages.

## 5. Put presentation in Custom CSS

In Settings, choose system typography, width and text size, then use Custom CSS for the rest. The restoration uses a 52rem width and 16px system typography, monospace tool names and separate light/dark colors.

This simplified example shows how the card classes connect to its appearance:

```css
.tool {
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: .8rem 1rem;
  margin: .8rem 0;
}
.tool dl {
  display: grid;
  grid-template-columns: 5.5rem minmax(0, 1fr);
  gap: .15rem .6rem;
}
@media (max-width: 30rem) {
  .tool dl { grid-template-columns: minmax(0, 1fr); }
}
```

The actual rules also handle screenshot floats, badge colors, focus indicators and the phone layout. HTML supplies structure; CSS supplies appearance. Custom CSS cannot fetch resources: imports, external fonts, URL functions and scripting hooks are refused.

The screenshots were recovered from the previous site and committed under shots. Their published URLs are same-origin, so loading the directory does not contact each tool to fetch its screenshot.

## 6. Keep the published page independent of JavaScript

All cards, parameters, licences and the example are already in the served HTML. The old runtime card renderer, copy buttons and client-side highlighting were not restored. The example's original measurement is explicitly historical.

No custom JavaScript is enabled on webcli.app. blog-webCLI's Custom JS setting accepts only integrity-pinned CDN links from its approved hosts, not pasted code. That option is not needed for this design and would introduce third-party requests if enabled.

There is one site-specific build step worth recording: the generator includes a Font Awesome CDN stylesheet link. webcli.app removes that exact tag after generation, then refuses any remaining third-party resource reference. Do not copy a no-third-party-request claim without checking the actual output.

## 7. Build with an exact generator version

The site's .blog-webcli-ref pins blog-webCLI to a published commit. With Git and Node.js 22 or newer, the workflow from a fresh checkout is:

```sh
git clone https://github.com/tejaswigowda/webcli.app.git
cd webcli.app
git clone https://github.com/tejaswigowda/blog-webCLI.git .blog-webcli
git -C .blog-webcli checkout --detach "$(cat .blog-webcli-ref)"
npm run build
npm test
npm run check:page
```

The build writes the home markdown, runs the pinned generator, removes the Font Awesome link and checks resource references. The browser check needs Chrome.

Do not edit generated HTML by hand. Rebuild, review the source and output diff, and commit them together. This repository publishes through GitHub Pages from main and the repository root; the restoration did not change that deployment configuration.

## 8. Verify behavior and measure honestly

The restoration passed ten site tests and browser checks at 390px and 1280px in light and dark mode, with scripting disabled. They check the tool cards, screenshots, section targets, overflow and same-origin requests.

The recorded five-run cold phone measurement was 0 JavaScript files, 0ms blocking time and a median LCP of 664ms. The method is in [measure.json](https://webcli.app/measure.json). This is lab data from the restoration, not a promise about every visitor's connection or future revision.

The family's [ledger.json](https://webcli.app/ledger.json) measures a different thing: tool loading and idle, including a network cut. It is not a complete audit of every operation in every tool.

## Try the same approach

- Inventory the original content, layout and behavior separately.
- Put authored content in pages; generate repeating content from one authoritative data source where useful.
- Use classes and Custom CSS instead of copying a site's scripts into HTML.
- Keep screenshots local or use properly pinned assets, with honest captions and dates.
- Test without scripting, at phone and desktop widths, before publishing.
- Record exceptions and measurements alongside the result.

[About blog-webCLI](/about/) · [Read the full documentation](https://github.com/tejaswigowda/blog-webCLI#readme) · [Explore the rebuilt site](https://webcli.app/)

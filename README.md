# blog.webcli.app

A blog is one or more GitHub repositories. `https://blog.webcli.app/#repo=owner/blog`
renders it; the same app edits it when you sign in. No hosting, no accounts, no
per-blog deployment.

```
blog repo     posts/*.md · blog.json · assets.lock.json · index/posts.json · generated HTML · feed.xml
images repo   binaries
audio repo    binaries
video repo    a renders repository published by hls.webcli.app (HLS releases, tagged <name>/vN)
```

Any of these can share one repository by taking a folder of it, written `owner/name/folder`
everywhere a repository is named (the page address, `blog.json`'s `repo`, `assets.repos`,
`video.repos`):

```
me/site
├── blog/       #repo=me/site/blog   blog.json, posts/, generated HTML, feed.xml
├── images/     "images": "me/site/images"
└── clip/ …     "videos": "me/site"            hls.webcli.app publishes <name>/ at the repo root
```

The blog and an asset or video repo may not be the same place (`bad-blog-json`): give the blog
or the media a folder. If an asset or video folder sits inside the blog's own folder, a post
cannot take its name as a slug (`slug-collision`). The blog only ever reads and writes inside
its folder, so publishing never touches the images or renders beside it. With a folder, serve
GitHub Pages from the repository root and put `.nojekyll` there (the generated one inside the
folder is ignored by Pages); set `domain` to the folder's URL.

Publishing does two things: it commits the **markdown**, and it commits **generated
static HTML** (a page per post, an index, `feed.xml`) that the blog repo's own GitHub
Pages serves. The universal renderer (this app) works for any repo; the static pages
are what crawlers and link unfurlers see. Both come from one library in [lib/](lib/).

## A post

`posts/<slug>.md`:

```
---
slug: static-hls-in-git      # the URL; set once, never changes
title: Static HLS in git     # change freely
date: 2026-11-05             # authored; the index is ordered by this
author: Ada Example
tags: [video, git]
status: draft | published    # draft = in no index, page or feed
cover: asset:images/hls-cover.png
description: optional; defaults to the first paragraph
---

Body in markdown…
```

Quill is a *view* over the markdown. Nothing but markdown is ever stored.

### Canonical markdown

The editor toolbar offers only what markdown can express, and a post must be in the
form the converter would write, so `md → Delta → md` is byte-identical:

| | |
|---|---|
| paragraphs | separated by one blank line; a paragraph is one line (no hard wrapping) |
| headings | `#`, `##`, `###` |
| inline | `**bold**` `_italic_` `~~strike~~` `` `code` `` `[text](url)` `![alt](asset:key/path)` |
| lists | `-` bullets and `1.` numbers, nested with 4 spaces; a blank line between lists of different type |
| quotes, code | `> ` quotes (`>` between paragraphs), fenced code with optional language |
| escapes | `\* \_ \~ \[ \] \< \`` and a leading `\#`, `\-`, `\>`, `\+`, `1\.` are always escaped |

Not offered, and refused rather than approximated: colour, underline, alignment, tables,
raw HTML, embeds other than images and video releases. If a file is not canonical the editor refuses to open
it (`lossy-round-trip`) instead of rewriting it; `blog-webcli fmt` normalises it.

On save the editor drops empty paragraphs and moves formatting off edge whitespace, then
**proves** the round trip before anything is sent.

## Creating a blog

Open a repository (or `owner/repo/folder`) that has no `blog.json` and sign in: instead of a
dead end the app offers a short form (title, description, author, the address the blog is
served at, and optionally an images repo and a video repo). *Create blog…* shows the usual
pre-flight and commits, in one commit, `blog.json` plus the generated site (`index.html`,
`feed.xml`, `index/posts.json`, `.nojekyll`), so the generated-output check passes from the
first commit. Posts already in the folder are indexed, not lost; if they cannot be published
as they are (for example an image that is not pinned) the creation is refused with the reason.
An existing `blog.json` is never replaced. The repository itself must already exist and have
one commit (GitHub cannot write to an empty one); the app tells you when it does not.

## The /blog/ reader

`https://blog.webcli.app/blog/` is a read-only page: no editor, no sign-in, no token, a strict
CSP, and the same egress ledger (always 0 B uploaded). It takes the blog from the URL hash:

```
/blog/#repo=owner/repo[/folder]               the blog (a folder when it shares a repository)
      &post=slug                              a post; omit for the list
      &ref=branch                             a branch or tag other than the default
      &images=owner/name[/folder]             optional: override a media repository
      &video=owner/name[/folder]
      &audio=owner/name[/folder]
      &blog=https://me.github.io/site         optional: the blog's own static site
```

* **Media repositories come from `blog.json`.** The hash overrides them, and `blog.json` fills in
  whatever the hash leaves out (templates, other repos, customization). Naming a repository where
  `blog.json` has no section uses the default templates. A bad value is refused, not ignored.
  Pins in `assets.lock.json` still apply, so an overriding repository must hold the same files.
* **Failsafe to the blog's URL.** If the blog cannot be loaded (GitHub down, rate limited, no
  `blog.json`, a refusal), the page says why and links to the static site: the `blog=` address if
  given, else `blog.json`'s `domain`, else the usual GitHub Pages address for the repository
  (marked as a guess). A post link goes to `<site>/<slug>/`.
* **`/blog/#blog=https://…` alone** opens that static site. GitHub Pages hosts (`*.github.io`) and
  this app are followed directly; any other host gets a "this link points to another site"
  confirmation, so the page cannot be used as an open redirect. Only `https:` is accepted.
* Posts link to *Suggest a correction* (the editor, which opens a pull request) and *Static page*.

## Customization

`blog.json` takes an optional `customize` section. The generated static pages and the `/blog/`
reader build their styles from it with the same code, so they match. Every value is checked against
a closed set; an unknown setting or an out-of-range value is refused (`bad-blog-json`), never guessed.

```json
"customize": {
  "colors": { "accent": "#0b7a5f", "text": "#202020", "background": "#fff", "muted": "#666",
              "dark": { "accent": "#5fd3a8", "background": "#101012" } },
  "font": "serif", "headingFont": "sans",
  "width": "42rem", "fontSize": "18px",
  "header": { "logo": "asset:images/logo.png", "showTitle": true,
              "links": [{ "label": "About", "url": "https://example.com/about" }] },
  "footer": { "text": "© 2026 Ada", "links": [{ "label": "Source", "url": "https://github.com/me/blog" }] },
  "list": { "layout": "cards", "excerpts": true, "dates": true, "tags": true },
  "css": ".posts h2 { letter-spacing: .02em }"
}
```

| Setting | Values |
|---|---|
| `colors` | `accent`, `text`, `background`, `muted` as `#rgb` / `#rrggbb`. Light-mode values; `dark` takes the same keys for dark mode. A colour with no dark value keeps the default dark palette. Rules and code backgrounds follow `text`/`background`. |
| `font`, `headingFont` | `serif`, `sans`, `humanist`, `slab`, `mono`: system font stacks. Nothing is loaded from the network. |
| `width` | `25–80rem`, `400–1280px` or `40–120ch` |
| `fontSize` | `14–24px` or `0.875–1.5rem` |
| `header` | `logo` (an `asset:` reference, pinned like any asset; unpinned is `unresolved-asset`), `showTitle` (`false` hides the text when there is a logo), up to 8 `links` (`https:` / `http:` / `mailto:` only) |
| `footer` | `text` (≤ 200 characters; replaces the author line) and up to 8 `links` |
| `list` | `layout` `list` or `cards`; `excerpts`, `dates`, `tags` true/false |
| `css` | ≤ 8000 characters, applied last. Allowed: ordinary rules, `@media`, `@supports`, `@keyframes`. Refused: `url()` and every other resource function, `@import`, `@font-face` and every other at-rule, backslash escapes, `<`, `expression()`, `-moz-binding`, `behavior`, `javascript:` / `data:`. A stylesheet cannot fetch anything or leave its `<style>` element. |

The header logo is checked once, up front: a logo that is not pinned refuses the whole build.

## Assets

Posts name `asset:<key>/<path>`, never a provider. `blog.json` maps keys to repos and
holds the URL template; `assets.lock.json` pins each referenced file to a commit sha.

```json
{
  "title": "My Blog",
  "description": "What this is about",
  "author": "Me",
  "domain": "https://me.github.io/blog",
  "repo": "me/blog",
  "theme": "default",
  "cover": "asset:images/default-cover.png",
  "assets": {
    "base": "https://cdn.jsdelivr.net/gh/{owner}/{repo}@{sha}/{path}",
    "repos": { "images": "me/images", "audio": "me/audio" }
  }
}
```

With a folder, the folder is part of the address and not of the reference: `asset:images/x.png`
in `me/site/images` is served from `…/site@<sha>/images/x.png`, and the lock key stays
`images/x.png`. Moving a folder means re-pinning (`pin` after deleting those lock entries).

Generated HTML carries the pinned URL (`…/images@<sha>/hls-cover.png`), so a published page
does not change when an image is later replaced. Changing CDN is an edit to `assets.base`
plus `build`; no post is touched. Naming a provider host in a post is refused
(`provider-url`).

## Video

Video lives in its own repository, produced by [hls.webcli.app](https://hls.webcli.app)
([hls-webCLI](https://github.com/tejaswigowda/hls-webCLI)): each *Publish* there is one commit
and one tag, `<name>/v<N>`, in a "renders" repository. A tag never moves, so a reference to
it is pinned by construction and needs no lock entry.

In a post, a video is a block on its own line, naming the repo key, the release name and the version:

```
![](video:videos/clip@v3)
```

`blog.json` says where the repo is and how to play it (hls-webCLI's own play address):

```json
"video": {
  "player": "https://strataeditor.dev/player/",
  "base": "https://cdn.jsdelivr.net/gh/{owner}/{repo}@{tag}/{slug}/",
  "repos": { "videos": "me/renders" }
}
```

In a shared repository the release lives under the video folder (`…@clip/v3/<folder>/clip/`);
tags are per repository, so `clip/v3` is checked at `me/site` whatever the folder. hls.webcli.app
itself writes at the repository root, so use a folder for video only if you place the release there.

Generated pages get a sandboxed `<iframe>` at `<player>#<base>&present=true` (the *Copy embed
link* address) plus a plain "Watch" link inside the figure for readers without scripting. The
editor's video button lists the releases it finds in the video repos. Publishing a post refuses
a reference to a tag that does not exist (`unresolved-asset`); a draft may name one not yet
published. `node cli/blog.js pin` verifies tags too. Changing player or CDN is a `blog.json`
edit and a rebuild; no post is touched, and a post naming the player or CDN address is refused
(`provider-url`).

## CLI

```
node cli/blog.js build [dir]   regenerate index, pages, feed (writes nothing if anything is refused)
node cli/blog.js check [dir]   regenerate in memory; non-zero on any difference — for CI
node cli/blog.js fmt   [dir]   rewrite posts into canonical markdown
node cli/blog.js pin   [dir]   pin unpinned asset: references, verify video: release tags (GitHub API, $GITHUB_TOKEN optional)
node cli/serve.js [dir] [port] static server for local preview
```

CI: copy [templates/blog-check.yml](templates/blog-check.yml) into the blog repo.
Serve generated pages by enabling GitHub Pages on the blog repo (root of the default
branch); `.nojekyll` is generated so Pages does not process `posts/*.md`.

## Token permissions

Reading a public blog needs no token. Editing needs a **fine-grained personal access token**
(github.com/settings/personal-access-tokens), because a classic `ghp_` token with `repo` scope
can write to every repository the account owns.

| Permission | Level | Used for |
|---|---|---|
| Contents | Read and write | reading `blog.json`, posts and release tags; committing posts, generated pages and images; creating a blog. All that publishing, drafts and creating a blog need. |
| Pull requests | Read and write | only "Suggest a correction", which opens a pull request. Omit it if you do not use that. |
| Metadata | Read-only | added automatically |

Token settings:

* **Repository access: Only select repositories.** List the blog repository, any images
  repository and any video repository. A repository that is not listed answers 404 or 403.
* **Resource owner:** the account or organization that owns those repositories (an organization
  may need an admin to approve the token).
* **Expiration:** keep it short, since the token can sit in `localStorage` if you tick "remember".
* Not needed: Workflows (the app never writes `.github/workflows`), Administration (it never
  creates repositories), or anything account-wide.

Permissions apply to every repository you select; they cannot differ per repository. The app
only *reads* the video repository (listing and checking release tags), so use a separate token
with Contents write when publishing there with hls.webcli.app.

### Troubleshooting: `403 Resource not accessible by personal access token`

GitHub gives this when the token lacks a permission, or when the repository is not in its
repository list. It is easy to hit by surprise: a **public** repository can always be *read*,
and `permissions.push` in GitHub's repository response describes *you* (an admin, say), not the
token. So the "create a blog" form and the editor can load, and the first write is then refused.
The app's message names the request, the permission and the repository, for example
`POST /repos/me/blog/git/trees` needs "Contents: Read and write" on `me/blog`. Edit the token to
select that repository and grant the permission; no new sign-in is needed if you edited the same
token. Other 403s, such as rate limits, are shown as GitHub sent them.

The app does not probe for write access before you confirm: the only reliable probe is a throwaway
upload, and nothing is uploaded until you confirm.

## Editing, auth, egress

* Sign in with a **fine-grained** token (see [Token permissions](#token-permissions)).
  Classic `ghp_` tokens are refused. The token is held per tab unless you tick "remember"
  (then `localStorage`).
* The page has a strict CSP and never inserts blog content except through the escaping
  renderer, because blog content is untrusted and shares an origin with the token.
* **Egress ledger** (footer): *uploaded* is a count of non-GET request bytes and reads 0
  until you publish; *read* covers listing and rendering. Before sending, a pre-flight
  states the act — *4 files, 1.2 MB, to github.com/me/blog (main)* — and a receipt with the
  commit follows. Images are uploaded to their own repo first; that commit becomes the pin.
* **Corrections**: "Suggest a correction" opens the editor on the post body; submitting opens
  a pull request on a new branch (default branch untouched). Without write access the app
  links to GitHub's own fork-and-edit page.

## Refusals

`no-blog-json` · `bad-blog-json` · `missing-frontmatter` · `bad-frontmatter` · `slug-mismatch` ·
`slug-collision` · `unresolved-asset` · `provider-url` · `unsafe-url` · `lossy-round-trip` ·
`draft-in-publish` · `classic-token`. A build that is refused writes nothing.

## Gates

`npm test` runs everything; the example blog in [examples/blog/](examples/blog) is the fixture.

| Gate | Where |
|---|---|
| B1 markdown + frontmatter, no Delta | `test/gates.test.js` |
| B2 `md → Delta → md` byte-identical over the corpus (+ fuzzed editor documents) | `test/markdown.test.js`, [test/corpus/](test/corpus) |
| B3 `curl` returns full text, no scripting | `test/gates.test.js` (serves the build, runs `curl`) |
| B4 OG / twitter / description tags, absolute urls | `test/gates.test.js` |
| B5 `feed.xml` valid (Atom; `xmllint` + structure) | `test/gates.test.js` |
| B6 no provider hostname in any `.md` | `test/gates.test.js` |
| B7 changing the asset base changes no post source | `test/gates.test.js` |
| B8 generated output regenerated and diffed | `test/gates.test.js`, `.github/workflows/ci.yml`, `templates/blog-check.yml` |
| B9 drafts in no index, page or feed | `test/gates.test.js`, `test/app.test.js` |
| B10 renaming a title does not change the URL | `test/gates.test.js` |
| B11 ledger reads zero uploaded after render-and-browse | `test/app.test.js` |

## Known limits

* Draft *source* is visible in a public repo; `draft` hides it from the site, not from GitHub.
* A video has no alt text or caption of its own (Quill's video blot cannot hold one); the title
  is the release name and version. `![alt](video:…)` is refused, not dropped.
* The player iframe and the video segments are loaded by the browser, not through this app, so
  the ledger does not count them. Video is not played until the iframe loads; static pages load
  it lazily.
* The release picker lists tags; it does not check that a tag's folder is a complete release.
* A page with no `cover` and no blog-level `cover` has no `og:image` (a warning at build).
* Staged images cannot be committed in a correction (pull request) when the image folder is in
  the blog's own repository: that would push to the default branch. Publish them in a normal edit.
* The release picker does not check that a video folder exists at the chosen folder, only the tag.
* `audio` is accepted as a media repository (hash and `blog.json`), but there is no audio player:
  an audio file is reachable as a pinned link, `[Listen](asset:audio/ep1.mp3)`.
* An invalid `customize` section refuses the build, and the reader falls back to the static site
  link rather than rendering with half of it.
* Two adjacent lists of the *same* type separated by a blank line merge on round trip, so
  such files are refused as non-canonical.
* Read counts bytes fetched by this app; images the browser loads from the asset CDN are
  not routed through it.
* `vendor/quill/` is Quill 2.0.3 (BSD-3), vendored so the app loads no third-party script.

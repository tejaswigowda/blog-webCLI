# blog-webCLI

A blog is one or more GitHub repositories. `https://blog.webcli.app/#repo=owner/blog`
renders it; the same app edits it when you sign in. No hosting, no accounts, no
per-blog deployment.

**Licence: GPL-3.0-only** ([LICENSE](LICENSE)). The app includes hls-webCLI's video encoder
([vendor/hls/](vendor/hls), GPL-3.0), so the whole app is GPL-3.0. Themes and extensions are separate
repositories with their own licences (the built-in ones are MIT) and are not affected. Note that the
pages the app generates carry its built-in default theme, which is part of the app, and say so in
their licence comment and in `licences.json`; a blog that wants no GPL text in its pages pins a theme.

```
blog repo     posts/*.md · pages/*.md · blog.json · [order.json] · assets.lock.json · index/posts.json · generated HTML · feed.xml · sitemap.xml
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
folder is ignored by Pages); `domain` is the folder's URL (the app fills it in, see below).

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
cover: asset:images/hls-cover.png   # or: auto
description: optional; defaults to the first paragraph
---

Body in markdown…
```

**Cover.** `cover: asset:images/x.png` names the cover: it is drawn above the post and is the
preview image when the post is shared (`og:image`, `twitter:image`). In the editor the Cover field
has **Upload…** (the image is staged and committed to the images repository when you publish, like an
image in the body; the post names it by a logical `asset:` reference, never a provider) and **Auto**.
`cover: auto` lets the generator pick the post's own picture, at build time: its **first image**,
else the **poster of its first video** (every hls release has a `poster.jpg`, at an address pinned by
the release tag), else the blog's `cover`. An automatic cover is the share preview and the index's
`cover` (the chosen asset; none when it is a poster); it is not drawn on the page, where it would
repeat what the post already shows. With nothing to pick and no blog cover, the build warns that the
page has no `og:image`. The source keeps the word `auto`, so changing the picture changes the cover.

A post never says where it sits in a sequence: that is the blog's [`order`](#order), and for a hand-kept order a separate
list file. Previous/next links are generated from it.

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
dead end the app offers a short form (title, description, author, and optionally an images repo
and a video repo (the address the blog is served at is shown but not asked for, see below); left blank, both default to folders of
the blog's own repository). *Create blog…* shows the usual
pre-flight and commits, in one commit, `blog.json` plus the generated site (`index.html`,
`feed.xml`, `index/posts.json`, `sitemap.xml`, `404.html`, the search page, `.nojekyll`), so the generated-output check passes from the
first commit. A new blog has the live copy and search switched on (`content` and `"search": true` in its `blog.json`); everything else is opt-in. Posts already in the folder are indexed, not lost; if they cannot be published
as they are (for example an image that is not pinned) the creation is refused with the reason.
An existing `blog.json` is never replaced. The repository itself must already exist and have
one commit (GitHub cannot write to an empty one); the app tells you when it does not.

## Importing from WordPress

On the home page, **Import from WordPress** (`#import`) takes a WordPress blog, or several, into a GitHub repository: every post, page and
draft as markdown, every picture in an `images` folder, and a blog.webcli.app blog around them. A four-step wizard:

1. **Sources.** Choose WordPress's own export file (*Tools → Export → All content*, an `.xml` file), one for each blog; the file is read in
   the browser and is not sent anywhere. Or give a live site's address: its public REST API (`/wp-json/wp/v2`) is read instead, which gives
   only published posts and pages and only works when the site lets other web pages read it. An export always works and includes drafts.
2. **Blogs.** What was found (posts, drafts, pages, media files, and any other content type, which is named and not imported); each blog's
   title, description, author and folder can be changed. With several blogs each goes in a folder of one repository. Options: import drafts (as
   drafts), and import every picture in the media library, not only the ones posts use.
3. **Pictures.** The pictures are fetched from the old site (four at a time, by this page, with no cookie, no token and no referrer), the text
   is converted, and a list says what could not be kept. Nothing is uploaded yet.
4. **Commit.** Name a repository you can write to (`owner/name`, or `owner/name/folder` to put every blog below a folder). The usual
   pre-flight lists exactly what will be sent. Then one commit holds the pictures and a second holds the blogs, regenerated with those pictures
   pinned, so what is committed is what CI would regenerate. An existing `blog.json` is never replaced.

**What becomes what**

| WordPress | here |
|---|---|
| a published post | `posts/<slug>.md`, `status: published`, `date` the post's own date (not the import's) |
| a draft, pending, scheduled or private post | the same with `status: draft` (and a note); trash and auto-drafts are skipped |
| a page | `pages/<slug>.md`; a page that is in a navigation menu gets `menu: <position>` |
| tags and categories | `tags` ("Uncategorized" is dropped) |
| the featured image | `cover: asset:images/…` |
| the excerpt, when there is one | `description` |
| the post's author | `author`, only where it differs from the blog's (the author of most posts) |
| the post's slug | the slug; changed (and noted) only if it is empty, already used, or a path this app reserves |
| a picture on the old site, in a post or in the media library | `images/wp/<its path under wp-content/uploads>`, named in posts as `asset:images/wp/…` and pinned |
| a link from one imported post to another | rewritten to the new page (`../<slug>/`) |
| comments, plugins' content types (products, forms…), widgets, themes | not imported; the types are counted and named in the review |

The text is converted to what the editor can say, which is what markdown can say: paragraphs, headings (to level 3; deeper ones become level
3), bold, italic, strike, inline code, links, images, lists, quotes and code blocks. A line break becomes a new paragraph. Anything else is reduced to
its words, and the review names it per file: a table becomes lines of text with ` | ` between cells, an embedded video or iframe becomes a link, a
`[gallery]` becomes its pictures, `[caption]` keeps its picture and words, other shortcodes are dropped, colours and fonts are dropped. Every
file is checked to survive `md → Delta → md` byte for byte, as every post is, and one that cannot be is imported as plain paragraphs and
noted. A picture hosted on another site is left linked there, not copied.

**Pictures and what a website allows.** A browser page may read another site's file only if that site allows it (CORS). A site with a CDN in
front often does; many do not, and a WordPress REST API may refuse a page without an origin. A picture that cannot be read keeps its address
on the old site, so nothing breaks while that site is up, and the review says how many and why. For every picture, use the command line, which a
website's CORS policy does not limit:

```
node cli/blog.js import wp export.xml my-blog --repo me/site/blog      # or a site address: import wp https://example.com …
```

It writes `blog.json`, `posts/`, `pages/` and `images/` and nothing else (options `--domain`, `--no-drafts`, `--no-library`); push the pictures,
then run `blog-webcli pin` (the pin is the commit the pictures are in) and `build`. The images folder sits beside a blog that has a folder of
its own, and inside a blog at the top of a repository.

**What the browser is allowed.** To fetch another site's files the editor's content-security policy lets the page read any `https:` address
(it already allowed images from any `https:` address). Those requests are made by one function (`fetchRemote` in [app/net.js](app/net.js)):
https only (or this machine, for tests), no credentials, no referrer, a size limit, counted in the egress ledger, and never given the token.
What comes back is never run and never put into the page as markup: a picture is accepted only if its first bytes say PNG, JPEG, GIF, WebP or AVIF
(never an SVG, whatever the server called it) and is then only sent to GitHub as a blob. The export file is read by a small XML reader
([lib/xml.js](lib/xml.js)) that skips a DOCTYPE and never expands an entity it declares.

The wizard keeps what it has read and fetched until you reload the page (signing in does not lose it); *Start over* clears it.

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
* The list starts in the blog's own order; a **Sort** control (blog order, newest, oldest, title) re-sorts it for the reader
  alone. It is styled as a small control whatever the theme does to form fields, and sits in the theme's content column.
  Tag, author, archive and search pages, comments and the subscribe form are the generated site's: the reader shows posts only
  (see [Site features](#site-features) and [Known limits](#known-limits)).

## The address the blog is served at

`blog.json`'s `domain` is where GitHub Pages serves the blog: it feeds links, the feed and `og:url`.
**The editor never takes it from a form field**: it is shown read-only (Settings and the create
form) and written from GitHub's own answer.

* **Pages on and readable:** GitHub's address from the repository's Pages settings, so a custom
  domain is picked up (with the blog's folder appended). To change it, change it in GitHub
  (*Settings → Pages*); the app links there.
* **Pages off:** nothing is served yet, and the field says so in a warning, with the step to turn it
  on (*Settings → Pages → Deploy from a branch → your default branch, / (root)*) and a link to the
  blog's reader page, which works meanwhile. The address shown is the conventional one
  (`https://<owner>.github.io/<repo>/<folder>`, or the root for an `<owner>.github.io` repository), or
  what `blog.json` already says; it becomes true once Pages is on.
* **Pages on, but the token cannot read it:** what `blog.json` already says, and a note that the token
  needs *Pages: Read-only* to have it read from GitHub (optional; see Token permissions).

**View blog** (next to Settings) opens the GitHub Pages site when GitHub says it is on and built, a
custom domain included, and the `/blog/` reader otherwise (Pages off, still deploying, or not
readable by the token): it never links to a site that is not there.

Saving Settings rewrites `domain` only when GitHub gives the address; otherwise it leaves what was
saved. A `domain` edited by hand in `blog.json` (for the CLI) is therefore kept until GitHub answers.
Tested in [test/address.test.js](test/address.test.js) and [test/e2e/address.e2e.mjs](test/e2e/address.e2e.mjs).

## Configuration reference

There is no server, no environment variable and no config file for the app itself. A blog is configured
by files in its own repository, and everything has a default, so the smallest blog is four fields. Each
setting lives in exactly one place:

| Where | What it configures | Written by |
|---|---|---|
| [`blog.json`](#blogjson) | the blog: identity, address, media, theme, extensions, live copy, styling | you, or **Settings** in the editor |
| [post frontmatter](#post-frontmatter) (`posts/<slug>.md`, `pages/<slug>.md`) | one post or standalone page | you, or the editor |
| `order.json` (or the file `order.list` names) | the sequence of posts, when the blog is [ordered by hand](#order) | you (the one authored file beside `blog.json`) |
| `assets.lock.json` | the commit each `asset:` reference is pinned to | the editor / `blog-webcli pin` (never by hand) |
| `extension-outputs.json` | what each extension returned at publish | the editor's sandbox (never by hand) |
| `index/posts.json`, `feed.xml`, `sitemap.xml`, `robots.txt`, `search.json`, `theme.css`, `licences.json`, `404.html`, `webcli-live.js`, `webcli-search.js`, every page, and the folders `tags/`, `authors/`, `archive/`, `page/`, `search/` | generated from the above | the generator; CI diffs them |
| the reader's URL hash | one view of a blog (`/blog/#repo=…&ref=…&images=…`, see [the reader](#the-blog-reader)) | the link |
| GitHub Pages settings | where the blog is served (branch, custom domain, HTTPS) | GitHub; the app reads it, it does not store it |
| [`themes.json`](themes.json), [`extensions.json`](extensions.json) in *this* repository | the "Built in" lists in the theme and extension pickers (a convenience: any repository works by address) | pull request |

Nothing is ever configured by writing a hostname into a post. A post names things logically
(`asset:images/x.png`, `video:videos/clip@v2`); `blog.json` says where they live.

### blog.json

A complete file with every section in use. It passes the generator's validator as written; only the first
four keys are required, and the real file is plain JSON (no comments):

```json
{
  "title": "My Blog",
  "description": "What this blog is about",
  "author": "Ada Example",
  "domain": "https://me.github.io/blog",
  "repo": "me/blog",
  "theme": "default",
  "cover": "asset:images/default-cover.png",
  "assets": {
    "base": "https://cdn.jsdelivr.net/gh/{owner}/{repo}@{sha}/{path}",
    "repos": { "images": "me/images", "audio": "me/audio" }
  },
  "video": {
    "player": "https://strataeditor.dev/player/",
    "base": "https://cdn.jsdelivr.net/gh/{owner}/{repo}@{tag}/{slug}/",
    "repos": { "videos": "me/renders" }
  },
  "content": {
    "base": "https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}",
    "ref": "HEAD"
  },
  "extensions": [
    { "repo": "me/reading-time", "ref": "v1.0.0", "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "name": "Reading time", "version": "1.0.0", "licence": "MIT", "kind": "build", "hooks": ["post:html"] }
  ],
  "customize": {
    "colors": { "accent": "#0b7a5f", "dark": { "accent": "#5fd3a8" } },
    "font": "serif",
    "width": "42rem",
    "header": { "links": [{ "label": "About", "url": "https://example.com/about" }] },
    "footer": { "text": "© 2026 Ada Example" },
    "list": { "layout": "cards", "excerpts": true, "dates": true, "tags": true }
  }
}
```

#### Top-level keys

| Key | Required | Value | If left out |
|---|---|---|---|
| `title` | yes | text | refused (`bad-blog-json`) |
| `description` | yes | text; the default page description and `og:description` | refused |
| `author` | yes | text; the byline and the feed author, unless a post sets its own | refused |
| `domain` | yes | an absolute `http(s)://` URL the blog is served at, with its folder if any (`https://me.github.io/blog`). Used for canonical links, `og:url` and the feed. A trailing `/` is dropped. The editor does not let you type it: it reads GitHub Pages (a custom domain included) and writes what GitHub says; in the CLI you write it | refused |
| `repo` | no | where the blog lives: `owner/name` or `owner/name/folder`. Needed for the defaults below, for `content`, and for "Suggest a correction" links. A blog that omits it still builds | media defaults and `content` are unavailable |
| `theme` | no | `"default"`, or a [pinned theme](#pinning) object | `"default"` |
| `extensions` | no | up to 8 [pinned extensions](#pinning), no repository twice | none |
| `cover` | no | an `asset:` reference: the share image of the index, and of any post with no `cover` of its own | no `og:image` unless a post has one (a build warning says so) |
| `assets` | no | binaries (images, audio): [below](#assets) | an `images/` folder of `repo` |
| `video` | no | video releases: [below](#video) | a `videos/` folder of `repo` |
| `content` | no | the live copy that makes publishing feel instant: [below](#content) | off: pages carry no script and there is no `404.html` |
| `order` | no | how posts are sequenced: [below](#order) | newest first (`date`, `desc`) |
| `search` | no | `true` adds a [search page](#site-features) | off |
| `pagination` | no | `{ "size": N }`: [pages of the index](#search-pagination-seo) | one list |
| `seo` | no | `twitter`, `sitemap`, `robots`: [below](#search-pagination-seo) | a sitemap, and a robots.txt at the root of a host |
| `comments`, `analytics` | no | a script from an address you name, [below](#comments-analytics) | none |
| `subscribe` | no | an email form that posts to an address you name, [below](#subscribe) | none |
| `customize` | no | colours, fonts, width, header, footer, list layout, CSS: see [Customization](#customization) | the default look |

Unknown top-level keys are carried through untouched by the editor and ignored by the generator. Anything
the generator does read is validated against a closed set: a wrong value is refused with a reason
(`bad-blog-json`), never guessed, and a refused build writes nothing.

#### `assets`

```json
"assets": { "base": "https://cdn.jsdelivr.net/gh/{owner}/{repo}@{sha}/{path}",
            "repos": { "images": "me/images", "audio": "me/audio" } }
```

| Key | Value |
|---|---|
| `base` | an `http(s)` URL template containing `{sha}` and `{path}`; `{owner}` and `{repo}` also work. A post says `asset:images/x.png`; the generated page carries `base` filled in with the commit the file is pinned to, so a page does not change when an image is replaced. Changing CDN is an edit here plus a rebuild: no post is touched |
| `repos` | at least one key (`[a-z0-9][a-z0-9_-]*`, e.g. `images`) mapped to `owner/name` or `owner/name/folder`. The key is what posts write after `asset:` |

A repository here may not be the blog's own place (`repo`): give the blog or the media a folder. A folder
that sits inside the blog's folder reserves its name, so a post cannot use it as a slug. More, including
folders and pinning: [Assets](#assets-1).

#### `video`

```json
"video": { "player": "https://strataeditor.dev/player/",
           "base": "https://cdn.jsdelivr.net/gh/{owner}/{repo}@{tag}/{slug}/",
           "repos": { "videos": "me/renders" } }
```

| Key | Value |
|---|---|
| `player` | an `https` URL (no `#`) of the player page; each video is an iframe of it |
| `base` | an `https` URL template that ends in `/` and contains `{tag}` and `{slug}` (`{owner}`, `{repo}` too): the pinned folder of one release |
| `repos` | at least one key mapped to a repository (or folder) of releases published by hls.webcli.app, tagged `<name>/v<N>` |

More, including uploading a video from the editor: [Video](#video-1).

#### `content`

```json
"content": { "base": "https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}", "ref": "HEAD" }
```

Switches on [serving fresh content before the Pages build finishes](#publish-latency-not-waiting-for-github-pages).

| Key | Value |
|---|---|
| `base` | required. An `http(s)` URL template that **ends in `/{path}`** and contains `{owner}` and `{repo}` (`{ref}` too). It is the only place a host is named for this feature: change it here and every page and `404.html` follows on the next build. It must serve the repository's files as they are at the branch head, with CORS open to any origin (GitHub's raw host does) |
| `ref` | optional. A branch name or `HEAD`; default `HEAD` |

It needs `repo` (it says which repository to read) and is refused without it. In Settings it is the
checkbox *Show new and edited posts to readers before the GitHub Pages build finishes* and, under it,
*Where the live copy is read from* (blank means the default above). A new blog has it on.

#### `order`

Ordering is a property of the blog, set by its owner. Newest first is the default, not the rule: a blog stream, a
course, a tutorial series and a shorts collection are the same software with different sequences.

```json
"order": { "by": "date",                  "dir": "desc" }
"order": { "by": "title",                 "dir": "asc" }
"order": { "by": "frontmatter:episode",   "dir": "asc" }
"order": { "by": "manual", "list": "order.json", "unlisted": "append-by-date" }
```

| Key | Value |
|---|---|
| `by` | `date` (the post's authored `date`), `title`, `manual`, or `frontmatter:<field>` (any frontmatter key, e.g. `frontmatter:episode`) |
| `dir` | `asc` or `desc`. Default `desc` for `date`, `asc` for the others. Not allowed with `manual`: the list is the order |
| `list` | `manual` only. A `.json` file at the top of the blog; default `order.json` |
| `unlisted` | `manual` only. What to do with a published post that is in no list; the only value is `append-by-date` (also the default) |

There is no `tiebreak` key, and giving one is refused. **Posts that tie are always ordered by slug, ascending**, in every
mode (including descending ones and the appended part of a manual order), because two posts that share a date and
are ordered by an unstable sort would make the generated HTML differ from run to run, and CI's
regenerate-and-diff would then fail for a reason that looks like a generator bug. Nothing here depends on a locale:
`title` compares case-insensitively by code unit, then as written, then by slug.

**`manual`: a list, never a position in the posts.** The list is a plain file:

```json
{ "order": ["intro", "shapes", "molecule-shapes", "vsepr", "review"] }
```

A post that carried `position: 7` would make an insertion between 6 and 7 renumber every file after it, and make two
people sequencing at once collide. A list makes an insertion a one-line change and keeps a post ignorant of where it sits.
It is also why a reorder control is only ever an edit to this file.

* **Drafts may be in the list.** Sequencing unpublished material is the normal case for a course. The list is the
  *authored* sequence; the generated sequence is the list filtered to published posts.
* A slug with no `posts/<slug>.md` behind it is refused (`unknown-slug-in-order`); the same slug twice is refused
  (`duplicate-slug-in-order`); a list that is not `{"order": [slugs]}`, or that does not exist, is refused
  (`bad-order-list`). Each of those is a typo, not an intention.
* **A published post that is in no list is appended, oldest first, and reported.** It is never dropped, because a post
  that exists and appears nowhere is the failure nobody notices. The build warns
  (`order: 2 published post(s) are not in order.json and were appended by date: …`) and the editor's pre-flight says it
  before anything is sent.

**`frontmatter:<field>`.** Every published post must have the field (`missing-order-field`, one refusal per post).
If every value is a number (`3`, `-1`, `0.5`) they sort as numbers; if none is, as text; **a field that is some of each is
refused** (`mixed-order-field-types`), never coerced: sorting `10` before `2` looks right on five posts and is found at
fifty. A list value is refused (`bad-order-field`).

**What the order drives.** The index, the previous/next navigation on every page, and the feed's document order:

* **Previous / next** are generated into each page at publish from this order, over the **published subset**: a draft in
  the list is skipped, never linked (a link to a draft is a 404 from a page that otherwise looks right). The first post has
  no previous link and the last no next link: absent, not disabled. Each page also carries `<link rel="prev">` and
  `<link rel="next">` in its head, and the visible controls (`nav.post-nav`, or WordPress's own `nav.post-navigation` under
  the `wordpress-classic` contract). "Previous" is the one before in the sequence, so in a newest-first blog it is the
  newer post.
* **`index/posts.json`** records the resolved sequence, not just the setting:
  `{ "version": 2, "generator", "order": { the resolved setting }, "sequence": ["slug", …], "posts": [ … in that order ] }`.
  The editor, the `/blog/` reader and the live renderer read `sequence` and **never sort for themselves**, so no two sorters
  can disagree and the window before a build settles never shows a different order from the one that settles.
* **A reader's sort is not the blog's order.** The post list in the editor and in `/blog/` has a *Sort* control (blog order,
  newest, oldest, title A–Z). It reorders that list for the reader's session and changes nothing else: not the sequence, not
  any page's previous/next, not an address (it adds no query string; and every generated index carries
  `<link rel="canonical">` to the unsorted index, so a sorted address could never be a duplicate page).
* **The feed cannot honour a manual order.** Atom and RSS are date-ordered media: items are written in the sequence's
  document order, but every feed reader **re-sorts by the published date** whatever order they arrive in, so for a course
  the feed's order is simply not the course's order, and there is no fix inside the format. The one honest workaround
  exists because a post's `date` is authored rather than taken from commits: a course that wants its feed in sequence
  sets `date` in sequence. That is a real option, not a repair, since it ties publication dates to curriculum order, which
  the owner should choose deliberately. (The feed's `<updated>` is its newest post's date, whatever the order.)

In Settings, *Post order* edits `by`, `dir`, the field and the list file; only what differs from the default is written.

#### `search`, `pagination`, `seo`

```json
"search": true,
"pagination": { "size": 10 },
"seo": { "twitter": "@ada", "sitemap": true, "robots": true }
```

| Key | Value | If left out |
|---|---|---|
| `search` | `true` adds `search/` and `search.json` (see [Site features](#site-features)) | no search page, no script on any page for it |
| `pagination.size` | a whole number from 1 to 100: posts per page of the index, and of each tag and author page | one list. A list that fits on one page is not split |
| `seo.twitter` | a handle like `@ada`, written as `twitter:site` in link previews | none |
| `seo.sitemap` | `false` stops writing `sitemap.xml` | written |
| `seo.robots` | `false` stops writing `robots.txt` | written, but only when `domain` has no path: a robots file is read only at the root of a host |

Switching `sitemap` or `robots` off stops them being updated; the generator never deletes a `sitemap.xml` or
`robots.txt`, because a blog that turns them off may have written one by hand. A `robots.txt` you wrote yourself
is replaced while `robots` is on: set it to `false` to keep yours.

#### `comments`, `analytics`

```json
"comments":  { "src": "https://comments.example/client.js", "attrs": { "data-repo": "me/blog" }, "title": "Discussion" },
"analytics": { "src": "https://stats.example/count.js", "attrs": { "data-domain": "blog.example" } }
```

| Key | Value |
|---|---|
| `src` | an `https` address of a script. Required |
| `attrs` | up to 16 attributes: `data-*`, `crossorigin`, `integrity`, `referrerpolicy`, `nonce`; each value is text of at most 300 characters. Nothing else is allowed: no `onload`, no inline code |
| `title` | `comments` only: the label of the comments region (default "Comments") |

`comments` places `<section class="comments"><script src=… async …></script></section>` under every post, where a
comments widget inserts itself (a GitHub-Discussions widget fits; the generator names no provider). `analytics`
places `<script src=… defer …></script>` at the end of every page. Both are off unless you set them.

**These are the one place a page runs someone else's code.** The script has the page's full powers on your
readers' browsers, and the reader's browser contacts that service. Name only a service you trust, and give an
`integrity` value to pin the exact bytes. Nothing in the editor, the generator or the `/blog/` reader loads them:
only the generated pages do.

#### `subscribe`

```json
"subscribe": { "action": "https://news.example/subscribe", "field": "email", "hidden": { "list": "abc" },
               "title": "Subscribe by email", "button": "Subscribe", "placeholder": "you@example.com" }
```

A plain HTML form (`method="post"`) at the end of every post and of the home page. It works with scripting off, and the
address a reader types goes from their browser straight to `action`, never through this site. `action` (an `https`
address) is required; `field` is the name of the email field (default `email`); `hidden` holds up to eight extra
fields your provider asks for. The feed (`feed.xml`) is always there as the other way to subscribe.

In Settings these are the *Readers*, *Search engines* and *Comments and analytics* sections.

#### Pinned themes and extensions

A theme or extension is `{ repo, ref, sha256, name, version, licence }` where `ref` is a release tag or a
commit (a branch is refused) and `sha256` covers its files. A theme may also carry `contract`
(`blog-webcli-v1` or `wordpress-classic`: which markup it styles) and `base` (an `https` template with `{ref}` and
`{path}` to fetch from; default `https://cdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path}`). An extension may
carry `kind` (`build`, or `embed` which frames only the pinned assets it declares) and `hooks`
(`post:markdown`, `post:html`, `index:html`). Use the Themes and Extensions screens or
`blog-webcli theme pin` / `ext add` rather than writing these by hand: they compute the hash. See
[Pinning](#pinning).

#### Defaults

| Setting | Applies when | Value |
|---|---|---|
| images | `assets` is absent and `repo` is set | `<repo>/images` (a blog at `me/site/blog` gives `me/site/images`), CDN `https://cdn.jsdelivr.net/gh/{owner}/{repo}@{sha}/{path}` |
| videos | `video` is absent and `repo` is set | `<repo>/videos`, player `https://strataeditor.dev/player/`, CDN `https://cdn.jsdelivr.net/gh/{owner}/{repo}@{tag}/{slug}/` |
| theme | `theme` is absent | the built-in `default` (GPL-3.0-only, recorded in `licences.json`) |
| `content.ref` | `content` has no `ref` | `HEAD` |
| address | creating a blog | GitHub Pages' own answer; `https://<owner>.github.io/<repo>` until it is on |

A default is **not written into `blog.json`**; it is used only while the section is absent, so an author who
enters nothing keeps a `blog.json` that says nothing, and an author who writes a section keeps exactly what they wrote.

#### Editing it

* **In the editor:** *Settings* edits the title, description, author, media repositories and their URL templates,
  `content`, `order`, the reader features (`search`, `pagination`, `subscribe`, `seo`, `comments`, `analytics`) and `customize`.
  `domain` is shown read-only, the theme and extensions have their own screens, and
  `repo`, `cover` and any key it does not know are edited by hand (they are carried through untouched). *Save settings…* shows the usual pre-flight and commits `blog.json` together with every
  regenerated page, in one commit. Keys the form does not know are carried through; blank fields are removed.
* **By hand or in CI:** edit the file, then `node cli/blog.js build` and commit; `check` fails the build when the
  committed pages differ from what `blog.json` would generate.

### Post frontmatter

```
---
slug: static-hls-in-git
title: Static HLS in git
date: 2026-11-05
status: published
author: Ada Example
tags: [video, git]
cover: asset:images/hls-cover.png
description: Optional; defaults to the first paragraph.
---
```

| Key | Required | Value |
|---|---|---|
| `slug` | yes | lowercase letters, digits and single hyphens; must equal the file name; set once and never changed (it is the URL). `posts`, `pages`, `index`, `feed`, `assets`, `static`, `node_modules`, `p`, `tags`, `authors`, `archive`, `search` and `page` are reserved, as is the first folder of any media folder inside the blog |
| `title` | yes | text; change it freely |
| `date` | yes | a real `YYYY-MM-DD`; posts are ordered by it, not by commit time |
| `status` | yes | `draft` (in no index, page, feed, sitemap or search) or `published` |
| `author` | no | text; the blog's `author` if left out. With more than one distinct author the byline links to an author page |
| `tags` | no | a list of non-empty text, `[a, b]` or one `- item` per line. Each tag of a published post has a page |
| `cover` | no | an `asset:` reference, or `auto` (first image, else first video's poster, else the blog `cover`) |
| `description` | no | text; the first paragraph if left out. Also the `<meta name="description">` and `og:description` |
| `seo_title` | no | text; the page `<title>` and `og:title`, instead of `Title · Blog` |
| `image` | no | an `asset:` reference: the share image (`og:image`), when it should differ from the cover |
| `canonical` | no | an absolute address: for a post first published elsewhere. It becomes `<link rel="canonical">` and `og:url`, and the post is left out of the sitemap |
| `noindex` | no | `true` adds `<meta name="robots" content="noindex">` and leaves the post out of the sitemap; it stays in the index and the feed |

A **standalone page** is `pages/<slug>.md`, for an About or Contact page. It has the same frontmatter except that
`date` is optional and ignored, and it takes no `tags`; it also takes `menu: <0-99>`, which lists it in every
page's header (lowest first; no value, no menu entry). A page is not a post: it is in no index, feed, archive,
tag page or search, and has no previous/next, no comments and no subscribe form. It is in the sitemap. Posts and
pages share one address space (`slug-collision` for a repeat). Pages are not drawn early by the live script
(see [Known limits](#known-limits)).

Frontmatter is a small YAML subset (scalars, inline and block lists, comments). Edits touch one key at a time,
so a round trip never rewrites what you wrote.

### Where the browser keeps things

The editor stores only these, in the browser it runs in: the fine-grained token
(`blog.webcli.token`, in `sessionStorage` for the tab, or `localStorage` if you tick *Remember*); a list of the
times of your recent publishes per repository (`blog.webcli.builds:<repo>`, `localStorage`, used for the Pages
build-limit warning); and nothing else. A published blog's pages keep one `sessionStorage` flag per page
(`webcli-checked:…`) so a page checks the live copy once per session. See [Token permissions](#token-permissions) for what the
token needs.

## Settings screen

Signed in, open your blog and press **Settings** (`#repo=owner/repo[/folder]&settings`). It edits
`blog.json` without hand-editing JSON: general info, media repositories (and the CDN/player URL
templates), colours with light and dark values, fonts, width and text size, post list layout,
header logo and links, footer text and links, and custom CSS; and the reader features: search, posts per page,
the email subscribe form, the Twitter handle, `sitemap.xml` and `robots.txt`, and the comments and analytics scripts. A **live preview** restyles as you
type (in an isolated shadow root, following your system light/dark setting); a value the validator
refuses shows why and leaves the last good preview in place.

*Save settings…* shows the usual pre-flight and commits `blog.json` together with every
regenerated page in one commit (`Update blog settings`). Posts are never touched. Only what differs
from the defaults is written, blank fields are removed, and keys the form does not know about are
carried through. A header logo must already exist in your images repository; it is pinned when you
save, and a file that does not exist is refused before anything is sent. A post that cannot be
published as it is blocks a settings change, as it would block any publish.

## Customization

`blog.json` takes an optional `customize` section (edit it in the Settings screen above, or by hand). The generated static pages and the `/blog/`
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

## Themes and extensions

A **theme is a repository** of CSS. An **extension is a repository** of code. There is no package
manager, no build step and no registry service: both are named by address and pinned.

> **Extensions run at publish, not at read. Their output is committed.**

The published static HTML depends on no third-party code at read time. A theme's CSS is baked into
every page; an extension's effect lands in the committed output, where it is diffed, reviewed and
reverted like any other change. The reader executes nothing. Something that must run in a reader's
browser is not an extension: it is a *sandboxed embed* (below).

### Pinning

`blog.json` records what it uses, by `{ repo, ref, sha256 }`:

```json
"theme": { "repo": "me/my-theme", "ref": "v1.2.0", "sha256": "…", "name": "My Theme", "version": "1.2.0",
           "licence": "MIT", "contract": "blog-webcli-v1" },
"extensions": [ { "repo": "me/reading-time", "ref": "v1.0.0", "sha256": "…", "name": "Reading time",
                  "version": "1.0.0", "licence": "MIT", "kind": "build", "hooks": ["post:html"] } ]
```

* `ref` is a **release tag** (`v1.2.0`) **or a commit sha. A branch is refused** (`unpinned-ref`): it
  can move and would restyle every page it ever touched. The app also asks GitHub: a name that is a
  branch, or both a tag and a branch, is refused; a tag that does not exist is refused.
* `sha256` covers every file the manifest lists (path and content). Content that does not match is
  refused (`pin-mismatch`), so a moved tag or rewritten repository is caught instead of drifting.
* Name, version, licence (and contract, kind, hooks) are recorded beside the pin so licences are
  visible without fetching anything; they are checked against the manifest on every load.

### A theme repository

```
owner/theme-name[/folder]
├── theme.json        manifest
├── style.css
├── fonts/ img/       optional assets, listed in theme.json "assets"
└── LICENSE
```

```json
{ "name": "…", "version": "1.2.0", "licence": "GPL-2.0-or-later",
  "source": "https://wordpress.org/themes/…", "attribution": "…",
  "css": ["style.css"], "assets": ["fonts/x.woff2"],
  "class_contract": "wordpress-classic",
  "tokens": { "colors": { "primary": "#8a3b12" }, "fontSizes": { "large": "1.5rem" } },
  "dropped": { "php": ["index.php", "functions.php"] } }
```

* **CSS is checked, not trusted.** `url()` may name only the theme's own listed assets (rewritten to
  pinned addresses) or small inline `data:` images and fonts. No `@import`, no foreign URL, no
  `image-set()`, no script hook, no `</style`; escapes and comments are resolved before judging, so
  `u\72l(` does not slip through. The reader re-checks the committed `theme.css` before applying it.
* **`tokens`** (colours, font families and sizes, spacing, lifted from a block theme's `theme.json`)
  become `--wp--preset--*` custom properties, and the conventional colour slugs also set this app's
  own variables. Values are validated.
* Your `customize` settings (colours, width, header, footer, list, CSS) still apply on top of a theme.

### Markup contracts

`class_contract` says which markup the theme's CSS targets, and **the generator emits that markup**:

| Contract | Emits |
|---|---|
| `blog-webcli-v1` | this app's own markup (`.wrap`, `header.site`, `ul.posts`, …) |
| `wordpress-classic` | the de facto classic-theme contract: `#page.site`, `#masthead.site-header`, `.site-title`, `.site-description`, `#site-navigation.primary-navigation` > `ul.menu-wrapper`, `#content.site-content` > `main#main.site-main`, `article.post.hentry.tag-…` with `.entry-header.alignwide`, `.entry-title`, `.entry-meta`, `.entry-content`, `.entry-summary`, `.entry-footer`, `.post-thumbnail`, `#colophon.site-footer`; `body` classes `home blog` / `single single-post postid-N`; content blocks `wp-block-heading`, `wp-block-quote`, `wp-block-code`, `wp-block-list`, `wp-block-image`, `wp-block-embed` |

The static pages and the `/blog/` reader build their `<body>` from the same code, so a theme styles
both identically. Post ids (`post-N`) derive from the slug, so adding a post renumbers nothing.
Not emitted (there is nothing behind them): comments, search, sidebars/widgets, pagination, category
and author archives, the mobile menu button.

### Ingesting a WordPress theme

```
node cli/blog.js theme import twentytwentyone ./my-theme-repo
```

A classic theme is not just `style.css`: PHP templates do the structure. What transfers is the CSS
and the markup contract; the PHP templates, `functions.php` and JavaScript are **not converted** and
the manifest lists them under `dropped`, so the conversion is honest about being partial.

* **Directory themes only.** The slug must be a theme in the wordpress.org directory, where GPL
  compatibility *including assets* is a listing requirement (`not-in-directory` otherwise).
* The licence comes from `style.css` and must be in the GPL family (`GPL-2.0-or-later`, …). No
  declared licence is `no-licence`; any other licence is `bad-licence`.
* **Split-licensing language is refused, not adjudicated.** If `style.css`, `readme.txt` or
  `README.md` talk about assets licensed separately, commercial or proprietary terms, ThemeForest /
  Envato licences and the like, the theme is refused (`bad-licence`). This is a conservative
  heuristic; compatible third-party credits (MIT, CC0, SIL OFL) do not trigger it.
* Records `source`, `licence`, `attribution`, upstream `version`, the archive's sha256 and what was
  dropped. The result is proven to load under this app's own CSS rules before anything is written.
* Tokens are lifted from a block theme's `theme.json` palette, font families, font sizes and spacing.

Commit the folder to a repository, tag a release, then `node cli/blog.js theme pin owner/repo@v2.9.0`
(or use the **Theme** screen). A GPL theme repository beside this MIT tool is coherent: the licences
stay in their own repositories and neither infects the other. *Tried for real* on
`twentytwentyone` 2.9: GPL-2.0-or-later detected, 48 PHP files, 12 scripts and 9 other CSS files
recorded as dropped, and all 25 core classes its CSS styles are emitted by the generator, so the
unmodified theme styles a generated page.

### An extension repository

```
owner/ext-name[/folder]
├── extension.json
├── index.mjs
└── LICENSE
```

```json
{ "name": "Reading time", "version": "1.0.0", "licence": "MIT", "kind": "build",
  "hooks": ["post:html"], "capabilities": [], "pinned_assets": [] }
```

```js
// index.mjs — a pure function over data
export const hooks = {
  'post:html'(html, ctx) { return `<p class="reading-time">…</p>${html}`; },   // ctx: { slug, title, date, tags }
};
```

Hooks are `post:markdown` (markdown → markdown), `post:html` (the post body's HTML) and
`index:html` (the post list). There are **no capabilities**: `capabilities` must be empty, because
none is defined, so none can be granted. An example is in [examples/ext-reading-time/](examples/ext-reading-time).

**Build extensions** run in a sandbox at publish:

* a **Web Worker** (no DOM),
* inside an iframe with **`sandbox="allow-scripts"` and no `allow-same-origin`** (an opaque origin:
  no storage, no cookies, no reach into the editor or its token),
* under a CSP with **`connect-src 'none'`** that the Worker inherits (no network), *and* with every
  network and storage API removed from the Worker's global scope and prototype chain (two
  independent layers; each is tested alone),
* handed only `{ source, hook, input, ctx }` as data, never a token or a URL,
* with a **hard time limit**: an extension that does not return is destroyed, not waited for.

**Output is data.** The sandbox's result is committed as `extension-outputs.json`, keyed by the
extension's digest, the hook, the post context and the input. The generator, the CLI and CI
regenerate from that file alone and **never execute extension code**. If an output is missing (a
post changed, an extension was added) the build refuses with `extension-output-missing`; publish
from the editor, which runs only what is new. HTML output is rebuilt from an allow-list before it
reaches a page: `<script>`, event handlers, `javascript:` URLs, `<style>`, forms and unknown iframes
are *refused* (`unsafe-extension-output`), not silently stripped. Our own video embeds are hidden
from extensions behind placeholders.

**Embeds.** A reader-side widget is not an extension; it is a **sandboxed embed**. An extension
with `"kind": "embed"` declares the pages it may frame under `pinned_assets` (`{ url, sha256 }`; the
URL must name a tag or commit, never a branch, and its hash is checked when the extension is
pinned). It may emit only `<iframe src="<a pinned asset>" sandbox="allow-scripts">`, and
`allow-same-origin` (or any other sandbox token) is refused. With `allow-scripts` alone the frame
has an opaque origin: no access to the parent's storage, cookies or token; communication would be
`postMessage` over an API the embed documents, or nothing. This is the same reasoning that made
`/blog/` a separate token-free reader. Our own video embed uses the same attribute; the real hls
player was checked to run unchanged under it.

### Licences

* **No declared licence is a refusal**, not a warning, for themes, extensions and the pins in
  `blog.json` (`no-licence`; an unusable value such as `none` or `proprietary` is `bad-licence`).
* Licences are recorded in `blog.json`, in `licences.json` (generated), as a comment in every
  generated page, and shown in the app (**Settings → Licences**, and in the pre-flight of every
  change that adds one). `node cli/blog.js licences` prints the set.

### Discovery without a registry

[themes.json](themes.json) and [extensions.json](extensions.json) are lists in this repository,
curated by pull request (name, repo, ref, licence, description, screenshot) and rendered by the
**Theme** and **Extensions** screens under the heading **Built in**. There is no service, database
or account, and anyone can publish a theme by publishing a repository. If nobody merges the pull
request, the theme still works by its address (`owner/repo[/folder]@tag`); the list is a
convenience, not a gate.

**Built in** is what the two companion repositories publish. Each folder is a complete theme or
extension, pinned by the hash of its own files, and every list entry names the tag `v1.0.0`:

| Repository | Folders |
|---|---|
| [blog-webCLI-themes](https://github.com/tejaswigowda/blog-webCLI-themes) | `essay`, `terminal`, `paper`, `cards` (MIT, `blog-webcli-v1`) and `wp/twentytwentyone` (GPL-2.0-or-later, `wordpress-classic`) |
| [blog-webCLI-extensions](https://github.com/tejaswigowda/blog-webCLI-extensions) | `reading-time`, `heading-anchors`, `table-of-contents`, `smart-typography`, `archive-by-year`, `image-captions` (MIT, all build extensions with no capabilities) |

```
node cli/blog.js theme pin tejaswigowda/blog-webCLI-themes/essay@v1.0.0
node cli/blog.js ext add   tejaswigowda/blog-webCLI-extensions/heading-anchors@v1.0.0
```

[test/builtin.test.js](test/builtin.test.js) checks the real folders against this app: each theme
and extension loads and pins under these rules and builds a real blog; every folder is listed and
every entry matches its manifest, its licence and a tag that exists; every class a `blog-webcli-v1`
theme styles is one the generator emits; the extensions run together, deterministically and from
their recorded outputs. It looks for the repositories next to this one (set `BLOG_WEBCLI_THEMES`
and `BLOG_WEBCLI_EXTENSIONS` to point elsewhere) and skips when they are absent.

## Assets

Posts name `asset:<key>/<path>`, never a provider. `blog.json` maps keys to repos and
holds the URL template; `assets.lock.json` pins each referenced file to a commit sha.

**Enter nothing and the blog's own repository is used.** With no `assets` in `blog.json`, images are
read from and committed to an `images/` folder of the blog's repository (`blog.json`'s `repo`, so
`me/blog` gives `me/blog/images`, and a blog at `me/site/blog` gives `me/site/images`); with no
`video`, videos come from a `videos/` folder the same way. Settings shows those fields blank, with
the default as the placeholder. The default is **not written into `blog.json`**: it is only used
when nothing is there, so setting an images repository later is a plain edit, and changing it later
changes every blog that never entered one. It applies only when the section is absent (an author who
wrote `assets` keeps exactly what they wrote), never to the blog's own place, and only when
`blog.json` has a `repo`. A default folder does not reserve a slug (a post called `images` is fine);
a folder you configure still does. For a different repository, enter it in **Settings → Images
repository** (`me/images`).

A `blog.json` with no `repo` has no default. Choosing an image then says so and links to Settings in
a new tab, so the post being written is not lost; the next attempt re-reads `blog.json`, so no reload
is needed.

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

With no `video` section, the repository is a `videos/` folder of the blog's own repository (see
[Assets](#assets)). hls.webcli.app publishes to the *root* of the repository it is pointed at, so for
the default the release has to be placed under `videos/<name>/` (tagged `<name>/vN`); to use renders
published at a repository's root, set the video repository to that repository.

In a shared repository the release lives under the video folder (`…@clip/v3/<folder>/clip/`);
tags are per repository, so `clip/v3` is checked at `me/site` whatever the folder. hls.webcli.app
itself writes at the repository root, so use a folder for video only if you place the release there.

Generated pages get a sandboxed `<iframe>` at `<player>#<base>&present=true` (the *Copy embed
link* address) plus a plain "Watch" link inside the figure for readers without scripting. The
editor's video button opens **Embed a video** (below). Publishing a post refuses
a reference to a tag that does not exist (`unresolved-asset`); a draft may name one not yet
published. `node cli/blog.js pin` verifies tags too. Changing player or CDN is a `blog.json`
edit and a rebuild; no post is touched, and a post naming the player or CDN address is refused
(`provider-url`).

### Uploading a video

In the editor, the video button opens **Embed a video**: a **searchable dropdown of the videos in the
video repository with the Embed button beside it**. Type to filter (any order, case-insensitive,
by name, version or repository); the arrow keys move, Enter chooses, Enter again embeds, Esc closes
the list. The chosen video's poster is shown below. There is no "create a release" step: a release
(a folder of HLS and a tag that never moves) is made for you, in one of two ways.

* **Upload a video…** takes an MP4 or MOV and does everything: it is encoded **in your browser** into
  an HLS ladder, published as a release in the video repository, and embedded in the post.
* **A render folder that is already in the repository** (a folder holding a `master.m3u8` with no tag
  yet, for example one you pushed from hls.webcli.app's download) is listed in the dropdown as *not
  published yet*. Choosing it changes the button to **Publish and embed**: you get the usual review
  (*Tag clip/v1 on github.com/me/blog (main) … nothing is uploaded*), the tag is created, and the
  video is embedded. Videos published with hls.webcli.app appear in the dropdown by themselves.

1. Pick the file. It is read in the page and inspected first, so a video that cannot be packaged is
   refused at once with the reason (`not-mp4`, `fragmented-input`, `no-video`, `unsupported-codec`,
   `rotated-input`, `unknown-frame-rate`, `vfr-input`, `fractional-frame-rate`, `no-keyframes`):
   H.264 at a steady 24, 25, 30, 50 or 60 fps, with a keyframe to start from.
2. See what it is (size, frame rate, length, audio) and choose: the release name (from the file name,
   under hls.webcli.app's naming rules), **every rung that fits the source** (1080p, 720p, 480p; never
   upscaled, and a smaller source gets one rung at its own size), and whether to keep the audio. The
   estimate of what it adds to the repository follows your choices (a full ladder is about 46 MB a
   minute, so untick rungs for a long video); a release may hold at most 300 MB.
3. **Encode and review…** runs the encoder with a progress bar and a cancel button. Nothing is sent.
4. The review is the usual pre-flight: *"N files, X MB, to github.com/me/blog (main) in videos/<name>/
   as <name>/v1"*, the file list, and what was encoded. **Commit and push** sends one commit and then
   the tag, with progress by file and a wait-and-retry if GitHub rate-limits the many writes.
5. The release is embedded in the post.

The encoder is **hls-webCLI's, vendored unedited** in [vendor/hls/](vendor/hls) (Strata's own export
modules: WebCodecs ladder, fragmented-MP4 segmenter, playlists, `render.json`, `files.sha256`), so a
render made here is the one hls.webcli.app would make. [vendor/hls/SOURCES.json](vendor/hls/SOURCES.json)
records the hash of every file and `test/vendored.test.js` fails if one is edited. It needs a browser
with WebCodecs (recent Chrome, Edge or Safari); without one the dialog says so. Videos made with
hls.webcli.app and published there still appear in the dropdown. The upload says what it is: its `render.json` records
`determinism.frames: false`, because an uploaded file was not drawn by Strata's time-source-audited
renderer. The video repository is, by default, a `videos/` folder of the blog's repository; for a
shared repository `render.json`'s publication block names the repository, not the folder, so
hls.webcli.app's *Verify* would not find a release that lives in a subfolder.

Whatever the route, a release is checked before anything is sent, and refused with `bad-release` if
it is not one: a name that is not lowercase words joined by `-`; no `master.m3u8`; a file that is not
a playlist, segment, caption, poster, image or manifest; unsafe paths; a playlist that names anything
outside the release (an absolute URL, a leading `/`, `..`: a release that depends on another host is
the lock-in this app avoids); a `files.sha256` that does not match the files; more than 2000 files,
50 MB a file or 300 MB in all. A tag is never moved: if it exists by the time the commit is made,
nothing is tagged. If the commit lands but the tag fails, the message says so, and the folder then
shows in the dropdown as *not published yet*: choosing it tags it, which is the retry. Writing needs
the token to cover the video repository (see Token permissions); the CDN can take a few minutes to
serve a new tag, so the player may not load a just-published video straight away. Tested in
[test/release.test.js](test/release.test.js), [test/encode.test.js](test/encode.test.js) and, in a real
browser, [test/e2e/release.e2e.mjs](test/e2e/release.e2e.mjs) and
[test/e2e/upload-video.e2e.mjs](test/e2e/upload-video.e2e.mjs).

## Site features

Everything below is generated at publish, from the posts, as plain files. Nothing needs a server, and a page
needs no script unless a feature below says so.

**Tags.** Each tag of a published post has `tags/<tag>/` listing its posts in the blog's own order, and `tags/` lists
the tags with their counts. Tags are shown as links wherever a post is listed or shown. A tag's address is its
lowercase letters and digits with hyphens (`Static HLS` → `static-hls`); two tags that share one (`C++` and `c`)
share a page. A tag that only drafts use has no page.

**Archive.** `archive/` lists every published post by year, newest first, by authored date, whatever order the blog
itself is in.

**Authors.** With more than one distinct author across the posts, each has `authors/<name>/` and the byline links
to it. A blog with one author has none, since it would repeat the index.

**Pagination.** With `pagination.size`, the index is `index.html` plus `page/2/`, `page/3/`, …, and each tag and
author page pages the same way under its own folder (`tags/video/page/2/`). Pages carry `<link rel="prev">` and
`<link rel="next">` and a "Previous page / Page 2 of 5 / Next page" row; the ends have no link, not a disabled one.
`index/posts.json`, the feed and the `/blog/` reader are never paginated: they are the whole blog.

**Search.** With `"search": true`, `search/` has a box, and `search.json` has the title, date, tags, excerpt and the
first 20 000 characters of text of every published post. The one script on that page (`webcli-search.js`, built by
`node cli/build-live.js` from [lib/search-client.js](lib/search-client.js)) fetches that file from the same origin and
matches in the reader's browser: nothing is sent anywhere, and results are drawn as text, never markup. Every term must match;
a term in the title counts most, then tags, excerpt, body; ties keep the blog's order. `search/?q=…` works as a link.
Without scripting the page says so and points at the archive. The search page is `noindex` and not in the sitemap. The
index is as of the last build, not the live copy.

**Sitemap and robots.** `sitemap.xml` lists the home page, posts (with their authored dates), pages, the archive and
the tag and author pages, in a fixed order. A post with `noindex`, or with a `canonical` address that is not its own, is
left out. `robots.txt` (`Allow: /` and the sitemap) is written only where the blog is at the root of a host.

**Structured data and previews.** Every post has JSON-LD (`BlogPosting`), every standalone page `WebPage`, the home
page `WebSite` (with a `SearchAction` when search is on): a `<script type="application/ld+json">`, which is data and
runs nothing. Every page has the Open Graph and Twitter tags; the [frontmatter](#post-frontmatter) can set the search title,
share image, canonical address and `noindex` per post.

**Header menu.** Every page's header lists, after your own `customize.header.links`: pages with a `menu` position,
*Archive*, *Tags* (when any post has a tag), *Search* (when on), and *Feed*.

**Comments, analytics, subscribe.** [Opt-in](#comments-analytics) embeds you point at an address; see above.

**Standalone pages.** `pages/<slug>.md`: see [Post frontmatter](#post-frontmatter). The editor lists them under
*Pages* on the blog's start screen, and *New page* opens the same editor without date, tags or author.

**Removed with the feature.** When you turn search or pagination off, or a tag loses its last post, the files that
feature wrote are deleted in the same commit (the editor's pre-flight lists them) and `blog-webcli build` removes
them (`check` reports them as stale). The folders `tags/`, `authors/`, `archive/`, `page/` and `search/` belong to the
generator: do not keep your own files in them.

Because the generator is one pure module, the browser's live renderer (see [Publish latency](#publish-latency-not-waiting-for-github-pages))
builds a post with the same header, tag links, comments and subscribe form as the build will: it reads the tags, authors and
pages from `index/posts.json`, which records them, and a test holds the two byte-identical.

## Publish latency: not waiting for GitHub Pages

A GitHub Pages deploy takes from about twenty seconds to several minutes after a push, and there is no way
to skip it. Two things are slow: the build itself (the author waits) and the CDN cache after it (a returning
reader waits). The generated HTML exists for crawlers and link previews, which do not mind. People do. So a
blog can serve people from the repository itself until the build catches up. It is off until `blog.json` says
where the repository's live copy is read from (Settings → *Publishing speed*, on by default for a new blog):

```json
"content": { "base": "https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}", "ref": "HEAD" }
```

A template that ends in `/{path}`; no host is named anywhere else, so moving it is a settings change and a
regeneration. With it, the generator adds to every page what it was built from
(`x-generator` = `blog-webcli@<version>`, `x-content-sha256` = the digest of the post's markdown, `x-content-base`),
one same-origin script, `webcli-live.js`, and a `404.html`. The script is the generator's own renderer,
bundled (`npm run build:live` writes [lib/live-source.js](lib/live-source.js); CI fails if it is stale), so
there is one implementation, not two.

* **A post that exists** (`lib/live.js`, *checkPage*): the page asks the live copy for its own markdown, hashes it
  and compares. Equal: nothing happens. Different: the page is rebuilt in place, silently, with the same code
  the next build runs (a test holds the two byte-identical for every post in the corpus, with a pinned theme and
  an extension too). One file request, no API, no credentials, once per page per session.
* **A post that has no page yet** (`404.html`): GitHub Pages answers an unknown path with the site's own 404 page
  and its script runs. It reads the live `index/posts.json`; a slug that is published there and whose file
  says `status: published` is fetched and drawn at its address, with `<meta name="robots" content="noindex">`
  (the HTTP status is still 404). A draft is never drawn: it is not in the index, and the file is checked too.
* **The cache.** Reading a file "freshly" is harder than it sounds: GitHub's raw host keeps a copy for five
  minutes and **ignores both a `?t=` query and a `Cache-Control: no-cache` request header** (verified; the
  query is kept anyway for hosts that honour it). What it does key on is the exact path, and `posts/x.md`
  and `%70osts/x.md` are the same file under RFC 3986. So each request spells its path with a random choice of
  percent-encoded letters (`varyPath`), which reads from the origin almost every time. A request that happens
  to repeat a recent spelling is as stale as that cache, never staler.
* **A page and its script from different builds**: recorded in `data-webcli-versions` on `<html>` and in the
  console. A script older than the page that loaded it rebuilds nothing.
* **The editor** polls `GET /repos/{owner}/{repo}/pages/builds/latest` after a publish and shows *committed →
  building → live (0:34)*, withholds **Copy link** until GitHub says the build is live, and shows a failed
  build's own error. (It needs the token's *Pages: Read-only*; without it the panel says so and offers no link.)
* **The build limit.** Pages builds about ten times an hour and then quietly stops. The editor counts its own
  publishes in the trailing hour and warns in the pre-flight from the one that would be the eighth, and says
  plainly at ten. For a blog that renders fresh content itself, the warning adds that readers still see
  what was published.

What this does not do: link previews (Slack, iMessage, social cards) and search engines read the static HTML
with no JavaScript, so they wait for the build; the editor says so. The *index* page is not refreshed
(a new post is reachable by its own address, not yet listed). A blog in a **folder** of a repository gets the
checks but no `404.html` (the repository's 404 page is not the folder's to write), so a brand-new post still
waits for the build there. A blog that uses an *embed* extension keeps its pages as built (the frames it may
show are not recorded in `blog.json`). A page has no `x-source-commit`: it is committed together with its source,
so the commit that holds it cannot be named inside it.

## CLI

```
node cli/blog.js build [dir]   regenerate index, pages, tags, archive, search, sitemap, feed (writes nothing if anything is refused)
node cli/blog.js check [dir]   regenerate in memory; non-zero on any difference — for CI
node cli/blog.js fmt   [dir]   rewrite posts into canonical markdown
node cli/blog.js pin   [dir]   pin unpinned asset: references, verify video: release tags (GitHub API, $GITHUB_TOKEN optional)
node cli/blog.js theme pin owner/repo[/folder]@ref [dir]   pin a theme (a tag or commit; a branch is refused)
node cli/blog.js theme clear [dir]                         back to the default theme
node cli/blog.js theme import <wordpress-slug> [outdir]    ingest a wordpress.org directory theme
node cli/blog.js ext add owner/repo[/folder]@ref [dir]     pin an extension (fetched as data and hashed; never run)
node cli/blog.js ext remove owner/repo [dir]
node cli/blog.js licences [dir]                            every licence the blog depends on
node cli/blog.js import wp <export.xml | https://site> [dir] --repo owner/name[/folder]   a WordPress blog as files (see Importing from WordPress)
node cli/serve.js [dir] [port] static server for local preview
```

`build` and `check` read `order.json` (the file `blog.json`'s `order.list` names) when the blog is ordered by hand, and print
the build's warnings, including the posts that are in no list. They read `posts/` and `pages/`, and `build` removes what a feature
that is now off left behind (`check` lists it as `stale`). They fetch a pinned theme (as data) to regenerate; they **never execute extension
code**, they use the recorded `extension-outputs.json`. `node cli/build-live.js` rebuilds the two scripts a page can load
(`lib/live-source.js`, `lib/search-source.js`) after any change under `lib/`; CI runs it with `--check`.

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
| Pages | Read-only | optional: lets the app read the blog's real address (a custom domain) from GitHub Pages. Without it the address is the convention or what `blog.json` says. |
| Metadata | Read-only | added automatically |

Token settings:

* **Repository access: Only select repositories.** List the blog repository, any images
  repository and any video repository. A repository that is not listed answers 404 or 403.
* **Resource owner:** the account or organization that owns those repositories (an organization
  may need an admin to approve the token).
* **Expiration:** keep it short, since the token can sit in `localStorage` if you tick "remember".
* Not needed: Workflows (the app never writes `.github/workflows`), Administration (it never
  creates repositories), or anything account-wide.

Permissions apply to every repository you select; they cannot differ per repository. Reading the
video repository (listing and checking release tags) needs nothing extra, but **creating a release
from the editor writes there** (a commit and a tag), so a token used for that must include the video
repository, with Contents read and write like the others. hls.webcli.app uses its own token.

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
* The page has a strict CSP (scripts only from this origin; it may read `https:` addresses only so the WordPress import can fetch
  pictures, see [Importing from WordPress](#importing-from-wordpress)) and never inserts blog content except through the escaping
  renderer, because blog content is untrusted and shares an origin with the token.
* **Egress ledger** (footer): *uploaded* is a count of non-GET request bytes and reads 0
  until you publish; *read* covers listing and rendering. Before sending, a pre-flight
  states the act — *4 files, 1.2 MB, to github.com/me/blog (main)* — and a receipt with the
  commit follows. Images are uploaded to their own repo first; that commit becomes the pin.
* **Progress and results**: work that takes longer than a moment (building the pre-flight,
  committing, running an extension, listing videos) shows a spinner at the top of the page and
  marks the button you pressed. Outcomes arrive as toasts at the bottom right: a success toast
  links the commit or pull request; "nothing to change" is a quiet note; an error names the
  refusal code (or "Something went wrong") and stays until you dismiss it. While a dialog is
  open the toasts appear inside it, so they can still be read and closed. Problems with a form
  field, and a page that cannot load, stay where they are, next to what they are about.
* **Corrections**: "Suggest a correction" opens the editor on the post body (or, for a standalone page, `#…&correctpage=slug`); submitting opens
  a pull request on a new branch (default branch untouched). Without write access the app
  links to GitHub's own fork-and-edit page.
* **The editor**: *New post* and *New page* open the same editor (Quill, restricted to what markdown can express). A post
  has title, slug, cover, description, date, tags, author and status; a page has a menu position instead of date, tags and
  author. *Search and sharing* (collapsed) holds the search title, share image, canonical address and `noindex`. *Pages* on
  the blog's start screen lists the standalone pages. *Settings* has the live preview in the form column and the colours in the side panel with the theme box;
  on a wide screen the side panel scrolls with the page.

## Refusals

`no-blog-json` · `bad-blog-json` · `missing-frontmatter` · `bad-frontmatter` · `slug-mismatch` ·
`slug-collision` · `unresolved-asset` · `provider-url` · `unsafe-url` · `lossy-round-trip` ·
`draft-in-publish` · `classic-token` · `unpinned-ref` · `pin-mismatch` · `bad-theme` · `bad-extension` ·
`no-licence` · `bad-licence` · `not-in-directory` · `extension-output-missing` · `extension-failed` ·
`unsafe-extension-output` · `bad-release` · `unknown-slug-in-order` · `duplicate-slug-in-order` · `bad-order-list` ·
`missing-order-field` · `mixed-order-field-types` · `bad-order-field` · `bad-wp-export` · `bad-wp-site` · `import-refused`. A build that is refused writes nothing.

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
| X1 no third-party code executes when reading a published blog | `test/x1.test.js`, `test/live.test.js` (a page has no executable script, event handler or foreign stylesheet; JSON-LD is data and is the one script type allowed besides the one same-origin module the live script and the search page add; import-graph scan of the reader and generator for evaluators, Workers and dynamic import; CSPs), `test/e2e/themes.e2e.mjs` (the reader contacts neither the theme nor the extension repository). The opt-in comments and analytics scripts are the stated exception, off by default |
| X2 build extensions run in a Worker with no DOM, no network, no credentials | `test/e2e/sandbox.e2e.mjs` (real Chrome: hostile extensions, an attacker server that must see nothing, the frame CSP alone, a runaway loop killed) |
| X3 embeds are `sandbox="allow-scripts"` without `allow-same-origin` | `test/packs.test.js` (sanitizer), `test/packs-app.test.js`, `test/x1.test.js` |
| X4 themes and extensions pinned by ref and hash; a branch is refused | `test/packs.test.js`, `test/packs-app.test.js`, `test/cli-packs.test.js` |
| X5 no declared licence is refused | `test/packs.test.js`, `test/packs-app.test.js`, `test/wp-import.test.js` |
| X6 WordPress ingestion: directory only; records source, licence, what was dropped | `test/wp-import.test.js` (and a real import of `twentytwentyone`) |
| X7 `class_contract` changes the emitted markup; a classic theme styles a generated page unmodified | `test/packs.test.js`, `test/packs-app.test.js` |
| X8 every licence a blog depends on is visible in one place | `test/packs.test.js`, `test/e2e/themes.e2e.mjs` |
| O1 `order` is read from `blog.json`; absent, it is `date desc`, unchanged | `test/order.test.js` |
| O2 manual order lives in one list; no post carries a position | `test/order.test.js` |
| O3 the tiebreak is the slug in every mode; regenerating (in any input order) is byte-identical | `test/order.test.js` |
| O4 prev/next follows the order over the published subset; drafts skipped; ends absent | `test/order.test.js`, `test/e2e/order.e2e.mjs` |
| O5 the index carries the resolved sequence; the client consumes it and never sorts | `test/order.test.js` |
| O6 a reader sort changes no URL and no prev/next; the index has a canonical | `test/order.test.js`, `test/e2e/order.e2e.mjs` |
| O7 an unknown or duplicated slug in the list is refused | `test/order.test.js` |
| O8 mixed-type frontmatter order values are refused, not coerced | `test/order.test.js` |
| O9 a published post missing from the manual list is appended by date and reported | `test/order.test.js`, `test/e2e/order.e2e.mjs` (the pre-flight) |
| O10 the feed's inability to carry manual order is documented in the schema | `test/order.test.js` (the README section) |
| L1 an edited post shows current content within one page load, no build wait | `test/live.test.js`, `test/e2e/live.e2e.mjs` (real Chrome) |
| L2 a new post renders at its final URL before the build, via `404.html` | `test/live.test.js`, `test/e2e/live.e2e.mjs` |
| L3 a draft never soft-renders, at its URL or in the index | `test/live.test.js`, `test/e2e/live.e2e.mjs` |
| L4 soft-rendered pages carry `noindex` | `test/live.test.js`, `test/e2e/live.e2e.mjs` |
| L5 generator and client render are byte-identical for every corpus post | `test/live.test.js`, `cli/build-live.js --check` |
| L6 the freshness check makes no authenticated or API call | `test/live.test.js`, `test/e2e/live.e2e.mjs` (the content host's own request log) |
| L7 one check per page per session | `test/live.test.js`, `test/e2e/live.e2e.mjs` (ten-page browse, then again) |
| L8 the editor shows committed / building / live / failed and withholds Copy link until live | `test/deploy.test.js`, `test/e2e/deploy.e2e.mjs` |
| L9 no provider hostname built into the generator or script; the content base is `blog.json`'s | `test/live.test.js` |
| L10 the build-rate warning fires before the limit | `test/deploy.test.js`, `test/e2e/deploy.e2e.mjs` |
| X9 a theme repository with no entry in any list works by address | `test/packs-app.test.js`, `test/cli-packs.test.js` |
| S1 tag, author and archive pages exist for published posts only, in the blog's order, with links that resolve | `test/features.test.js`, `test/e2e/features.e2e.mjs` |
| S2 `sitemap.xml` lists published, indexable pages in a fixed order; `robots.txt` only at the root of a host; both switchable | `test/features.test.js` |
| S3 pagination: absent, unchanged; present, previous/next that exist, canonical per page, the index and feed whole | `test/features.test.js`, `test/e2e/features.e2e.mjs` |
| S4 search runs in the browser against `search.json`, writes results as text, loads one same-origin script on one page | `test/features.test.js` (ranking, files), `test/e2e/features.e2e.mjs` (real Chrome: a hostile post, the request log) |
| S5 JSON-LD cannot end its `<script>`; `seo_title`, `image`, `canonical`, `noindex` each do exactly what they say | `test/features.test.js` |
| S6 comments, analytics and the subscribe form are off by default and, when named, are exactly the address and attributes `blog.json` gives | `test/features.test.js` |
| S7 standalone pages: no date or tags, in the menu by position, in no index, feed or search; drafts invisible; one address space | `test/features.test.js`, `test/features-app.test.js`, `test/e2e/features.e2e.mjs` |
| S8 every feature on, the live renderer's post is byte-identical to the generator's; regenerating in any input order is byte-identical | `test/features.test.js` |
| S9 turning a feature off deletes what it wrote, in the editor's pre-flight and in the CLI; `check` finds a stale file | `test/features-app.test.js` |
| W1 a WordPress export reads into posts, pages, drafts, tags, authors, the menu and the library; trash and other types are not imported; a DOCTYPE entity is never expanded | `test/wp-content.test.js` |
| W2 every imported file is canonical markdown (`md → Delta → md` byte-identical), builds, and says what was flattened | `test/wp-content.test.js` |
| W3 pictures: only PNG/JPEG/GIF/WebP/AVIF by their bytes, never an SVG; a failed one stays linked to the old site and is said; nothing identifying is sent | `test/wp-content.test.js`, `test/wp-import-app.test.js`, `test/wp-cli.test.js` |
| W4 two exports become two blogs in one repository: pictures in one commit, blogs in a second, pinned, regenerable; an existing blog is never replaced | `test/wp-import-app.test.js` |
| W5 the wizard, from the home page to a commit, in real Chrome against a cross-origin old site | `test/e2e/import.e2e.mjs` |

`npm test` runs the unit tests; `npm run test:e2e` drives a real Chrome (set `CHROME=` if it is not
in a standard place; the tests skip themselves when it is absent). `test/imports.test.js` resolves
every named import, so a renamed export cannot silently break the browser-only modules.

## Known limits

* **WordPress import:** pictures on a site that does not allow cross-origin reads cannot be fetched by the browser (use the CLI); the REST
  fallback sees only published posts and pages; a line break inside a paragraph becomes a new paragraph; comments, forms, products and other
  plugins' content are not imported; links to pages that are not imported still point at the old site; a post's old permalink structure is not
  kept (the new address is `/<slug>/`, so keep the old site up, or redirect, for links from elsewhere).

* A **new standalone page** is not drawn before the Pages build the way a new post is: the live script's 404 path reads
  `posts/<slug>.md`, so `/about/` is a 404 until the build finishes. An edited page, like any page, shows what was built.
* The search index, tag pages, archive and sitemap are as of the last build; only post pages are refreshed from the live copy.
* The `/blog/` reader (the no-Pages view) does not show tag, author, archive or search pages, comments, the subscribe form or
  standalone pages: those are the generated site's.
* Comments and analytics are third-party scripts on your readers' pages (see [above](#comments-analytics)); the generator
  cannot vouch for them, only pin them with `integrity`.
* Two tags that share an address (`C++`, `c`) share a page, and the first alphabetically names it; nothing refuses it.
* `index/posts.json` now records each post's `author`, and the standalone `pages`; readers that ignore unknown fields are unaffected.
* Draft *source* is visible in a public repo; `draft` hides it from the site, not from GitHub.
* A video has no alt text or caption of its own (Quill's video blot cannot hold one); the title
  is the release name and version. `![alt](video:…)` is refused, not dropped.
* The player iframe and the video segments are loaded by the browser, not through this app, so
  the ledger does not count them. Video is not played until the iframe loads; static pages load
  it lazily.
* The release picker lists tags; it does not check that a tag's folder is a complete release.
* A page with no `cover` (or `cover: auto` with no image or video to pick) and no blog-level `cover`
  has no `og:image` (a warning at build). A video poster chosen by `auto` is not checked for
  existence when generating: releases made by hls.webcli.app or this app always have one.
* Staged images cannot be committed in a correction (pull request) when the image folder is in
  the blog's own repository: that would push to the default branch. Publish them in a normal edit.
* The release picker does not check that a video folder exists at the chosen folder, only the tag.
* `audio` is accepted as a media repository (hash and `blog.json`), but there is no audio player:
  an audio file is reachable as a pinned link, `[Listen](asset:audio/ep1.mp3)`.
* An invalid `customize` section refuses the build, and the reader falls back to the static site
  link rather than rendering with half of it.
* The `/blog/` reader shows a themed blog (its committed `theme.css`, the same markup) but does not
  apply extension output: it never fetches or evaluates extension repositories, and it applies no
  recorded outputs, so extension effects appear on the static pages only.
* Extensions run only in the editor's sandbox. A blog with extensions cannot be regenerated by the
  CLI or CI unless `extension-outputs.json` already covers every post (it is committed, so normally
  it does); otherwise they refuse and say to publish from the editor.
* The split-licensing check is a conservative text heuristic over `style.css` and the readme, not a
  legal judgement; it refuses on a match and cannot see licence terms written elsewhere.
* An embed's pinned assets can be verified by the editor only on jsDelivr or GitHub raw (the hosts
  its CSP lets it read); the CLI can fetch any https host.
* Only `style.css` of a WordPress theme is taken, not other stylesheets it loads from PHP, and only a
  block theme's design tokens, not its `theme.json` styles or templates.
* The `wordpress-classic` contract covers what a blog has (no comments, widgets, pagination or
  archives); a theme's CSS for those simply matches nothing.
* Two adjacent lists of the *same* type separated by a blank line merge on round trip, so
  such files are refused as non-canonical.
* Read counts bytes fetched by this app; images the browser loads from the asset CDN are
  not routed through it.
* `vendor/quill/` is Quill 2.0.3 (BSD-3), vendored so the app loads no third-party script.
* `vendor/moment/` is moment.js 2.31.0 (MIT), vendored for the same reason. The app (not the generated
  pages) shows a post's date as words: *Today*, *Yesterday*, *3 days ago*, *Oct 12*, *Oct 12, 2025*,
  with the full date on hover. A date is a calendar day, so it is compared by day, not by the hour,
  and a new post's default date is the reader's local day, not UTC's. Generated pages, the index and
  the feed keep the ISO date, so a published page does not change with the clock and CI still
  regenerates it byte for byte.
* `vendor/hls/` is hls-webCLI's encoder (GPL-3.0), vendored unedited and hash-checked. Encoding a
  video needs WebCodecs (recent Chrome, Edge or Safari) and holds the video and the encoded files
  in memory, so the input is limited to 1 GB and a release to 300 MB. It takes the encoder's own
  limits: H.264 only, steady 24/25/30/50/60 fps, no rotation; no captions yet (hls.webcli.app adds
  those). Writes are retried when GitHub rate-limits them, but an interrupted upload leaves no
  commit and no tag, so it is simply run again.

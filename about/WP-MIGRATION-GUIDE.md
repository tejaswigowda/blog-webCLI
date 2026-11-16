# Leaving WordPress: your site, without the server

You have a WordPress site. This moves it to a repository on GitHub, as plain files, and publishes it as static pages: nothing to patch, nothing to be compromised, no managed hosting to pay for to avoid that. The pages are complete HTML you can read, and your posts stay yours as markdown.

It takes three steps and about ninety seconds of your attention. What follows is also the script for the demo.

## 1. Export (WordPress, 10 s)

In your WordPress admin: **Tools → Export → All content → Download Export File**. You get an `.xml` file. It is read in your browser and sent nowhere.

*(No admin access? The importer can also read a live site's public REST API, but that gives only published posts and only works when the site allows it. An export always works and includes drafts.)*

## 2. Import (blog.webcli.app, 40 s)

1. Open <https://blog.webcli.app/#import> and sign in with GitHub.
2. **Sources**: choose the `.xml` file. **Blogs**: check the title, author and folder. **Pictures**: they are fetched from your old site into an `images` folder; a list says anything that could not be kept.
3. **Commit**: name a repository (`you/my-blog`). The pre-flight lists exactly what will be sent. One commit holds the pictures, a second the blog.
4. Settings → turn on GitHub Pages. Your site is live at `https://you.github.io/my-blog/`.

Every post, page and draft is a markdown file; tags, the featured image, the excerpt and the menu come with them. What does not (comments, plugins, forms, other content types) is named in the report, not silently dropped.

## 3. Make it look like your site (30 s)

The theme is a separate choice. You do not need a WordPress theme, and you cannot use one: pick a starter (`essay`, `terminal`, `cards`, `wide` or the default), **or measure your old site**:

```
node cli/measure.mjs https://my-old-site.example/ --out look.json
```

Paste `look.json` into **Theme → Match an existing site**. It reads your site's colours, text width and list layout off the page it renders, and picks the nearest of five type stacks. **The typeface will not match** (a webfont becomes the nearest system font), and it never copies a stylesheet. It works on any site, however it was built, which is why it is how you migrate a site that uses a commercial or custom theme.

## What you get

- Static pages: no PHP, no database, no login page to attack. A published page is under 10 KB and paints in a fraction of a second ([measured, with the method](../docs/PAGE-SPEED.md)). Most of what makes a page slow in practice is large images; resize them before you publish.
- Your content as files in a git repository, with history.
- A site that stays up when nothing is maintaining it.

## The 90-second demo

A real site, no architecture talk, no mention of git.

| time | on screen | say |
|---|---|---|
| 0:00 | a real WordPress site, scrolled | "This is a WordPress site. It needs a server, updates and a host." |
| 0:08 | wp-admin, Tools → Export, the download | "One file." |
| 0:15 | blog.webcli.app/#import, drop the file | "Import it." |
| 0:25 | the wizard: counts of posts, pages, pictures | "Every post, page and picture." |
| 0:40 | Commit; the pre-flight list; Commit | "Here is exactly what it sends." |
| 0:55 | `measure.mjs` printing, pasted into Match an existing site | "Make it look like the old one." |
| 1:10 | the live GitHub Pages address, loaded, scrolled | "That is your site. No server." |
| 1:20 | the old site beside the new | end on the two side by side, nothing else |

*Not recorded here: this repository cannot produce the video. The script, the timings and the pages above are what to record.*

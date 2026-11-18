# Updating an existing WordPress import: Deals in AZ

{.lead} An existing GitHub-backed copy can be brought up to date without replacing its older posts. This case study stages a one-time update, not an automatic WordPress sync.

**Status:** the rebuilt site is published on GitHub Pages. Historical WordPress media and addresses still need a separate cutover audit.

## 1. Establish the source and destination

The source is [dealsinaz.com](https://dealsinaz.com/); the destination is [FoxyNinjaStudios/dealsinaz](https://github.com/FoxyNinjaStudios/dealsinaz). Work in a separate checkout and preserve posts that are no longer in WordPress. Record the source snapshot time and compare against the original import and any edits made since.

For this update, the owner requested only the last five days. The snapshot contained four published posts modified from November 12 at 23:16 UTC through November 17, 2026 at 23:16 UTC. WordPress was authoritative for those posts; older posts were not synchronized. An exact rolling window matters: a different snapshot time can produce different results.

The public WordPress REST API only exposes what it allows anonymous readers to see. It does not include private posts or drafts. This snapshot reported 7,999 published posts and three pages; its media endpoint advertised 26,329 records but returned 26,323, and its comments endpoint advertised 33 but returned 32. Comments were not imported during this update.

## 2. Match before writing

Compare WordPress IDs, original paths, dates and titles with the destination. A shortened slug is not a reliable identity: two unrelated posts can share the same shortened name. Inspect ambiguous matches rather than overwriting either post. Keep destination-only posts, and review any demo or test content separately.

The editor's WordPress import can add missing content to an existing blog, but **add does not update an existing post**. In the import wizard, the option to add to an existing blog preserves its settings and skips content whose address is already in use. The CLI's `--add` has the same limitation. To update matching content, compare and edit it deliberately; do not mistake an add-only import for a sync.

This case used a local, one-off comparison and conversion, not a supported reusable sync command. Review converted text and links, then verify the source files round-trip in the editor. The original source may contain markup the importer cannot preserve exactly.

## 3. Keep the requested media

Existing pinned assets were left alone. Four images needed by the four recent posts were copied to the destination repository and pinned to the media commit in `assets.lock.json`. Third-party images remain external links. Check each imported post in the editor and open its images before publishing.

Older posts already contain image URLs, but some point to `https://dealsinaz.com/wp-content/uploads/`. Those URLs depended on the WordPress host; after cutover, two sampled upload URLs returned 404. This update did not copy the older media library. Restore or serve those files and audit the remaining URLs separately.

## 4. Addresses, settings and affiliate links

The four new posts retain their WordPress dated addresses as aliases. Each static alias is a page with a canonical link and refresh, not an HTTP 301. Older posts were outside this five-day update: their historical WordPress URLs have not been comprehensively redirected. Audit and preserve those addresses separately.

The settings use `https://dealsinaz.com` as the canonical domain and remove the demo banner and `noindex`. The site owner is responsible for DNS and GitHub Pages domain configuration. The custom domain now serves the generated site.

For the affiliate rebuild, set **Settings → Automatically mark affiliate domains** (`affiliates` in `blog.json`) and a plain-text **Post disclosure** (`disclosure`). The renderer marks matching outbound links in existing posts without changing their Markdown. Hostnames match only themselves and subdomains; the older `affiliateDomains` setting is a separate strict gate and is not required for automatic marking.

Run `node cli/blog.js links /path/to/dealsinaz` to review outbound hosts. The initial report contained 1,427 hosts; the configured list includes the requested retailers and prominent affiliate/tracking domains found in the archive. It is not proof that every affiliate host has been identified: review unmarked hosts regularly, especially new retailers and shortened links.

### Disclosure diagnosis

The November 17 WordPress REST snapshot included the exact phrase “may receive a small commission via affiliate links in this post” in 883 of 7,999 published post bodies. In the Walgreens photo-card post, the disclosure is present in the WordPress response, the imported Markdown and the static post HTML; the importer did not drop it in that example. The public response alone does not establish whether WordPress saved the text in the editor or inserted it through a hook, and this sample does not prove that every post kept every disclosure. Many posts lack that exact phrase, so a site-level disclosure is needed even when some imported posts already have one.

Retailer-hosted images remain third-party requests and may break if a retailer changes or removes their URLs.

## 5. Build and verify

From a checkout of blog-webCLI, build and check the staged repository:

```sh
node cli/blog.js build /path/to/dealsinaz
node cli/blog.js check /path/to/dealsinaz
```

Inspect the recent posts, copied images and their pinned commit, existing posts and pages, search, feed, sitemap, navigation and the four redirect pages. Verify the canonical domain and indexing settings. A missing-cover warning means the affected page has no share image; resolve it if a share image is needed.

This rebuild uses the existing pinned `asset:images/design/hero.png` as the site cover, and `check` tests one pinned asset anonymously. One successful request does not verify every media repository. The post disclosure may duplicate text already present in imported posts.

Test historical links and every referenced upload on the new host. Confirm that GitHub Pages is serving the expected commit, and keep a copy of the old WordPress site available while resolving the remaining cutover gaps. Re-run the comparison for later changes; this case study does not set up ongoing synchronization.

[Tutorials and guides](/about/tutorials/) · [Open the editor](/)

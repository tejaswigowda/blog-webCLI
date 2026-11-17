# Updating an existing WordPress import: Deals in AZ

{.lead} An existing GitHub-backed copy can be brought up to date without replacing its older posts. This case study stages a one-time update, not an automatic WordPress sync.

**Status:** the update was pushed to the destination repository. Do not switch DNS until the new site and the cutover checks below have been verified.

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

Older posts already contain image URLs, but some point to `https://dealsinaz.com/wp-content/uploads/`. Those URLs depend on the WordPress host. If DNS is moved to GitHub Pages, the old uploads will not automatically be there: move or serve those files and test their URLs before cutover. This update did not copy the older media library.

## 4. Addresses, settings and affiliate links

The four new posts retain their WordPress dated addresses as aliases. Each static alias is a page with a canonical link and refresh, not an HTTP 301. Older posts were outside this five-day update: their historical WordPress URLs have not been comprehensively redirected. Audit and preserve those addresses before switching the domain.

The staged settings use `https://dealsinaz.com` as the canonical domain and remove the demo banner and `noindex`. The site owner is responsible for DNS and GitHub Pages domain configuration. Until cutover, the live WordPress site remains the source.

Affiliate-domain enforcement was deliberately left disabled because no hostnames were configured. To enable it later, open **Settings → Affiliate domains**, enter one hostname per line and save. Links to those hosts and their subdomains must then be marked `sponsored`; the gate does not mark links automatically. Review affiliate links before launch.

## 5. Build and verify

From a checkout of blog-webCLI, build and check the staged repository:

```sh
node cli/blog.js build /path/to/dealsinaz
node cli/blog.js check /path/to/dealsinaz
```

Inspect the recent posts, copied images and their pinned commit, existing posts and pages, search, feed, sitemap, navigation and the four redirect pages. Verify the canonical domain and indexing settings. A missing-cover warning means the affected page has no share image; resolve it if a share image is needed.

Before any DNS change, test historical links and every referenced upload on the new host. Confirm that GitHub Pages is serving the expected commit, and keep the old WordPress site available until the cutover has been verified. Re-run the comparison for later changes; this case study does not set up ongoing synchronization.

[Tutorials and guides](/about/tutorials/) · [Open the editor](/)

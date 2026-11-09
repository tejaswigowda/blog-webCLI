# Contract `wordpress-classic-2`

`wordpress-classic` is frozen: a blog pins a theme written against it, and its output must not move. `wordpress-classic-2` is a new name for the same markup **plus classes the blog can truthfully carry**, chosen from [the gap report](contract-gap.md). Tests pin both halves: `wordpress-classic` and `blog-webcli-v1` regenerate byte for byte (checked over the whole layout corpus, paginated and stable, before the change), and v2 with its added classes stripped equals `wordpress-classic`.

| added | where | wanted by |
|---|---|---|
| `page-numbers` on the pager's links, `current` on the page it is on, `prev` / `next`, `posts-navigation` on the `nav` | every paginated list | 40, 48, 24 + 10, 11 |
| `post-date` | the entry date in a list and on a post | 15 |
| `taxonomy-description` | the heading text of a tag or archive page | 10 |
| `page-content` | the body of a standalone page | 29 |
| `nav-menu` | the primary menu's list | 11 |
| `site-logo` | the logo wrapper (when the blog has a logo) | 8 |
| body class `archive` on a listing | tag, archive and further pages (they said `home blog`) | many themes style `.archive` |

**Deliberately not added** (they would be empty, or false): comments, widgets and sidebars; `cat-links` (a blog has tags, not categories); submenu classes (the menu is flat); `menu-toggle` (it needs a script); post formats; `updated` (posts carry one date); `more-link` and `read-more` (they would add words to the page).

## What it changes, measured

Over the 77 imported themes, rendered under v2 instead of `wordpress-classic` (`CONTRACT=wordpress-classic-2 node cli/wp-gap.mjs`, `… cli/wp-sweep.mjs`):

- the pager, entry-date, taxonomy-description and page-content names are no longer missing for any theme that wants them (`.page-numbers` 40 → 0, `.current` 48 → 0, `.post-date` 15 → 0, `.page-content` 29 → 0);
- **no theme changes verdict** in the layout sweep (17 usable, 44 soft, 11 degraded, 5 unportable candidates before and after).

The second line is the finding. The class gap was real but it is not what breaks these themes: the sweep's failures are a skeleton's slider and hero placeholders pushing the post below the fold, a preloader laid over the page, and off-canvas menus. Those are not contract questions, and more classes do not repair them. Contract v2 makes themes fit a little better; it does not make an unusable theme usable.

## Using it

A theme names it with `"class_contract": "wordpress-classic-2"` in `theme.json`; it takes a skeleton as the classic one does, and its blocks render as classic ones (`wp-block-table` and the rest). The imported themes are unchanged and stay on `wordpress-classic`.

# Contract gap of the imported themes

Computed statically by `node cli/wp-gap.mjs` from the CSS of the 77 themes in `blog-webCLI-themes/wp` and the markup `wordpress-classic` emits over a corpus of 24 posts and pages (list and cards layouts, paginated, with tag, author, archive and search listings). No browser is involved.

A *gap* is a class or id a theme's stylesheet targets that no page of the corpus carries. Names wanted by fewer than 5 themes are a theme's own vocabulary, not a contract question, and are left out of the tables below (they are in the JSON).

## What is missing, by kind

| kind | distinct names missing | wanted by 5+ themes |
|---|---|---|
| container | 10534 | 1407 |
| region | 1114 | 181 |
| plugin | 3349 | 2798 |
| block | 1659 | 473 |
| state | 188 | 47 |
| body | 88 | 12 |

Most of the raw gap is noise: plugin markup (WooCommerce, Elementor), Gutenberg block classes, framework utilities and animation names a theme ships with its own CSS. The contract is not short of those.

## Emit: container markup that can be populated truthfully

| themes | selector |
|---|---|
| 40 | `.page-numbers` |
| 29 | `.page-content` |
| 24 | `.next` |
| 19 | `.current_page_item` |
| 18 | `.updated` |
| 17 | `.more-link` |
| 16 | `.custom-logo-link` |
| 15 | `.post-date` |
| 11 | `.posts-navigation` |
| 10 | `.prev` |
| 10 | `.taxonomy-description` |
| 8 | `.site-logo` |
| 7 | `.read-more` |

## Do not fake: content regions and features a blog does not have

| themes | selector | why |
|---|---|---|
| 40 | `.bypostauthor` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 39 | `.comment-content` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 38 | `.menu-item-has-children` | the blog menu is flat: no submenus |
| 38 | `.widget` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 36 | `.button` | a form control, not markup the blog has |
| 36 | `.widget-title` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 35 | `.comment` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 33 | `.avatar` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 33 | `.comment-form` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 32 | `.comment-meta` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 31 | `.children` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 31 | `.comment-author` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 31 | `.comment-notes` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 31 | `.comment-reply-title` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 31 | `.logged-in-as` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 31 | `.sub-menu` | the blog menu is flat: no submenus |
| 30 | `.comment-list` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 30 | `.form-submit` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 30 | `.wp-block-latest-comments` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 29 | `#respond` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 28 | `#submit` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 27 | `.comment-body` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 27 | `.search-submit` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 27 | `.tagcloud` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 26 | `.comment-respond` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 26 | `.reply` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 25 | `.search-form` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 23 | `.comments-area` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 23 | `.comments-title` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 22 | `.comment-metadata` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 22 | `.comment-reply-link` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 22 | `.page-links` | a post is one page |
| 22 | `.search-field` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 22 | `.widget-area` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 21 | `.edit-link` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 19 | `.comment-form-cookies-consent` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 19 | `.comment-form-email` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 19 | `.comment-form-url` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 19 | `.product` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 19 | `.widget_text` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 19 | `#comments` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 18 | `.cat-links` | a blog has tags, not categories |
| 18 | `.comment-form-author` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 18 | `.widget_nav_menu` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 18 | `.widget_recent_entries` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 18 | `.wp-block-latest-comments__comment-excerpt` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 17 | `.alt` | a table-row or product state |
| 17 | `.dots` | the pager has no numbered links to elide |
| 17 | `.textwidget` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 17 | `.widget_calendar` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 17 | `.widget_search` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 16 | `.comment-edit-link` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 16 | `.required` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 16 | `.says` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 16 | `.widget_block` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 16 | `.widget_rss` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 15 | `.comment-navigation` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 15 | `.format-aside` | a post format; the blog has none |
| 15 | `.products` | implies content a blog does not have (comments, widgets, a sidebar, search form) |
| 15 | `.wp-block-latest-comments__comment-date` | implies content a blog does not have (comments, widgets, a sidebar, search form) |

## Review

`#secondary` (18), `.editor-styles-wrapper` (16), `.site-description` (16), `.block-editor-block-list__layout` (15), `.menu` (15), `.onsale` (15), `.price` (14), `.commentlist` (12), `.coupon` (12), `.post-password-form` (12), `.rsswidget` (12), `.current_page_ancestor` (11), `.menu-item` (11), `.post-page-numbers` (11), `.title` (11), `.toggled-on` (11), `#wpadminbar` (11), `.animated` (10), `.author-avatar` (10), `.content` (10), `.customize-partial-edit-shortcut` (10), `.infinite` (10), `.infinite-scroll` (10), `.star-rating` (10), `.tabs` (10), `.ab-item` (9), `.actions` (9), `.author-description` (9), `.back` (9), `.even` (9), `.odd` (9), `.quantity` (9), `.rss-date` (9), `.separator` (9), `.ab-sub-wrapper` (8), `.admin-bar-search` (8), `.ah-headline` (8), `.ah-words-wrapper` (8), `.arrow-wrapper` (8), `.background-video-youtube-blocker` (8), `.bordered-active-item` (8), `.bordered-active-item--bottom` (8), `.bordered-active-item--top` (8), `.bordered-active-item--top-and-bottom` (8), `.bring-to-front` (8), `.clip` (8), `.colibri-menu` (8), `.colibri-menu-container` (8), `.colibri-word-wrap` (8), `.compensate-for-scrollbar` (8), `.components-button` (8), `.container-fluid` (8), `.content-swap` (8), `.cp-video-bg` (8), `.delay-1s` (8), `.delay-2s` (8), `.delay-3s` (8), `.delay-4s` (8), `.delay-5s` (8), `.effect-borders-grow` (8)

## Themes that target a sidebar

32 of 77 style `#secondary`, `.widget-area` or `.sidebar`, which the generator does not emit (and must not, empty). Whether that makes a theme *unportable* depends on whether its layout leaves a hole without it. That takes a render, not a stylesheet: it is the next step (the failure signatures, on the corpus).

`astra`, `blogchrome`, `bloghash`, `botiga`, `customify`, `customizr`, `envo-one`, `futurio-storefront`, `generatepress`, `hestia`, `hybridmag`, `inspiro`, `kadence`, `newscircuit`, `prespa`, `prespa-wellness`, `rubik-news`, `sinatra`, `solace`, `spacious`, `storefront`, `sydney`, `twentyeleven`, `twentyfifteen`, `twentyfourteen`, `twentyseventeen`, `twentysixteen`, `twentyten`, `twentythirteen`, `twentytwelve`, `twentytwentyone`, `vantage`


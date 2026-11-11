// One legible default theme. Inlined into every generated page: no external CSS,
// no JavaScript, nothing a crawler or unfurler has to execute.
export const THEME_DEFAULT = `
:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6b6b72;--bg:#fff;--rule:#e4e4e8;--link:#0b5fff;--code:#f3f3f6;--font:Georgia,"Iowan Old Style","Times New Roman",serif;--heading-font:var(--font);--width:40rem;--size:18px}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8ec;--muted:#9a9aa3;--bg:#141416;--rule:#2c2c31;--link:#7aa7ff;--code:#202024}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:var(--size)/1.65 var(--font)}
.wrap{max-width:var(--width);margin:0 auto;padding:2rem 1.25rem 4rem}
header.site{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;border-bottom:1px solid var(--rule);padding-bottom:.75rem;margin-bottom:2rem;font:600 .95rem/1.4 system-ui,sans-serif}
header.site a{color:var(--fg);text-decoration:none}
header.site nav a{color:var(--muted);font-weight:400;margin-left:1rem}
header.site .brand{display:inline-flex;align-items:center;gap:.5rem}
img.logo{height:1.75rem;width:auto;border-radius:0}
h1,h2,h3,h4{font-family:var(--heading-font)}
h1{font-size:2.1rem;line-height:1.2;margin:.2em 0 .3em}
h2{font-size:1.5rem;line-height:1.3;margin:2em 0 .5em}
h4{font-size:1.05rem;line-height:1.4;margin:1.5em 0 .4em}
p.lead{font-size:1.25em;line-height:1.55;color:var(--muted)}
p.small{font-size:.85em;line-height:1.5;color:var(--muted)}
h3{font-size:1.2rem;margin:1.6em 0 .4em}
a{color:var(--link)}
img{max-width:100%;height:auto;border-radius:4px}
.meta{color:var(--muted);font:.9rem/1.5 system-ui,sans-serif;margin-bottom:1.5rem}
.meta .tag{display:inline-block;margin-left:.5rem}
.meta a.tag{color:var(--muted);text-decoration:none}
.meta a.tag:hover{text-decoration:underline}
.pagination{margin:2rem 0 0;font:.95rem/1.4 system-ui,sans-serif}
.pagination .nav-links{display:flex;justify-content:space-between;align-items:center;gap:1rem}
.pagination .page-of{color:var(--muted)}
ul.archive,ul.tag-list{list-style:none;padding:0}
ul.archive li{margin:.35rem 0}
ul.archive time{color:var(--muted);font:.85rem system-ui,sans-serif;margin-right:.6rem}
ul.tag-list .count{color:var(--muted)}
form.subscribe,form[role=search]{margin:2rem 0 0;font:.95rem/1.4 system-ui,sans-serif}
form.subscribe{padding-top:1rem;border-top:1px solid var(--rule)}
form.subscribe input,form[role=search] input{font:inherit;padding:.4rem .6rem;border:1px solid var(--rule);border-radius:6px;background:var(--bg);color:var(--fg);max-width:100%}
form.subscribe button,form[role=search] button{font:inherit;padding:.4rem .8rem;border:1px solid var(--rule);border-radius:6px;background:var(--code);color:var(--fg);cursor:pointer}
.comments{margin:2.5rem 0 0}
[data-status]{color:var(--muted);font:.9rem/1.5 system-ui,sans-serif}
.post-nav{display:flex;justify-content:space-between;gap:1rem;margin:2.5rem 0 0;padding-top:1rem;border-top:1px solid var(--rule);font:.95rem/1.4 system-ui,sans-serif}
.post-nav a{max-width:48%;text-decoration:none}
.post-nav .next{margin-left:auto;text-align:right}
blockquote{margin:1.2em 0;padding:.1em 1.1em;border-left:3px solid var(--rule);color:var(--muted)}
pre{background:var(--code);padding:1rem;overflow:auto;border-radius:6px;font-size:.85rem;line-height:1.5}
code{background:var(--code);padding:.1em .3em;border-radius:3px;font-size:.9em}
pre code{background:none;padding:0}
.cover{margin:0 0 1.5rem}
figure.video{margin:1.5rem 0}
figure.video iframe{width:100%;aspect-ratio:16/9;border:0;border-radius:6px;background:var(--code)}
figure.video figcaption{font:.85rem/1.5 system-ui,sans-serif;color:var(--muted);margin-top:.4rem}
ul.posts{list-style:none;padding:0}
ul.posts li{margin:0 0 2rem}
ul.posts.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:1.25rem}
ul.posts.cards li{margin:0;padding:1rem 1.1rem;border:1px solid var(--rule);border-radius:8px}
ul.posts h2{margin:.1em 0}
ul.posts h2 a{color:var(--fg);text-decoration:none}
ul.posts p{margin:.3em 0}
footer.site{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--rule);color:var(--muted);font:.85rem/1.5 system-ui,sans-serif}
.unresolved{color:var(--muted);font-style:italic}
table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse}
td,th{padding:.3rem .6rem;border:1px solid var(--rule)}
iframe,embed,object,video{max-width:100%}
html{-webkit-text-size-adjust:100%}
body{overflow-wrap:break-word}
@media (max-width:640px){
:root{--size:17px}
.wrap{padding:1.25rem 1rem 3rem}
h1{font-size:1.75rem}
h2{font-size:1.3rem}
header.site{flex-wrap:wrap;row-gap:.4rem}
header.site nav{display:flex;flex-wrap:wrap;gap:.1rem 1rem}
header.site nav a{margin-left:0}
.post-nav{flex-direction:column}
.post-nav a{max-width:100%}
.post-nav .next{margin-left:0;text-align:left}
ul.posts.cards{grid-template-columns:1fr}
form.subscribe input,form[role=search] input{width:100%;margin-bottom:.5rem}
.pagination .nav-links{flex-wrap:wrap}
}
`.trim();

export const THEMES = { default: THEME_DEFAULT };

// What every page needs whatever theme styles it: images that fit, video that keeps its shape,
// text for screen readers. A pinned theme is applied on top of this, not in place of it.
export const THEME_BASE = `
*{box-sizing:border-box}
img{max-width:100%;height:auto}
.screen-reader-text{border:0;clip:rect(1px,1px,1px,1px);clip-path:inset(50%);height:1px;margin:-1px;overflow:hidden;padding:0;position:absolute;width:1px;word-wrap:normal!important}
figure.video iframe,.wp-block-embed__wrapper iframe{width:100%;aspect-ratio:16/9;border:0}
.unresolved{font-style:italic}
.theme-hero{margin:0 0 1.5rem}
.theme-hero img{display:block;width:100%;max-height:24rem;object-fit:cover}
.theme-hero figcaption{font-size:.75rem;opacity:.7;margin-top:.35rem}
`.trim();

// Applied AFTER a pinned theme, so that no theme, whoever wrote it, can leave a page that scrolls sideways or shows a heading
// larger than the screen: media and tables fit their column, long words and addresses break, the header and the previous/next
// rows wrap, and on a phone the large type of a theme made for a desktop is brought down. Only things a theme would not
// deliberately want wider than the screen; a theme's own layout and colours are untouched. (The default theme has these in itself.)
export const THEME_RESPONSIVE = `
html{-webkit-text-size-adjust:100%}
body{overflow-wrap:break-word}
img,svg,canvas,video,iframe,embed,object{max-width:100%}
img,video{height:auto}
table{display:block;max-width:100%;overflow-x:auto}
pre{max-width:100%;overflow-x:auto}
.wp-block-embed__wrapper iframe,figure.video iframe{width:100%;aspect-ratio:16/9;height:auto}
@media (max-width:782px){
.site-header,#masthead,header.site{flex-wrap:wrap;row-gap:.5rem}
.site-branding,.site-header .primary-navigation{max-width:100%}
.primary-navigation .menu-wrapper,.main-navigation ul,header.site nav{flex-wrap:wrap;padding-left:0}
.nav-links,.post-nav,.pagination .nav-links{flex-wrap:wrap;gap:.75rem}
.nav-links>*,.post-nav a{max-width:100%}
.alignleft,.alignright{float:none;display:block;margin-left:auto;margin-right:auto}
form.subscribe input,form[role=search] input{max-width:100%}
}
@media (max-width:600px){
:root{--global--font-size-page-title:2.25rem;--global--font-size-xxl:2.25rem;--global--font-size-xl:1.75rem;--global--font-size-lg:1.25rem;--heading--font-size-h1:2rem;--heading--font-size-h2:1.6rem;--heading--font-size-h3:1.35rem}
h1,.page-title,.entry-title,.site-title,.post-title{overflow-wrap:anywhere}
.page-title,h1.entry-title{font-size:clamp(1.75rem,9vw,2.5rem)}
ul.posts.cards{grid-template-columns:1fr}
}
`.trim();

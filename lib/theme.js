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
h1,h2,h3{font-family:var(--heading-font)}
h1{font-size:2.1rem;line-height:1.2;margin:.2em 0 .3em}
h2{font-size:1.5rem;line-height:1.3;margin:2em 0 .5em}
h3{font-size:1.2rem;margin:1.6em 0 .4em}
a{color:var(--link)}
img{max-width:100%;height:auto;border-radius:4px}
.meta{color:var(--muted);font:.9rem/1.5 system-ui,sans-serif;margin-bottom:1.5rem}
.meta .tag{display:inline-block;margin-left:.5rem}
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
`.trim();

export const THEMES = { default: THEME_DEFAULT };

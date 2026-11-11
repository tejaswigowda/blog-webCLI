# Page speed: one claim, with its method

**The claim that survives checking:** a page this generator makes is complete HTML and CSS in under 10 KB. On a throttled cold connection it paints in **about 260 ms** (FCP and LCP) with **0 ms of blocking time** and **no JavaScript file at all**.

| page | transfer | requests | JavaScript | FCP | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| `examples/blog/` index (generated output, served unmodified) | 8.6 KB | 2 | **none** (the one `<script>` is JSON-LD data) | 264 ms | 264 ms | **0 ms** | **0** |
| `examples/blog/markdown-is-the-format/` (a post) | 9.8 KB | 2 | **none** | 276 ms | 280 ms | **0 ms** | **0** |

Median of 5 cold runs each, Slow 4G, 4x CPU slowdown, a 390 px phone. CLS is the sum of `layout-shift` entries without recent input (`cli/speed.mjs`). These pages have no pictures, so CLS 0 here says the generator's HTML and CSS do not move; for a page with pictures it holds when every `<img>` carries `width` and `height` (`blog-webcli sizes`, or any upload through the editor). Reproduce: serve `examples/blog` and run `node cli/speed.mjs http://127.0.0.1:8765/`.

## What the claim does not say

These are the numbers I measured on a **real published blog** (`https://tejaswigowda.com/dealsinaz/`, 5 cold runs, same method), and they are different, for two reasons worth knowing before anyone repeats the headline.

| | transfer | requests | JavaScript | FCP | LCP | TBT |
|---|---|---|---|---|---|---|
| a published blog with a content repository | 4,021 KB | 25 | **1 file, 54 KB** | 656 ms | **6,456 ms** | 0 ms |

1. **"Zero JavaScript" is true of the pages, not of every published blog.** A blog that points at a content repository (`contentBase`) ships `webcli-live.js`, the 54 KB module that lets a reader see an edit before the site is rebuilt. It is a deferred module, so it blocks nothing (TBT is 0 ms), but it is JavaScript, and the pages work without it. A blog with no content base ships none. Say "no JavaScript needed", not "no JavaScript".
2. **LCP is the images, not the generator.** The published blog above weighs 4 MB because its photographs are unoptimised, and its LCP is the largest of them. The generator's HTML and CSS are not the cost. Resize pictures before publishing; that is the one change that would move this number.

**Re-measured 11 Nov 2026** (same method): the published blog's front page is **LCP 31.6 s, 4.5 MB over 24 requests, CLS 0, TBT 0 ms, 1 JavaScript file (61 KB, the live script)**; Lighthouse 12.8 (mobile, simulated) agrees on the cause: 13.7 MB of full-size photographs from `raw.githubusercontent.com` and a `loading="lazy"` hero picture as the LCP element. Its 22 unsized images did not shift the layout in that run, because they load below the fold. The numbers to quote for this generator are the first table; the last row is what a blog full of unoptimised photographs costs.

## Method

`cli/speed.mjs`, headless Chrome over the DevTools protocol:

- **network** Slow 4G: 1.6 Mbit/s down, 750 kbit/s up, 150 ms round trip (Lighthouse's mobile preset), applied with `Network.emulateNetworkConditions`;
- **cpu** 4x slowdown (`Emulation.setCPUThrottlingRate`);
- **device** 390x844, mobile, device pixel ratio 2;
- **cold** a new Chrome profile for every run, cache disabled, no service worker;
- **FCP, LCP** from `PerformanceObserver` (buffered), read 3 s after load; **TBT** is the sum over long tasks of (duration − 50 ms) from first contentful paint;
- **JavaScript** counted from the network: every response whose resource type is Script, by transferred size.

**Caveats.** Lab data from one machine. The local runs are served from `127.0.0.1`, so the throttle supplies the latency but not DNS, TLS or a CDN's real distance; a published page will add a few hundred milliseconds. The throttle is a model of a connection, not a measurement of one. The page that is worth quoting is the one *you* publish: run the tool on it.

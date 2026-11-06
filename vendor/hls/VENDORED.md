# Vendored from hls-webCLI (and, through it, Strata)

The HLS encoder the editor uses to turn an uploaded video into a release: read an MP4, decode once, encode a
ladder of rungs, cut fragmented-MP4 segments, write `master.m3u8`, `render.json` and `files.sha256`.
Nothing here is a reimplementation and **nothing here has been edited**.

| here | origin (`tejaswigowda/hls-webCLI`, `docs/`) |
|---|---|
| `lib/ingest.js`, `lib/prepare.js` | the same paths: read and refuse a video; the flow from a file to a publish set |
| `strata/*.js` | the same paths: Strata's own export modules, vendored by hls-webCLI (see `strata/vendored.json`) |
| `LICENSE` | GPL-3.0, as in hls-webCLI |

Copied from commit `8c5753f00caa79f476d391a9794a2a3197d42763`. `SOURCES.json` records the SHA-256 of every file and
`test/vendored.test.js` fails if one differs, so a silent edit cannot happen. To update: copy the files again from the
commit you want and update `SOURCES.json`. Left out because the blog does not use them: `lib/github.js`, `lib/zip.js`,
`lib/browse.js`, `lib/ledger.js` (hls-webCLI's own UI and publishing), `strata/verify-publication.mjs`,
`strata/render.schema.json`. The blog publishes the set itself, with its own commit and tag code in `app/release.js`,
because a release may live in a folder of a shared repository.

This folder is GPL-3.0, and so is the app that includes it: see `../../LICENSE`.

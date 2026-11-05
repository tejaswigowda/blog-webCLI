---
slug: static-hls-in-git      # set once, never changes
title: Static HLS in git
date: 2026-11-05
author: Ada Example
tags: [video, git]
status: published
cover: asset:images/hls-cover.png
---

HLS is a playlist and a pile of segments. Both are static files, which means **git can hold them** and a static host can serve them — no streaming server, no account.

## Why it works

A playlist is _text_. Segments are small, immutable binaries. Together they fit three ideas:

- Segments never change once written, so they cache forever.
- A playlist is a ~~database~~ list of names, and lists diff well.
- Hosting is a `git push` away.

### The catch

Binaries belong in their own repository, because about 46 MB per minute of video would otherwise sit in every contributor's clone forever.

1. Keep text in the blog repository.
2. Keep binaries in an assets repository.
    - Images in one repository.
    - Audio in another.
3. Reference both with a logical `asset:` name.

> A reference that names no provider is a reference you can move.

Here is the shape of a playlist:

```
#EXTM3U
#EXT-X-VERSION:3
#EXTINF:6.0,
seg-000.ts
```

![A diagram of playlist and segments](asset:images/diagram.png)

![](video:videos/hls-demo@v1)

Read more at [the HLS specification](https://datatracker.ietf.org/doc/html/rfc8216) and see the [home page](../).

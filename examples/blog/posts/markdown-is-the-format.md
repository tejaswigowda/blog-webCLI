---
slug: markdown-is-the-format
title: Markdown is the format of record
date: 2026-11-01
tags: [writing]
status: published
---

A post stored as Quill Delta is JSON that only Quill can read. A post stored as markdown is a file that every tool in the world can read, diff and review.

## What the editor may offer

The toolbar offers only what markdown can say: headings, **bold**, _italic_, `code`, links, quotes, lists and images. Coloured text would be silently lost on save, so it is not offered.

## The test

`md → Delta → md` must produce identical bytes. If it cannot, the editor refuses to open the file instead of rewriting it.

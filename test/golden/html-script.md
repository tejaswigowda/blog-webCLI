---
slug: html-script
title: HTML that is refused
date: 2026-02-05
status: published
---

Fine text, then a block that may not run:

<div onclick="alert(1)">
<script>alert(2)</script>
</div>

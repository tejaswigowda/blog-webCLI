// Render the authored About and case-study markdown to committed, script-free public pages.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mdToDelta } from '../lib/markdown.js';
import { deltaToHtml, escapeHtml } from '../lib/html.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const pages = [
  { source: 'docs/about.md', out: 'about/index.html', title: 'About blog-webCLI', description: 'About the GitHub-native editor, reader and static-site generator, with tutorials and migration guides.' },
  { source: 'docs/tutorial.md', out: 'about/tutorials/recreate-webcli-app.html', title: 'Recreating webcli.app with blog-webCLI', description: 'How an existing tool directory was rebuilt with canonical markdown, structured content and Custom CSS.' },
  { source: 'docs/lyceum-tutorial.md', out: 'about/tutorials/rebuild-lyceumshorts.html', title: 'Rebuilding Lyceum Shorts with blog-webCLI', description: 'How Lyceum Shorts kept its self-hosted HLS player and public URLs while moving its static site build to blog-webCLI.' },
];

for (const page of pages) {
  const body = deltaToHtml(mdToDelta(await fs.readFile(path.join(root, page.source), 'utf8')));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'">
<meta name="description" content="${escapeHtml(page.description)}">
<title>${escapeHtml(page.title)}</title>
<link rel="canonical" href="https://blog.webcli.app/${page.out.replace(/index\.html$/, '')}">
<link rel="stylesheet" href="/about/tutorials/tutorials.css">
</head>
<body>
<main>
<nav class="actions" aria-label="Site"><a href="/">Open the editor</a><a href="/about/">About</a><a href="/about/tutorials/">Tutorials and guides</a></nav>
${body}
<footer>blog-webCLI · <a href="https://github.com/tejaswigowda/blog-webCLI">Source and documentation</a></footer>
</main>
</body>
</html>
`;
  const file = path.join(root, page.out);
  if (check) {
    if (await fs.readFile(file, 'utf8') !== html) throw new Error(`${page.out} is stale; run npm run build:about`);
  } else {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, html);
  }
  console.log(`${check ? 'ok' : 'wrote'}: ${page.out}`);
}

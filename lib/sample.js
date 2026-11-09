// The example blog, as a theme is shown on its own: what a fresh blog looks like with nothing of the author's on it. Its settings are the
// content ones only (title, a header link, a footer); no colours, fonts, width or CSS, so a theme appears as it was designed. The theme
// thumbnails and the Theme screen's "Start fresh" preview are both this blog (a copy of examples/blog, which has the same posts).
export const EXAMPLE_BLOG = Object.freeze({
  title: 'Example Blog',
  description: 'A blog that is a GitHub repository, rendered by blog.webcli.app.',
  author: 'Ada Example',
  domain: 'https://example.github.io/blog',
  customize: Object.freeze({
    header: { links: [{ label: 'About', url: 'https://example.com/about' }] },
    footer: { text: '© 2026 Ada Example', links: [{ label: 'Source', url: 'https://github.com/example/blog' }] },
  }),
});

export const EXAMPLE_ENTRIES = Object.freeze([
  { slug: 'static-hls-in-git', title: 'Static HLS in git', date: '2026-11-05', tags: ['video', 'git'], author: 'Ada Example', excerpt: 'HLS is a playlist and a pile of segments. Both are static files, which means git can hold them and a static host can serve them — no streaming server, no…' },
  { slug: 'markdown-is-the-format', title: 'Markdown is the format of record', date: '2026-11-01', tags: ['writing'], author: 'Ada Example', excerpt: 'A post stored as Quill Delta is JSON that only Quill can read. A post stored as markdown is a file that every tool in the world can read, diff and review.' },
]);

export const EXAMPLE_MENU = Object.freeze([{ label: 'Archive', href: '#' }, { label: 'Tags', href: '#' }]);

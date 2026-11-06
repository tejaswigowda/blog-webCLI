// A build extension: a pure function over data. It runs at publish, in a sandbox with no DOM,
// no network and no credentials, and what it returns is committed. The page never runs it.
export const hooks = {
  'post:html'(html) {
    const words = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    const minutes = Math.max(1, Math.round(words / 220));
    return `<p class="reading-time">${minutes} min read</p>\n${html}`;
  },
};

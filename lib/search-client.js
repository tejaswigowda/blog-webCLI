// The search page's script. No imports and no network beyond one same-origin file (search.json, written at
// publish): matching runs in the reader's browser, so there is nothing to host and nothing is sent anywhere.
// Results are built as DOM text, never as markup, so a post's words cannot become markup.

export const tokenize = (q) => String(q || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const count = (hay, needle) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0 && n < 5; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
};

// Every term must appear somewhere in the post; a term in the title counts most, then tags, then the excerpt, then the body.
// Equal scores keep the blog's own order.
export function rank(posts, query) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const out = [];
  posts.forEach((post, i) => {
    const title = post.title.toLowerCase();
    const tags = (post.tags || []).join(' ').toLowerCase();
    const excerpt = (post.excerpt || '').toLowerCase();
    const text = (post.text || '').toLowerCase();
    let score = 0;
    for (const t of terms) {
      const s = (title.includes(t) ? 8 : 0) + (tags.includes(t) ? 4 : 0) + (excerpt.includes(t) ? 2 : 0) + count(text, t);
      if (!s) return;
      score += s;
    }
    out.push({ post, score, i });
  });
  return out.sort((a, b) => b.score - a.score || a.i - b.i).map(({ post, score }) => ({ post, score }));
}

// A short passage around the first place a term occurs in the body; the excerpt when none does.
export function snippet(post, query, width = 160) {
  const text = (post.text || '').replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  for (const t of tokenize(query)) {
    const at = lower.indexOf(t);
    if (at < 0) continue;
    const from = Math.max(0, at - Math.floor(width / 3));
    let cut = text.slice(from, from + width);
    const more = from + width < text.length;
    if (from > 0 && /\S/.test(text[from - 1])) cut = cut.replace(/^\S*\s*/, ''); // a word cut in half at either end is dropped
    if (more && /\S/.test(text[from + width])) cut = cut.replace(/\s*\S*$/, '');
    return `${from > 0 ? '… ' : ''}${cut.trim()}${more ? ' …' : ''}`;
  }
  return post.excerpt || '';
}

export async function mount(doc, base) {
  const root = doc.querySelector('[data-webcli-search]');
  if (!root) return;
  const form = root.querySelector('form');
  const input = root.querySelector('input[type="search"]');
  const status = root.querySelector('[data-status]');
  const results = root.querySelector('[data-results]');
  const nojs = root.querySelector('[data-nojs]');
  if (nojs) nojs.remove();
  let posts = null;
  const el = (tag, text) => {
    const e = doc.createElement(tag);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  async function load() {
    if (!posts) {
      const res = await fetch(new URL('search.json', base));
      if (!res.ok) throw new Error(`search.json: ${res.status}`);
      posts = (await res.json()).posts || [];
    }
    return posts;
  }
  async function run(query, remember) {
    results.replaceChildren();
    if (!tokenize(query).length) {
      status.textContent = '';
      return;
    }
    let found;
    try {
      found = rank(await load(), query);
    } catch {
      status.textContent = 'Search is not available right now.';
      return;
    }
    status.textContent = found.length ? `${found.length} result${found.length === 1 ? '' : 's'}` : 'Nothing found.';
    for (const { post } of found) {
      const li = el('li');
      const h2 = el('h2');
      const a = el('a', post.title);
      a.href = new URL(`${post.slug}/`, base).href;
      h2.append(a);
      li.append(h2);
      const s = snippet(post, query);
      if (s) li.append(el('p', s));
      results.append(li);
    }
    if (remember && doc.defaultView && doc.defaultView.history) {
      const u = new URL(doc.defaultView.location.href);
      u.searchParams.set('q', query);
      doc.defaultView.history.replaceState(null, '', u);
    }
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(input.value, true);
  });
  const q = doc.defaultView ? new URL(doc.defaultView.location.href).searchParams.get('q') : null;
  if (q) {
    input.value = q;
    await run(q, false);
  }
}

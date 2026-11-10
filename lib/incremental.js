// Publishing one post to a big blog without building the whole blog. The committed files already say what the rest of the blog is
// (index/posts.json holds every post's entry and the resolved order), so a change to one post needs: that post, the posts whose
// previous/next links change, and the newest few for the feed. Everything made of the index (the listing pages, the feed, the
// sitemap, the index itself) is made again from the new index, by the same functions the full build uses, and the search shard
// the post belongs to is spliced. The result is the files a full build would write that differ; a test holds the two equal.
// Anything this cannot be sure of (another generator wrote the index, extensions, a hand-kept order, a small blog, a header that
// changes, a standalone page) is `reason`: the caller builds all of it, as it always did. Pure: the caller reads what it asks for.
import { checkAliases, parseAliases } from './aliases.js';
import { parseComments } from './comments.js';
import { resolveAsset } from './assets.js';
import { AUTO_COVER, autoCover } from './cover.js';
import { FEED_LIMIT, GENERATED_TREES, POST_PATH, SEARCH_SHARD_OVER, checkPostReferences, entryOf, indexData, indexFiles, json, parsePost, renderPost, searchPost, shardOf, sharedTopLevel, sitemapMetas, withCoverUrls } from './blog.js';
import { contentBase, liveEnabled } from './content.js';
import { plainLines } from './html.js';
import { renderContext } from './live-render.js';
import { buildListings, sitemapFiles } from './listings.js';
import { neighbours, resolveOrder, sequenceOf } from './order.js';
import { GENERATOR_ID, atomFeed, redirectPage } from './page.js';
import { affectedBy, relatedCount, relatedFor } from './related.js';
import { paginationSize, searchEnabled, sitemapEnabled } from './seo.js';
import { siteModel } from './site-model.js';

export const INCREMENTAL_MIN_POSTS = 300;
const fallback = (reason) => ({ reason });
const asPost = (e) => ({ slug: e.slug, path: `posts/${e.slug}.md`, meta: { date: e.date, title: e.title } });
const shellOf = (m) => JSON.stringify([m.menu, !!m.authorPath]);

// site: what lib/live-render.js loadSite read of the committed blog (blog.json, assets.lock.json, index/posts.json, theme.css, licences.json).
// change: { path: 'posts/<slug>.md', text, comments? } the post as it will be; `comments` is its comments/<slug>.json as it will be (text, or null for none) when that changes too, else the committed one is read. lock: the pins it will have. slugs: every slug the blog has a file for.
// existing: the paths in the blog's tree. -> { reason } or { need: { slugs, files }, run({ texts: Map(slug -> markdown), files: Map(path -> text) }) -> { files, remove } }
export function prepareIncremental({ site, change, lock, slugs, existing, minPosts = INCREMENTAL_MIN_POSTS }) {
  const { index, blog } = site;
  if (!index || ![2, 3].includes(index.version) || index.generatorId !== GENERATOR_ID || !Array.isArray(index.posts)) return fallback('the committed index was not written by this version of the generator');
  if (blog.extensions && blog.extensions.length) return fallback('the blog uses extensions');
  const order = resolveOrder(blog);
  if (order.by !== 'date' && order.by !== 'title') return fallback('the blog is in a hand-kept or field order');
  if (!POST_PATH.test(change.path)) return fallback('a standalone page');
  const post = parsePost(change);
  if (post.lossy) throw post.lossy;
  const slug = post.slug;
  const published = post.status === 'published';

  const old = index.posts;
  const oldSeq = sequenceOf({ order, posts: old.map(asPost) });
  if (oldSeq.errors.length || oldSeq.slugs.join('\n') !== (index.sequence || []).join('\n')) return fallback('the recorded order is not what the order setting gives');
  const others = old.filter((e) => e.slug !== slug);
  const seq = sequenceOf({ order, posts: [...others.map(asPost), ...(published ? [{ slug, path: change.path, meta: post.meta }] : [])] });
  if (seq.errors.length) return fallback('the order could not be resolved');
  if (seq.slugs.length < minPosts) return fallback('a small blog');
  if (searchEnabled(blog) && (seq.slugs.length <= SEARCH_SHARD_OVER || old.length <= SEARCH_SHARD_OVER)) return fallback('the search index is not in shards');

  const author = post.meta.author || blog.author;
  const meta = (e) => ({ slug: e.slug, title: e.title, date: e.date, tags: e.tags || [], author: e.author });
  const newMeta = [...others.map(meta), ...(published ? [{ slug, title: post.meta.title, date: post.meta.date, tags: post.meta.tags || [], author }] : [])];
  const pages = index.pages || [];
  if (shellOf(siteModel(blog, { entries: old, pages })) !== shellOf(siteModel(blog, { entries: newMeta, pages }))) return fallback('the header of every page changes (the first tag or a second author)');

  // old addresses: the blog's own, with this post's replaced
  const kept = new Map();
  for (const r of (index.redirects || []).filter((x) => x.slug !== slug)) kept.set(r.slug, [...(kept.get(r.slug) || []), r.from]);
  const pageSlugs = new Set(pages.map((x) => x.slug));
  const items = [...kept].map(([s, aliases]) => ({ path: `${pageSlugs.has(s) ? 'pages' : 'posts'}/${s}.md`, slug: s, aliases }));
  if (published) items.push({ path: change.path, slug, aliases: parseAliases(post.meta, change.path) });
  const redirects = checkAliases(items, { slugs, shared: sharedTopLevel(blog) });
  if (redirects.errors.length) throw redirects.errors[0];

  // whose previous/next changes, and which posts the feed holds
  const titles = (list) => new Map(list.map((e) => [e.slug, e.title]));
  const oldTitles = titles(old);
  const newTitles = titles(newMeta);
  const nav = (slugsList, ts) => {
    const at = new Map(slugsList.map((s, i) => [s, i]));
    return (s) => {
      const i = at.get(s);
      const p = slugsList[i - 1];
      const n = slugsList[i + 1];
      return `${p}|${p && ts.get(p)}|${n}|${n && ts.get(n)}`;
    };
  };
  const was = nav(oldSeq.slugs, oldTitles);
  const now = nav(seq.slugs, newTitles);
  const oldHas = new Set(oldSeq.slugs);
  const neighbours_ = seq.slugs.filter((s) => s !== slug && oldHas.has(s) && was(s) !== now(s));
  // related posts: exactly the pages whose block changes (those sharing a tag with this post, before or after, or that listed it)
  const rc = relatedCount(blog);
  const relatedChanged = affectedBy({ oldEntries: old, oldSequence: oldSeq.slugs, newEntries: newMeta, newSequence: seq.slugs, slug, count: rc });
  const feed = seq.slugs.slice(0, FEED_LIMIT);
  const need = { slugs: [...new Set([...neighbours_, ...relatedChanged, ...feed])].filter((s) => s !== slug), files: searchEnabled(blog) ? [`search/data-${shardOf(slug)}.json`] : [] };
  // the comments of every page that is drawn again: only those that have a file (the caller reads exactly the files asked for)
  const sidecar = (s) => `comments/${s}.json`;
  const haveComments = (s) => existing.has(sidecar(s)) && !(s === slug && change.comments !== undefined);
  for (const s of [...need.slugs, slug]) if (haveComments(s)) need.files.push(sidecar(s));
  const shardName = `search/data-${shardOf(slug)}.json`;

  return {
    need,
    related: relatedChanged.length,
    run({ texts, files: given }) {
      const ctx = renderContext({ ...site, lock });
      const b = ctx.blog;
      const live = liveEnabled(blog) ? { base: contentBase(blog) } : null;
      const commentsFor = (s) => {
        const text = s === slug && change.comments !== undefined ? change.comments : given.get(sidecar(s));
        return text ? parseComments(text, sidecar(s)) : [];
      };
      const render = (p) => {
        const navigation = neighbours(seq.slugs, p.slug, newTitles, (s) => `../${s}/`);
        return renderPost(b, p, lock, { contract: ctx.contract, css: ctx.css, comment: ctx.comment, hooks: ctx.hooks, logoUrl: ctx.logoUrl, live, nav: navigation, site: ctx.site, comments: commentsFor(p.slug), related: relatedFor(newMeta, seq.slugs, p.slug, rc) });
      };
      const out = {};
      const rendered = new Map();
      let entry = null;
      if (published) {
        checkPostReferences(post, b, lock);
        const r = render(post);
        rendered.set(slug, r);
        entry = entryOf(b, post, r, post.meta.cover === AUTO_COVER ? autoCover(post.delta, b) : null);
        out[`${slug}/index.html`] = r.html;
      }
      for (const s of need.slugs) {
        const text = texts.get(s);
        if (text === undefined) throw new Error(`incremental: the text of ${s} was not read`);
        const p = parsePost({ path: `posts/${s}.md`, text });
        const r = render(p);
        rendered.set(s, r);
        if (neighbours_.includes(s) || relatedChanged.includes(s)) out[`${s}/index.html`] = r.html;
      }
      const byEntry = new Map(others.map((e) => [e.slug, e]));
      if (entry) {
        const { html, ...pub } = entry;
        byEntry.set(slug, pub);
      }
      const posts = seq.slugs.map((s) => byEntry.get(s));
      const feedEntries = feed.map((s) => ({ ...byEntry.get(s), html: rendered.get(s).bodyHtml }));
      Object.assign(out, indexData({ order, sequence: seq.slugs, posts, pages, redirects: redirects.records, home: index.home || '', homeAfter: index.homeAfter || '' }));
      out['feed.xml'] = atomFeed({ blog: b, entries: feedEntries, base: b.domain });
      const listed = withCoverUrls(posts, b, lock);
      const size = paginationSize(b);
      const indexImage = b.cover ? resolveAsset(b.cover, b, lock) : null;
      Object.assign(out, indexFiles({ blog: b, entries: listed, size, contract: ctx.contract, css: ctx.css, comment: ctx.comment, logoUrl: ctx.logoUrl, site: ctx.site, hooks: ctx.hooks, live, indexImage, homeHtml: ctx.home, homeAfterHtml: ctx.homeAfter }));
      const finalSite = siteModel(b, { entries: posts, pages });
      Object.assign(out, buildListings({ blog: b, contract: ctx.contract, css: ctx.css, comment: ctx.comment, logoUrl: ctx.logoUrl, site: finalSite, entries: listed, size, search: searchEnabled(b) }));
      if (searchEnabled(b)) {
        const shard = given.get(shardName);
        if (shard === undefined) throw new Error('incremental: the search shard was not read');
        const had = new Map(JSON.parse(shard).posts.map((x) => [x.slug, x]));
        const text = published ? plainLines(post.delta).map((l) => l.text).filter(Boolean).join('\n') : '';
        out[shardName] = json({ version: 1, posts: posts.filter((e) => shardOf(e.slug) === shardOf(slug)).map((e) => (e.slug === slug ? searchPost(e, text) : had.get(e.slug))) });
        if (out[shardName].includes('undefined') || posts.some((e) => shardOf(e.slug) === shardOf(slug) && e.slug !== slug && !had.has(e.slug))) throw new Error('incremental: the search shard is out of step with the index');
      }
      if (sitemapEnabled(b)) Object.assign(out, sitemapFiles({ blog: b, entries: posts, pages, metas: sitemapMetas(posts, pages), site: finalSite }));
      const titleOf = new Map([...posts, ...pages].map((e) => [e.slug, e.title]));
      for (const r of redirects.records) out[`${r.from}/index.html`] = redirectPage({ blog: b, from: r.from, slug: r.slug, title: titleOf.get(r.slug) });

      // what is no longer wanted: the page of a post that is gone, a redirect whose alias is gone, anything left in a folder
      // the generator owns (the search shards are each written only when their own post changes)
      const remove = [];
      const shards = new Set(Array.from({ length: 16 }, (_, i) => `search/data-${i}.json`));
      if (!published && existing.has(`${slug}/index.html`)) remove.push(`${slug}/index.html`);
      const wanted = new Set(redirects.records.map((r) => `${r.from}/index.html`));
      for (const r of index.redirects || []) if (!wanted.has(`${r.from}/index.html`) && existing.has(`${r.from}/index.html`)) remove.push(`${r.from}/index.html`);
      for (const f of existing) if (GENERATED_TREES.some((t) => f.startsWith(`${t}/`)) && !(f in out) && !shards.has(f)) remove.push(f);
      return { files: out, remove: [...new Set(remove)].sort(), sequence: seq.slugs };
    },
  };
}

// With no images or video repository entered, media lives in folders of the blog's own repository
// (images/, videos/). The default is not part of blog.json: it is readable but never written back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { executePlan, listVideoReleases, loadBlog, planChange, planSettings } from '../app/site.js';
import { authored, buildSite, sharedTopLevel, validateBlog, withRepoOverrides } from '../lib/blog.js';
import { blogToForm, formToBlog } from '../lib/settings.js';
import { fakeGitHub } from './fake-github.js';

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'blog');
const read = async (f) => fs.readFile(path.join(EXAMPLE, f), 'utf8');

// the example blog.json with no media sections, living where `repo` says
async function bare(repo, patch = {}) {
  const b = JSON.parse(await read('blog.json'));
  delete b.assets;
  delete b.video;
  delete b.cover;
  b.repo = repo;
  return { ...b, ...patch };
}

test('defaults: images and videos are folders of the blog\'s own repository, and stay out of the file', async () => {
  const blog = validateBlog(JSON.stringify(await bare('me/blog')));
  assert.deepEqual(blog.assets.repos, { images: 'me/blog/images' });
  assert.deepEqual(blog.video.repos, { videos: 'me/blog/videos' });
  assert.match(blog.assets.base, /^https:\/\/cdn\.jsdelivr\.net\/gh\/\{owner\}\/\{repo\}@\{sha\}\/\{path\}$/);
  assert.equal(blog.video.player, 'https://strataeditor.dev/player/');
  // readable, but not an own enumerable property: never spread, cloned or serialised
  assert.equal(authored(blog, 'assets'), undefined);
  assert.equal(authored(blog, 'video'), undefined);
  assert.ok(!('assets' in JSON.parse(JSON.stringify(blog))) && !('video' in JSON.parse(JSON.stringify(blog))));
  assert.equal(structuredClone(blog).assets, undefined);
  assert.equal({ ...blog }.assets, undefined);
  // and re-validating what was validated gives the same thing
  const again = validateBlog(blog);
  assert.deepEqual(again.assets, blog.assets);
  assert.equal(authored(again, 'assets'), undefined);

  // a blog in a folder keeps its media beside the folder, in the repository
  const inFolder = validateBlog(JSON.stringify(await bare('me/site/blog')));
  assert.deepEqual(inFolder.assets.repos, { images: 'me/site/images' });
  assert.deepEqual(inFolder.video.repos, { videos: 'me/site/videos' });
});

test('defaults: only when nothing was entered, never over what the author wrote, never the blog\'s own place', async () => {
  const writes = await bare('me/blog', { assets: { base: 'https://cdn.example/{owner}/{repo}@{sha}/{path}', repos: { photos: 'me/photos' } }, video: { player: 'https://p.example/', base: 'https://cdn.example/{owner}/{repo}@{tag}/{slug}/', repos: { reels: 'me/reels' } } });
  const blog = validateBlog(JSON.stringify(writes));
  assert.deepEqual(blog.assets.repos, { photos: 'me/photos' }, 'an author-entered repository is used as it is');
  assert.deepEqual(blog.video.repos, { reels: 'me/reels' });
  assert.deepEqual(authored(blog, 'assets').repos, { photos: 'me/photos' });

  const only = validateBlog(JSON.stringify(await bare('me/blog', { video: writes.video })));
  assert.deepEqual(only.assets.repos, { images: 'me/blog/images' }, 'each section defaults on its own');
  assert.deepEqual(only.video.repos, { reels: 'me/reels' });

  const none = await bare('me/blog');
  delete none.repo;
  const unknown = validateBlog(JSON.stringify(none));
  assert.equal(unknown.assets, undefined, 'a blog that does not say where it lives has no default');
  assert.equal(unknown.video, undefined);

  // a blog that itself lives in me/blog/images does not get its own folder as the image home
  const clash = validateBlog(JSON.stringify(await bare('me/blog/images')));
  assert.equal(clash.assets, undefined);
  assert.deepEqual(clash.video.repos, { videos: 'me/blog/videos' });
});

test('defaults: images resolve to pinned addresses in the blog\'s repository, and unresolved references still refuse', async () => {
  const post = (body) => ({ path: 'posts/pic-post.md', text: `---\nslug: pic-post\ntitle: P\ndate: 2026-01-01\nstatus: published\n---\n\n${body}\n` });
  const lock = { 'images/pic.png': 'a'.repeat(40) };
  const blog = JSON.stringify(await bare('me/site/blog'));
  const out = buildSite({ blog, lock, posts: [post('![x](asset:images/pic.png)')] });
  assert.deepEqual(out.errors, []);
  assert.ok(out.files['pic-post/index.html'].includes(`me/site@${'a'.repeat(40)}/images/pic.png`));
  assert.ok(!/jsdelivr/.test(post('![x](asset:images/pic.png)').text), 'the source still names no provider');
  const missing = buildSite({ blog, lock, posts: [post('![x](asset:images/other.png)')] });
  assert.deepEqual(missing.errors.map((e) => e.code), ['unresolved-asset'], 'a reference with no pinned file is still refused');
  const wrongKey = buildSite({ blog, lock, posts: [post('![x](asset:photos/pic.png)')] });
  assert.deepEqual(wrongKey.errors.map((e) => e.code), ['unresolved-asset'], 'only the images key has a default');
  const video = buildSite({ blog, lock, posts: [post('![](video:videos/clip@v2)')] });
  assert.deepEqual(video.errors, []);
  assert.ok(video.files['pic-post/index.html'].includes('me/site@clip/v2/videos/clip/'));
});

test('defaults: the Settings form shows a defaulted field blank, and saving it writes nothing', async () => {
  const blog = validateBlog(JSON.stringify(await bare('me/blog')));
  const form = blogToForm(blog);
  for (const k of ['images', 'audio', 'video', 'assetBase', 'videoPlayer', 'videoBase']) assert.equal(form[k], '', k);
  const next = formToBlog(blog, form);
  assert.ok(!('assets' in next) && !('video' in next), 'nothing the author did not enter is written');
  assert.deepEqual(Object.keys(next).sort(), Object.keys(await bare('me/blog')).sort(), 'and the rest of blog.json comes back as it was');
  // entering a value writes it; clearing it again goes back to the default
  const set = formToBlog(blog, { ...form, images: 'me/pictures' });
  assert.deepEqual(set.assets.repos, { images: 'me/pictures' });
  assert.deepEqual(validateBlog(set).assets.repos, { images: 'me/pictures' });
  assert.ok(!('assets' in formToBlog(validateBlog(set), { ...blogToForm(validateBlog(set)), images: '' })));
});

test('defaults: the reader\'s hash overrides win, and a default survives an override of something else', async () => {
  const blog = validateBlog(JSON.stringify(await bare('me/blog')));
  const audioOnly = withRepoOverrides(blog, { audio: 'me/audio' });
  assert.deepEqual(audioOnly.assets.repos, { images: 'me/blog/images', audio: 'me/audio' });
  const images = withRepoOverrides(blog, { images: 'me/pics' });
  assert.deepEqual(images.assets.repos, { images: 'me/pics' });
  const video = withRepoOverrides(blog, { video: 'me/renders' });
  assert.deepEqual(video.video.repos, { videos: 'me/renders' });
  assert.deepEqual(video.assets.repos, { images: 'me/blog/images' });
});

test('defaults: a default folder reserves no slug, but a folder the author configured still does', async () => {
  assert.deepEqual([...sharedTopLevel(validateBlog(JSON.stringify(await bare('me/blog'))))], []);
  const explicit = validateBlog(JSON.stringify(await bare('me/blog', { assets: { base: 'https://cdn.example/{sha}/{path}', repos: { images: 'me/blog/images' } } })));
  assert.deepEqual([...sharedTopLevel(explicit)], ['images']);
  const post = { path: 'posts/images.md', text: '---\nslug: images\ntitle: Images\ndate: 2026-01-01\nstatus: published\n---\n\nAbout images.\n' };
  assert.deepEqual(buildSite({ blog: JSON.stringify(await bare('me/blog')), posts: [post] }).errors, [], 'a post called images is fine while nothing is configured');
});

// ---------- the app, against an in-memory GitHub ----------
const SITE = 'example/site/blog';
async function world() {
  const files = { 'blog/blog.json': JSON.stringify(await bare(SITE), null, 2) + '\n', '.nojekyll': '', 'images/old.png': 'PNG', 'videos/hls-demo/render.json': '{}' };
  const server = fakeGitHub({ 'example/site': files }, { tags: { 'example/site': ['hls-demo/v1', 'hls-demo/v2'] } });
  await server.ready;
  const net = createNet(server.fetch);
  return { server, authed: new GitHub(net, { token: 'github_pat_test' }) };
}
const POST = (extra = '', body = 'Words.') => `---\nslug: fresh\ntitle: Fresh\ndate: 2026-11-07\nstatus: published\n${extra}---\n\n${body}\n`;

test('defaults: an image is committed to the blog\'s repository, pinned, and blog.json is left as it was', async () => {
  const { server, authed } = await world();
  const { blog } = await loadBlog(authed, SITE, 'main');
  assert.deepEqual(blog.assets.repos, { images: 'example/site/images' });

  const bytes = Uint8Array.from([137, 80, 78, 71, 7]);
  const plan = await planChange(authed, { repo: SITE, branch: 'main', slug: 'fresh', text: POST('cover: asset:images/new.png\n'), staged: [{ key: 'images', path: 'new.png', bytes }] });
  assert.equal(plan.assetGroups[0].files[0].path, 'images/new.png');
  assert.ok(!plan.changes.some((c) => c.path === 'blog/blog.json'), 'blog.json is not rewritten to record a default');
  const receipt = await executePlan(authed, plan);
  assert.equal(receipt.commits.length, 2);
  const after = server.files('example/site');
  assert.ok('images/new.png' in after);
  assert.ok(!('assets' in JSON.parse(after['blog/blog.json'])) && !('video' in JSON.parse(after['blog/blog.json'])));
  assert.ok(after['blog/fresh/index.html'].includes(`example/site@${receipt.commits[0].sha}/images/new.png`));
  assert.ok(!/jsdelivr/.test(after['blog/posts/fresh.md']));
});

test('defaults: videos are checked against tags in the blog\'s repository', async () => {
  const { authed } = await world();
  const ok = await planChange(authed, { repo: SITE, branch: 'main', slug: 'fresh', text: POST('', '![](video:videos/hls-demo@v2)') });
  assert.ok(ok.changes.some((c) => c.path === 'blog/fresh/index.html' && c.content.includes('example/site@hls-demo/v2/videos/hls-demo/')));
  await assert.rejects(planChange(authed, { repo: SITE, branch: 'main', slug: 'fresh', text: POST('', '![](video:videos/hls-demo@v9)') }), (e) => e.code === 'unresolved-asset');
  const { blog } = await loadBlog(authed, SITE, 'main');
  const releases = await listVideoReleases(authed, blog);
  assert.deepEqual(releases.map((r) => r.ref).sort(), ["video:videos/hls-demo@v1", "video:videos/hls-demo@v2"]);
});

test('defaults: saving Settings with those fields blank leaves blog.json without them', async () => {
  const { server, authed } = await world();
  const { blog } = await loadBlog(authed, SITE, 'main');
  const form = { ...blogToForm(blog), title: 'A new title' };
  const plan = await planSettings(authed, { repo: SITE, branch: 'main', form });
  await executePlan(authed, plan);
  const saved = JSON.parse(server.files('example/site')['blog/blog.json']);
  assert.equal(saved.title, 'A new title');
  assert.ok(!('assets' in saved) && !('video' in saved), 'the defaults were not written down');
});

// Uploading a video: inspect it, encode it into a release, publish and embed. The segmenter, playlists,
// manifest and release code are the real ones; only the browser's WebCodecs encoder is replaced
// (by one that repackages the upload's own samples), as in hls-webCLI's own tests. Source videos are
// made with ffmpeg, a test-time tool: these tests skip when it is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNet } from '../app/net.js';
import { GitHub } from '../app/github.js';
import { encodeToRelease, estimateBytes, inspectUpload, nameProblem, slugFromFilename, webCodecsAvailable } from '../app/encode.js';
import { executeRelease, listReleaseFolders } from '../app/release.js';
import { loadBlog, planChange } from '../app/site.js';
import { packageRendition } from '../vendor/hls/strata/fmp4.js';
import { packageAudio } from '../vendor/hls/strata/audio.js';
import { fakeGitHub } from './fake-github.js';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = HAS_FFMPEG ? false : 'no ffmpeg on this machine to make source videos';
const dir = HAS_FFMPEG ? mkdtempSync(join(tmpdir(), 'blog-encode-')) : null;
const SPECS = {
  // 6 s, 30 fps, a keyframe every 60 frames, AAC audio, 320x180
  small: ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
  // 720p, B-frames, no audio: the 720 and 480 rungs fit
  hd: ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-bf', '2', '-pix_fmt', 'yuv420p'],
  vfr: ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=6', '-vf', "select='not(mod(n,7))+eq(n,1)'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
  frac: ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30000/1001:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
  hevc: ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=2', '-c:v', 'libx265', '-tag:v', 'hvc1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
};
const made = new Map();
function video(name) {
  if (!made.has(name)) {
    const out = join(dir, `${name}.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...SPECS[name], out], { stdio: 'pipe' });
    made.set(name, new Uint8Array(readFileSync(out)));
  }
  return made.get(name);
}

// the browser's encoder replaced by one that repackages the upload's own samples
const fakeDeps = {
  aacSupport: async () => ({ ok: true, reason: '' }),
  transcodeLadder: async ({ master, ladder }) => ({
    rungs: ladder.map((rung) => ({
      rung,
      packaged: packageRendition({ width: master.width, height: master.height, fps: master.fps, avcC: master.avcC, samples: master.samples, keyframes: master.keyframes }),
      encoder: { kind: 'software', name: 'fake', version: null, settings_hash: 'sha256:' + '0'.repeat(64), threads: null, config: { codec: 'avc1', width: rung.width, height: rung.height, bitrate: rung.kbps * 1000, framerate: master.fps } },
    })),
    poster: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  }),
  buildAudioRendition: async ({ durationSeconds, videoStartsSeconds }) => {
    const n = Math.ceil((durationSeconds * 48000) / 1024);
    const frames = Array.from({ length: n }, (_, i) => new Uint8Array(100).fill(i & 255));
    return { packaged: packageAudio({ frames, asc: new Uint8Array([0x11, 0x90]), videoStartsSeconds }), delaySamples: 2112 };
  },
};

const BLOG = JSON.stringify({ title: 'T', description: 'd', author: 'A', domain: 'https://example.github.io/site/blog', repo: 'example/site/blog' });
const WHERE = 'example/site/videos';
async function world() {
  const server = fakeGitHub({ 'example/site': { 'blog/blog.json': BLOG + '\n', '.nojekyll': '' } });
  await server.ready;
  const gh = new GitHub(createNet(server.fetch), { token: 'github_pat_test' });
  return { server, gh };
}
const encode = (gh, name, bytes, extra = {}) => encodeToRelease(gh, { where: WHERE, file: { name: `${name}.mp4`, bytes }, name, deps: fakeDeps, ...extra });

test('names: a file name becomes a release name, and hls-webCLI\'s naming rules still apply', () => {
  assert.equal(slugFromFilename('My Sunrise (final).MP4'), 'my-sunrise-final');
  assert.equal(nameProblem('sunrise-timelapse'), null);
  for (const bad of ['', 'Sunrise', 'test', 'video', 'a b']) assert.ok(nameProblem(bad), bad);
  assert.equal(webCodecsAvailable({}), false);
  assert.equal(webCodecsAvailable({ VideoDecoder: 1, VideoEncoder: 1, VideoFrame: 1 }), true);
});

test('inspect: size, frame rate and the rungs that fit; every refusal comes with hls-webCLI\'s reason', { skip }, () => {
  const small = inspectUpload(video('small'));
  assert.equal(small.ok, true);
  assert.deepEqual([small.info.width, small.info.height, small.info.fps, small.hasAudio], [320, 180, 30, true]);
  assert.ok(Math.abs(small.info.duration - 6) < 0.1);
  assert.deepEqual(small.rungs.map((r) => r.height), [180], 'smaller than the lowest rung: one rung at its own size, never upscaled');

  const hd = inspectUpload(video('hd'));
  assert.deepEqual(hd.rungs.map((r) => r.height), [720, 480], 'every rung that fits, highest first');
  assert.equal(hd.hasAudio, false);
  const six = (kbps) => Math.round((kbps * 1000 * hd.info.duration) / 8);
  assert.deepEqual(hd.rungs.map((r) => r.bytes), [six(1800), six(900)]);
  assert.equal(estimateBytes(hd, [720, 480], 'keep'), six(1800) + six(900));
  assert.equal(estimateBytes(hd, [480], 'keep'), six(900));
  assert.equal(estimateBytes(small, [180], 'drop') < estimateBytes(small, [180], 'keep'), true, 'dropping the audio drops its share');

  const why = (b) => inspectUpload(b).refusal.reason;
  assert.equal(why(video('vfr')), 'vfr-input');
  assert.equal(why(video('frac')), 'fractional-frame-rate');
  assert.equal(why(video('hevc')), 'unsupported-codec');
  assert.equal(why(new Uint8Array(100)), 'not-mp4');
  assert.match(inspectUpload(video('vfr')).refusal.detail, /./);
});

test('encode: the upload becomes one planned release, in the video folder, that the blog\'s own checks accept', { skip }, async () => {
  const { gh } = await world();
  const progress = [];
  const out = await encode(gh, 'sunrise-timelapse', video('small'), { onProgress: (f, t) => progress.push([f, t]) });
  const { plan, summary } = out;
  assert.equal(plan.tag, 'sunrise-timelapse/v1');
  assert.equal(plan.dir, 'videos/sunrise-timelapse/');
  assert.ok(progress.length && progress.at(-1)[0] === 1, 'progress ran to the end');
  const paths = plan.changes.map((c) => c.path.slice(plan.dir.length));
  for (const must of ['master.m3u8', 'render.json', 'files.sha256', 'poster.jpg', '180p30/index.m3u8', '180p30/init.mp4', 'audio/index.m3u8']) assert.ok(paths.includes(must), must);
  assert.ok(plan.changes.every((c) => c.action === 'add' && c.path.startsWith('videos/sunrise-timelapse/')));
  assert.deepEqual(summary.rungs, ['180p30']);
  assert.equal(summary.info.fps, 30);
  const render = JSON.parse(new TextDecoder().decode(plan.changes.find((c) => c.path.endsWith('/render.json')).bytes));
  assert.equal(render.publication.tag, 'sunrise-timelapse/v1', 'render.json names the tag the release gets');
  assert.equal(render.render.determinism.frames, false, 'an uploaded video makes no claim of Strata\'s time-source audit');
});

test('encode: committed, tagged, listed and embeddable in a post, with nothing sent before the commit', { skip }, async () => {
  const { server, gh } = await world();
  const before = Object.keys(server.files('example/site')).length;
  const { plan } = await encode(gh, 'sunrise-timelapse', video('small'));
  assert.equal(Object.keys(server.files('example/site')).length, before, 'encoding wrote nothing');
  assert.equal(Object.keys(server.state['example/site'].tagRefs).length, 0);

  const receipt = await executeRelease(gh, plan);
  const S = server.state['example/site'];
  assert.equal(S.tagRefs['sunrise-timelapse/v1'], receipt.commit.sha);
  const after = server.files('example/site');
  assert.ok(after['videos/sunrise-timelapse/master.m3u8'].startsWith('#EXTM3U'));
  assert.equal(after['blog/blog.json'], BLOG + '\n', 'the blog is untouched');

  const { blog } = await loadBlog(gh, 'example/site/blog', 'main');
  const [r] = await listReleaseFolders(gh, blog);
  assert.deepEqual(r.folders.map((f) => [f.name, f.state, f.latest]), [['sunrise-timelapse', 'released', 1]]);

  const post = `---\nslug: sunrise\ntitle: Sunrise\ndate: 2026-11-08\nstatus: published\n---\n\n![](video:videos/sunrise-timelapse@v1)\n`;
  const publish = await planChange(gh, { repo: 'example/site/blog', branch: 'main', slug: 'sunrise', text: post, create: true });
  assert.ok(publish.changes.some((c) => c.path === 'blog/sunrise/index.html' && c.content.includes('example/site@sunrise-timelapse/v1/videos/sunrise-timelapse/')));
});

test('encode: rungs are choosable, and the audio can be dropped', { skip }, async () => {
  const { gh } = await world();
  const names = async (extra) => (await encode(gh, 'harbour-walk', video('hd'), extra)).summary.rungs;
  assert.deepEqual(await names(), ['720p30', '480p30']);
  assert.deepEqual(await names({ keep: [480] }), ['480p30']);
  const dropped = await encode(gh, 'harbour-walk', video('small'), { audio: 'drop' });
  assert.ok(!dropped.plan.changes.some((c) => c.path.includes('/audio/')), 'no audio rendition');
  await assert.rejects(encode(gh, 'harbour-walk', video('hd'), { keep: [1080] }), (e) => e.code === 'bad-release' && /at least one rung/i.test(e.message));
});

test('encode: a second upload under the same name is the next version, and the first stays', { skip }, async () => {
  const { server, gh } = await world();
  const first = await encode(gh, 'sunrise-timelapse', video('small'));
  await executeRelease(gh, first.plan);
  const second = await encode(gh, 'sunrise-timelapse', video('hd'));
  assert.equal(second.plan.tag, 'sunrise-timelapse/v2');
  const r2 = await executeRelease(gh, second.plan);
  const S = server.state['example/site'];
  assert.notEqual(S.tagRefs['sunrise-timelapse/v1'], r2.commit.sha, 'v1 still points at the first commit');
  assert.ok(second.plan.changes.some((c) => c.delete && c.path.includes('/180p30/')), 'the old rung is removed, so the release is exactly the new render');
});

test('encode: refused before anything is sent, with the reason', { skip }, async () => {
  const { gh } = await world();
  const refused = (name, bytes, re) => assert.rejects(encode(gh, name, bytes), (e) => e.code === 'bad-release' && re.test(e.message));
  await refused('sunrise-timelapse', video('vfr'), /vfr-input/);
  await refused('sunrise-timelapse', video('hevc'), /unsupported-codec/);
  await refused('sunrise-timelapse', new Uint8Array(64), /not-mp4/);
  await refused('test', video('small'), /category|name/i);
});

test('encode: cancelling returns nothing and writes nothing', { skip }, async () => {
  const { server, gh } = await world();
  let asked = 0;
  const out = await encodeToRelease(gh, { where: WHERE, file: { name: 'a.mp4', bytes: video('small') }, name: 'sunrise-timelapse', deps: { ...fakeDeps, transcodeLadder: async () => (asked++, null) }, shouldCancel: () => true });
  assert.equal(out, null);
  assert.equal(asked, 1);
  assert.deepEqual(Object.keys(server.state['example/site'].tagRefs), []);
});

test('encode: if a release of that name appears while encoding, it refuses rather than mis-tag', { skip }, async () => {
  const { server, gh } = await world();
  const racing = { ...fakeDeps, transcodeLadder: async (a) => {
    await gh.createTag('example/site', 'sunrise-timelapse/v1', server.state['example/site'].branches.main);
    return fakeDeps.transcodeLadder(a);
  } };
  await assert.rejects(encode(gh, 'sunrise-timelapse', video('small'), { deps: racing }), (e) => e.code === 'bad-release' && /sunrise-timelapse\/v1 was the next version when encoding began, but sunrise-timelapse\/v2 is now/.test(e.message));
});

// ---------- the GitHub client: an upload is many writes, so a rate limit is waited out ----------
function limited(failures, status = 403) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    const n = calls.length;
    if (n <= failures) return new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }), { status, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ sha: 'abc' }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const waits = [];
  const told = [];
  const gh = new GitHub(createNet(fetch), { token: 'github_pat_test', wait: async (ms) => waits.push(ms) });
  gh.onWait = (s) => told.push(s);
  return { gh, calls, waits, told };
}

test('github: a secondary rate limit on a write is waited out and retried, and the page is told', async () => {
  const { gh, calls, waits, told } = limited(2);
  const out = await gh.api('POST', '/repos/o/r/git/blobs', { content: 'x', encoding: 'base64' });
  assert.deepEqual(out, { sha: 'abc' });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [70000, 140000]);
  assert.deepEqual(told, [70, 140]);
  const tooLong = limited(9, 429);
  await assert.rejects(tooLong.gh.api('POST', '/repos/o/r/git/blobs', {}), /rate limit/);
  assert.equal(tooLong.calls.length, 5, 'it gives up after four waits');
});

test('github: reads and other refusals are never retried', async () => {
  const read = limited(9);
  await assert.rejects(read.gh.api('GET', '/repos/o/r'), /GitHub 403/);
  assert.equal(read.calls.length, 1);
  const other = limited(0, 403);
  other.calls.length = 0;
  const denied = new GitHub(createNet(async () => new Response(JSON.stringify({ message: 'Resource not accessible by personal access token' }), { status: 403, headers: { 'content-type': 'application/json' } })), { token: 'github_pat_test', wait: async () => assert.fail('must not wait') });
  await assert.rejects(denied.api('POST', '/repos/o/r/git/blobs', {}), /not accessible/);
});

test('github: an upload reports its progress file by file', async () => {
  const server = fakeGitHub({ 'example/site': { 'a.txt': 'a' } });
  await server.ready;
  const gh = new GitHub(createNet(server.fetch), { token: 'github_pat_test' });
  const head = await gh.headCommit('example/site', 'main');
  const seen = [];
  await gh.commit('example/site', { branch: 'main', parent: head.sha, baseTree: head.treeSha, files: [{ path: 'x/1.bin', content: new Uint8Array([1]) }, { path: 'x/2.bin', content: new Uint8Array([2]) }, { path: 'x/3.bin', content: new Uint8Array([3]) }], message: 'm', onProgress: (done, total) => seen.push([done, total]) });
  assert.deepEqual(seen, [[0, 3], [1, 3], [2, 3]]);
});

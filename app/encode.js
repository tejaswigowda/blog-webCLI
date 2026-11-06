// Uploading a video from the editor: read an MP4/MOV, encode a ladder of HLS rungs in the browser
// (WebCodecs), and turn the result into a release (one commit, one tag) that the post embeds.
// The encoder is hls-webCLI's, vendored unedited in vendor/hls/ (GPL-3.0, like this app): the same
// code hls.webcli.app uses, so a render made here is the one that site would make. Nothing leaves
// the browser until the release is published, and the pre-flight says exactly what will be sent.
import { inspectVideo } from '../vendor/hls/lib/ingest.js';
import { RefusedError, prepareUpload, slugFromFilename } from '../vendor/hls/lib/prepare.js';
import { planLadder } from '../vendor/hls/strata/publishSet.js';
import { transcodeLadder } from '../vendor/hls/strata/ladder.js';
import { aacSupport, buildAudioRendition } from '../vendor/hls/strata/audio.js';
import { ReleaseError, slugProblem } from '../vendor/hls/strata/releases.js';
import { Refusal } from '../lib/errors.js';
import { parseRepoRef } from '../lib/reporef.js';
import { planUploadRelease } from './release.js';

export { slugFromFilename };

const AUDIO_KBPS = 128;
const DEFAULT_DEPS = { transcodeLadder, buildAudioRendition, aacSupport };

// Encoding needs the browser's WebCodecs; without them the dialog says so instead of failing later.
export const webCodecsAvailable = (w = globalThis) => !!(w.VideoDecoder && w.VideoEncoder && w.VideoFrame);

// Audio is kept only if this browser can also decode AAC (the encoder measures its start-up delay by
// decoding and will not guess). VS Code's and Electron's browsers have no AAC decoder.
export const audioDecodable = () => aacSupport();

export const nameProblem = (name) => slugProblem(name);

// What the picked file is, before anything is encoded: refused with hls-webCLI's reason, or its
// size, frame rate and duration, and every rung that fits it with a rough size of what it adds.
export function inspectUpload(bytes) {
  const seen = inspectVideo(bytes);
  if (!seen.ok) return { ok: false, refusal: { reason: seen.wouldRefuse.reason, detail: seen.wouldRefuse.detail } };
  const { width, height, fps, frames, codec } = seen.info;
  const duration = frames / fps;
  const rungs = planLadder({ width, height, fps }).map((r) => ({ ...r, bytes: Math.round((r.kbps * 1000 * duration) / 8) }));
  return { ok: true, info: { width, height, fps, frames, codec, duration }, hasAudio: seen.hasAudio, audioBytes: Math.round((AUDIO_KBPS * 1000 * duration) / 8), rungs };
}

// Roughly what the chosen rungs add to the repository.
export const estimateBytes = (inspected, keep, audio) => inspected.rungs.filter((r) => keep.includes(r.height)).reduce((n, r) => n + r.bytes, 0) + (inspected.hasAudio && audio === 'keep' ? inspected.audioBytes : 0);

// Encode `file` ({ name, bytes }) as release `name` of the video repository `where`, and plan its
// upload. Returns { plan, summary }, or null when cancelled. Reads the repository for the next
// version; writes nothing. `deps` replaces the browser-only encoder in tests.
export async function encodeToRelease(gh, { where, file, name, keep = null, audio = 'keep', onProgress = () => {}, shouldCancel = () => false, deps = DEFAULT_DEPS }) {
  const { repo } = parseRepoRef(where);
  const info = await gh.repoInfo(repo);
  const api = {
    get: (path) => gh.api('GET', path),
    send: () => {
      throw new Error('encoding does not write; the release is committed by the blog');
    },
  };
  let prepared;
  try {
    prepared = await prepareUpload({ file, slug: name, repo, branch: info.default_branch, keep, audio, canonical: false, api, deps, onProgress, shouldCancel });
  } catch (e) {
    if (e instanceof RefusedError) throw new Refusal('bad-release', `${e.reason}: ${e.detail}`);
    if (e instanceof ReleaseError) throw new Refusal('bad-release', e.message);
    throw e;
  }
  if (!prepared) return null;
  if (!prepared.gate.ok) throw new Refusal('bad-release', `the encoder's own checks failed: ${prepared.gate.failures.join('; ')}`);

  // the set's paths carry the name as a folder; a release is the folder's contents
  const prefix = `${name}/`;
  const files = prepared.set.files.map((f) => {
    if (!f.path.startsWith(prefix)) throw new Refusal('bad-release', `${f.path} is outside ${prefix}`);
    return { path: f.path.slice(prefix.length), bytes: f.bytes };
  });
  const plan = await planUploadRelease(gh, { where, name, files });
  if (plan.tag !== prepared.plan.tag) throw new Refusal('bad-release', `${prepared.plan.tag} was the next version when encoding began, but ${plan.tag} is now: a release was made meanwhile. Encode again.`);
  return { plan, summary: { info: prepared.info, rungs: prepared.ladder.map((r) => r.name), warning: prepared.set.warning || '' } };
}

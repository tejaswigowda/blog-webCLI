// ── renderJson.js ──────────────────────────────────────────────────────────────
// render.json: what a published render says about itself. Pure functions; the Render tab fills them in.
// Fields that must not lie (docs: guides/PUBLISH.md, guides/TIME_SOURCES.md):
//   mode                'offline' (every frame drawn at n / fps) or 'realtime' (a wall-clock capture: variable frame rate)
//   determinism.frames  frame n is a pure function of n / fps and the pinned inputs. It is true only when the shuffled-order test passed on EVERY frame:
//                       the frames were drawn again in an order no sequential render uses, and each matched. Never a claim about pixels across GPUs.
//   determinism.bytes   the encoded file repeats byte for byte: frames are deterministic AND the software encoder wrote it. A hardware encoder is a
//                       reason the BYTES are not promised, a choice and not a defect, and says nothing about the frames.
//   scene.hash          canonical hash of the scene at render time (canonical.js): the staleness check
//   frames              frames == round(duration_s * fps), or the capture is variable-rate and mode says 'realtime'
//   outputs.frame_hashes the sha256 of every frame (sidecar + root hash), so the claim can be checked by anyone, and a divergence is a diff of two lists

import { FRAME_HASH_OVER } from './frameHashes.js';
import { CAPTION_SOURCES, LANGUAGE } from './captions.js';

export const RENDER_JSON_VERSION = 2;     // 2: `deterministic` and `not_deterministic_because` became `determinism` { frames, bytes, reasons }; `encoder` became a record
export const EXPORTER = 'strata-export/1.2.0';

/**
 * The time-source audit (guides/TIME_SOURCES.md). What it CONFIRMED, and what is still live. The confirmations are backed by a grep of the export path and by
 * the shuffled-order test, not by an accepted exception: a standing exception would let a leak hide behind it.
 *   confirmed      no animated quantity reads a wall clock, integrates a delta, or reads a previous frame's value (D3)
 *   live-when-present  a real input the render reads while it runs: when it applies to THIS render, `determinism.frames` is false
 */
export const TIME_SOURCE_AUDIT = Object.freeze( {
	document: 'guides/TIME_SOURCES.md',
	passed: true,
	confirmed: Object.freeze( [
		{ id: 'no-clock-in-animated-quantities', how: 'A grep of the export path (Date.now, performance.now, requestAnimationFrame, Math.random, Clock, getDelta, setInterval) finds none that feeds an animated quantity: what remains is ids, UI, the Preview loop, and measurements for the ETA.' },
		{ id: 'no-delta-integration', how: 'Every animated quantity is set from an absolute time: holdTimelineAt sets each action\u2019s time and calls mixer.update(0); the crossfade weight is computed from the frame\u2019s own time.' },
		{ id: 'no-previous-frame-reads', how: 'The shuffled-order test: frames drawn in an order no sequential render uses are identical to the sequential ones (the test names the frames when they are not).' },
		{ id: 'shell-wall-clock-loops', how: 'A hand-written Shell timer lives in the page, not in the scene file, and no animated quantity of the scene reads it; a render from a freshly loaded scene cannot contain one.' },
	] ),
	residuals: Object.freeze( [
		{ id: 'playback-running', status: 'live-when-present', why: 'A render started while timeline playback was running differed by a few hundred pixels per frame from one started when idle (cause not found).' },
	] ),
} );

/**
 * The encoder as a record, whatever came in: a bare 'software' | 'hardware' (older callers, tests) or { kind, name, version, settings_hash, threads, config }.
 * `settings_hash` is the sha256 of the exact configuration given to the encoder; `threads` is null because WebCodecs does not let a page choose.
 */
export function encoderRecord( e ) {

	const o = typeof e === 'string' ? { kind: e } : ( e || {} );
	return {
		kind: o.kind === 'software' ? 'software' : 'hardware',
		name: o.name || null,
		version: o.version || null,
		settings_hash: o.settings_hash || null,
		threads: o.threads === undefined ? null : o.threads,
		config: o.config || null,
	};

}

/**
 * What a render can and cannot claim, as two properties with their own reasons (it used to be one boolean with four reasons under it, which made a fixable bug
 * and an encoder choice look the same):
 *   frames  frame n is a pure function of n / fps and the pinned inputs
 *   bytes   the encoded file repeats byte for byte
 * `verification` is the shuffled-order test (frameHashes.js verificationResult), or null when it was not run. frames is true only for a COMPLETE, passed one.
 */
export function assessDeterminism( { mode, encoder, hasEndCard = false, endCard = null, playbackWasRunning = false, audit = TIME_SOURCE_AUDIT, frameHashes = null, verification = null } ) {

	const kind = encoderRecord( encoder ).kind;
	const frames = [], bytes = [];
	if ( mode !== 'offline' ) frames.push( 'a realtime capture: wall-clock timing' );
	if ( audit.passed !== true ) frames.push( 'the time-source audit did not pass' );
	if ( playbackWasRunning ) frames.push( 'playback was running when the render started (a few hundred pixels per frame differed when measured; cause not found)' );
	if ( hasEndCard && ! endCard ) frames.push( 'the scene shows the end card, and its image was not recorded: an input that is not pinned' );
	if ( mode === 'offline' ) {

		if ( ! frameHashes ) frames.push( 'no per-frame hashes were made, so the claim cannot be checked' );
		if ( ! verification ) frames.push( 'not verified: the shuffled-order test was not run (set Verify to all frames)' );
		else if ( ! verification.passed ) frames.push( `the shuffled-order test failed: ${ verification.mismatched_count } frame${ verification.mismatched_count === 1 ? '' : 's' } depend on more than n / fps (${ verification.mismatched_frames.slice( 0, 12 ).join( ', ' ) }${ verification.mismatched_count > 12 ? ', …' : '' })` );
		else if ( ! verification.complete ) frames.push( `verified on ${ verification.frames_checked } of ${ verification.of } frames only (every ${ verification.every }th): a subset is evidence, not a claim; verify all frames` );

	}
	if ( kind !== 'software' ) bytes.push( 'a hardware encoder was chosen: its bytes are not promised to repeat (a choice; the frames are unaffected)' );
	if ( frames.length ) bytes.push( 'the frames are not established as deterministic' );
	return { frames: frames.length === 0, bytes: bytes.length === 0, reasons: { frames, bytes }, verification: verification || null };

}

export const LIMITS = Object.freeze( {
	segmentBytes: 20 * 1024 * 1024,        // jsDelivr's cap per file served from a repo
	fileBytes: 100 * 1024 * 1024,          // GitHub's hard limit per file
	warnTotalBytes: 100 * 1024 * 1024,     // warn before a commit larger than this
} );

const MB = 1024 * 1024;
export const formatBytes = n => n >= MB ? ( n / MB ).toFixed( n >= 10 * MB ? 0 : 1 ) + ' MB' : n >= 1024 ? Math.round( n / 1024 ) + ' KB' : n + ' B';

/** deterministic is derived, never typed in. */

/**
 * @param {object} i
 *   scene:   { repo, file, branch, commit|null, hash }
 *   render:  { mode, renderer, device, fps, frames, frameRange:[a,b], width, height, seed?, renderedAt, durationS? }
 *   renditions: [{ name, width, height, bitrateKbps, playlist, segments, maxSegmentBytes }]
 *   audio:   null, or { name, language, bitrateKbps, sampleRate, channels, playlist, segments, maxSegmentBytes, durationS, source: { path, sha256, tool?, voice?, model? }, delaySamples }
 *   download: null, or { name, bytes (Uint8Array), command, audio, captions, videoFrom ('master' or a rung name) }: one MP4 with the video copied, AAC audio and a soft caption track
 *   determinism: assessDeterminism() output; render.encoder: encoderRecord()'s input ('software' | 'hardware', or the record)
 *   captions:    the default caption track's path, or null (kept so anything that reads outputs.captions as a path still works)
 *   captionTracks: [captions.js trackRecord() + hls]   every caption file: its language, where it came from (cues | asr | manual), the hash of the cues it holds, and whether its cues have ids
 *   frameHashes: null, or { path, count, root }   the sidecar of per-frame sha256 hashes
 *   endCard:     null, or { path, sha256, bytes, url, stamp, width, height }   the end card image the frames were composited from
 *   publication: null, or releases.js publicationBlock(): where the render lives (storage, repo, path, tag, url, size_bytes)
 *   files:   [{ path, bytes }]  every file of the set, for the size checks
 */
/**
 * [] when the master playlist agrees with whether the render has audio, else what disagrees. A master that declares an audio group that does not exist plays in
 * some clients and fails in others, which is the worst kind of defect to find later; and one that omits a group that does exist plays silent.
 */
export function masterAudioProblems( master, audioPresent ) {

	const lines = String( master ).replace( /\r/g, '' ).split( '\n' );
	const media = lines.filter( l => /^#EXT-X-MEDIA:TYPE=AUDIO/.test( l ) ), variants = lines.filter( l => /^#EXT-X-STREAM-INF:/.test( l ) );
	const p = [];
	if ( variants.length === 0 ) p.push( 'the master lists no variant' );
	if ( ! audioPresent ) {

		if ( media.length ) p.push( 'the master declares an audio group (EXT-X-MEDIA TYPE=AUDIO) but the render has no audio' );
		if ( /mp4a\./.test( master ) ) p.push( 'a CODECS string names an audio codec (mp4a) but the render has no audio' );
		if ( variants.some( l => /,AUDIO="/.test( l ) ) ) p.push( 'a variant references an AUDIO group that does not exist' );

	} else {

		if ( media.length === 0 ) p.push( 'the render has audio but the master declares no audio group' );
		const groups = media.map( l => ( /GROUP-ID="([^"]*)"/.exec( l ) || [] )[ 1 ] );
		for ( const l of variants ) {

			if ( ! /CODECS="[^"]*mp4a\.40\.2/.test( l ) ) p.push( 'a variant\u2019s CODECS does not include mp4a.40.2' );
			const g = ( /,AUDIO="([^"]*)"/.exec( l ) || [] )[ 1 ];
			if ( ! g || ! groups.includes( g ) ) p.push( 'a variant does not reference the audio group' );

		}

	}
	return [ ...new Set( p ) ];

}

/** The record of one rendition's encoder: what it was given and what it was made from. null when none was recorded. */
export function renditionEncoderRecord( e ) {

	return e ? { ...encoderRecord( e ), stage: 'ladder', input: 'master' } : null;

}

/** True when the recorded encoder is the one that produced this rendition: same size, bitrate and frame rate as the rendition and the render declare. */
export function encoderMatchesRendition( r, fps ) {

	const c = r && r.encoder && r.encoder.config;
	return !! c && c.width === r.width && c.height === r.height && c.bitrate === r.bitrateKbps * 1000 && c.framerate === fps;

}

export function buildRenderJson( { scene, render, renditions, files, poster = 'poster.jpg', captions = null, captionTracks = [], audio = null, download = null, determinism, frameHashes = null, endCard = null, publication = null, masterText = null, audit = TIME_SOURCE_AUDIT, audioAbsence = null } ) {

	const durationS = render.durationS !== undefined ? render.durationS : render.frames / render.fps;
	const out = {
		version: RENDER_JSON_VERSION,
		scene: { repo: scene.repo, file: scene.file, branch: scene.branch, commit: scene.commit || null, hash: scene.hash },
		render: {
			mode: render.mode,
			determinism: { frames: determinism.frames, bytes: determinism.bytes, reasons: determinism.reasons, verification: determinism.verification || null },
			encoder: { ...encoderRecord( render.encoder ), stage: 'master' },     // the mezzanine the ladder is transcoded from; each rendition records its own (outputs.renditions[].encoder)
			renderer: render.renderer,
			device: render.device,
			fps: render.fps,
			frames: render.frames,
			frame_range: render.frameRange,
			duration_s: Math.round( durationS * 1e6 ) / 1e6,
			width: render.width,
			height: render.height,
			seed: render.seed === undefined ? null : render.seed,
			exporter: EXPORTER,
			rendered_at: render.renderedAt,
			time_source_audit: { document: audit.document, passed: audit.passed, confirmed: audit.confirmed.map( c => c.id ), live_when_present: audit.residuals.filter( r => r.status === 'live-when-present' ).map( r => r.id ) },
		},
		...( endCard ? { inputs: { end_card: { path: endCard.path, sha256: 'sha256:' + endCard.sha256, bytes: endCard.bytes, source: endCard.url, stamp: endCard.stamp || null, width: endCard.width, height: endCard.height } } } : {} ),
		outputs: {
			master: 'master.m3u8',
			renditions: renditions.map( r => ( {
				name: r.name, width: r.width, height: r.height, bitrate_kbps: r.bitrateKbps,
				playlist: r.playlist, segments: r.segments, max_segment_bytes: r.maxSegmentBytes,
				encoder: renditionEncoderRecord( r.encoder ),
			} ) ),
			poster,
			captions,
			caption_tracks: captionTracks,
			manifest: { path: 'files.sha256', algorithm: 'sha256' },
			...( frameHashes ? { frame_hashes: { path: frameHashes.path, count: frameHashes.count, algorithm: 'sha256', over: FRAME_HASH_OVER, root: frameHashes.root } } : {} ),
			audio: audio ? {
				name: audio.name, language: audio.language, codec: 'mp4a.40.2', sample_rate: audio.sampleRate, channels: audio.channels, bitrate_kbps: audio.bitrateKbps,
				playlist: audio.playlist, segments: audio.segments, max_segment_bytes: audio.maxSegmentBytes, duration_s: Math.round( audio.durationS * 1e6 ) / 1e6,
				source: audio.source, encoder_delay_samples: audio.delaySamples,
			} : null,
			// the silence is a recorded fact, not an absence: master_matches_audio (below) asserts the playlist agrees with it
			audio_present: !! audio,
			// hls-webcli patch: `audioAbsence` says why, for a render that did not come from a scene
			...( audio ? {} : { audio_absence: audioAbsence || 'The scene has no narration: no renderAudio, nothing dubbed, no WAV chosen. The master declares no audio group and no audio codec.' } ),
			...( download ? { file: {
				path: download.name, bytes: download.bytes.length, container: 'mp4', video: `copied from the ${ download.videoFrom && download.videoFrom !== 'master' ? download.videoFrom + ' rung' : 'master' }, not re-encoded`,
				audio: download.audio ? 'aac-lc, 48 kHz stereo, 128 kbps' : null, captions: download.captions ? 'mov_text, a soft track the viewer can switch off' : null,
				made_by: 'ffmpeg.webcli.app', command: download.command,
			} } : {} ),
		},
		checks: {
			segments_under_20mb: renditions.every( r => r.maxSegmentBytes < LIMITS.segmentBytes ),
			files_under_100mb: files.every( f => f.bytes < LIMITS.fileBytes ),
			frame_count_matches_duration: render.frames === Math.round( durationS * render.fps ),
			encoder_recorded_per_rendition: renditions.every( r => encoderMatchesRendition( r, render.fps ) ),
			...( masterText === null ? {} : { master_matches_audio: masterAudioProblems( masterText, !! audio ).length === 0 } ),
			...( audio ? { audio_duration_matches_video: Math.abs( audio.durationS - durationS ) < 0.05 } : {} ),
		},
		...( publication ? { publication } : {} ),
	};
	return out;

}

const isStr = v => typeof v === 'string' && v.length > 0;
const isInt = v => Number.isInteger( v ) && v >= 0;
const isPos = v => typeof v === 'number' && Number.isFinite( v ) && v > 0;

/** Validates a render.json against the schema in docs/schemas/render.schema.json (kept in step by a test). Returns [] when valid. */
export function validateRenderJson( j ) {

	const e = [];
	const need = ( cond, msg ) => { if ( ! cond ) e.push( msg ); };
	need( j && j.version === RENDER_JSON_VERSION, `version must be ${ RENDER_JSON_VERSION }` );
	if ( ! j || typeof j !== 'object' ) return e;

	const s = j.scene || {};
	need( isStr( s.repo ) && /^[^/\s]+\/[^/\s]+$/.test( s.repo ), 'scene.repo must be owner/name' );
	need( isStr( s.file ), 'scene.file is required' );
	need( isStr( s.branch ), 'scene.branch is required' );
	need( s.commit === null || /^[0-9a-f]{7,40}$/.test( s.commit || '' ), 'scene.commit must be a hex sha or null' );
	need( /^sha256:[0-9a-f]{64}$/.test( s.hash || '' ), 'scene.hash must be sha256:<64 hex>' );

	const r = j.render || {};
	need( r.mode === 'offline' || r.mode === 'realtime', 'render.mode must be offline or realtime' );
	const d = r.determinism || {};
	need( r.determinism && typeof d.frames === 'boolean' && typeof d.bytes === 'boolean', 'render.determinism needs boolean frames and bytes' );
	need( d.reasons && Array.isArray( d.reasons.frames ) && Array.isArray( d.reasons.bytes ), 'render.determinism.reasons needs a list for frames and one for bytes' );
	const rf = ( d.reasons && d.reasons.frames ) || [], rb = ( d.reasons && d.reasons.bytes ) || [];
	need( ! d.frames || rf.length === 0, 'frames is true, so there are no reasons against it' );
	need( d.frames || rf.length > 0, 'frames is false, so it says why' );
	need( ! d.bytes || rb.length === 0, 'bytes is true, so there are no reasons against it' );
	need( d.bytes || rb.length > 0, 'bytes is false, so it says why' );
	need( ! d.frames || r.mode === 'offline', 'determinism.frames is true only for mode offline' );
	need( ! d.bytes || d.frames, 'determinism.bytes is true only when frames is' );
	const enc = r.encoder || {};
	need( enc.kind === 'software' || enc.kind === 'hardware', 'render.encoder.kind must be software or hardware' );
	need( enc.settings_hash === null || /^sha256:[0-9a-f]{64}$/.test( enc.settings_hash || '' ), 'render.encoder.settings_hash must be sha256:<64 hex> or null' );
	need( enc.threads === null || isInt( enc.threads ), 'render.encoder.threads must be an integer or null' );
	need( ! d.bytes || enc.kind === 'software', 'determinism.bytes is true only with the software encoder' );
	need( d.verification === null || d.verification === undefined || ( d.verification.method === 'shuffled-order' && typeof d.verification.passed === 'boolean' && typeof d.verification.complete === 'boolean' && isInt( d.verification.frames_checked ) ), 'determinism.verification must be a shuffled-order result or null' );
	need( ! d.frames || ( d.verification && d.verification.passed === true && d.verification.complete === true ), 'determinism.frames is true only after a complete, passed shuffled-order test' );
	need( r.time_source_audit && Array.isArray( r.time_source_audit.confirmed ) && Array.isArray( r.time_source_audit.live_when_present ), 'render.time_source_audit needs confirmed and live_when_present lists' );
	need( isStr( r.renderer ) && isStr( r.device ) && isStr( r.exporter ), 'render.renderer, device and exporter are required' );
	need( isPos( r.fps ), 'render.fps must be positive' );
	need( isInt( r.frames ) && r.frames > 0, 'render.frames must be a positive integer' );
	need( Array.isArray( r.frame_range ) && r.frame_range.length === 2 && isInt( r.frame_range[ 0 ] ) && isInt( r.frame_range[ 1 ] ) && r.frame_range[ 1 ] - r.frame_range[ 0 ] + 1 === r.frames, 'render.frame_range must be [first, last] covering render.frames frames' );
	need( isPos( r.duration_s ), 'render.duration_s must be positive' );
	need( r.mode !== 'offline' || r.frames === Math.round( r.duration_s * r.fps ), 'an offline render has frames == round(duration_s * fps)' );
	need( isInt( r.width ) && isInt( r.height ) && r.width > 0 && r.height > 0, 'render.width and height must be positive integers' );
	need( r.seed === null || typeof r.seed === 'number', 'render.seed must be a number or null' );
	need( isStr( r.rendered_at ) && ! Number.isNaN( Date.parse( r.rendered_at ) ), 'render.rendered_at must be an ISO date' );

	const o = j.outputs || {};
	need( o.master === 'master.m3u8', 'outputs.master must be master.m3u8' );
	need( Array.isArray( o.renditions ) && o.renditions.length > 0, 'outputs.renditions must list at least one rendition' );
	for ( const x of o.renditions || [] ) {

		need( isStr( x.name ) && isInt( x.width ) && isInt( x.height ) && isPos( x.bitrate_kbps ), `rendition ${ x && x.name }: name, width, height and bitrate_kbps are required` );
		need( isStr( x.playlist ) && isInt( x.segments ) && x.segments > 0 && isInt( x.max_segment_bytes ), `rendition ${ x && x.name }: playlist, segments and max_segment_bytes are required` );
		if ( x && x.encoder ) {

			const xc = x.encoder.config || {};
			need( ( x.encoder.kind === 'software' || x.encoder.kind === 'hardware' ) && x.encoder.stage === 'ladder' && /^sha256:[0-9a-f]{64}$/.test( x.encoder.settings_hash || '' ), `rendition ${ x.name }: encoder needs kind, stage ladder and a sha256 settings_hash` );
			need( xc.width === x.width && xc.height === x.height && xc.bitrate === x.bitrate_kbps * 1000 && xc.framerate === r.fps, `rendition ${ x.name }: the recorded encoder settings are not the ones that produced it (size, bitrate and frame rate must match the rendition)` );

		}

	}
	need( isStr( o.poster ), 'outputs.poster is required' );
	need( o.audio_present === undefined || ( typeof o.audio_present === 'boolean' && o.audio_present === !! o.audio ), 'outputs.audio_present must say whether outputs.audio exists' );
	need( o.audio_present !== false || isStr( o.audio_absence ), 'a render with no audio says so deliberately (outputs.audio_absence)' );
	need( o.captions === null || isStr( o.captions ), 'outputs.captions must be a path or null' );
	need( Array.isArray( o.caption_tracks ), 'outputs.caption_tracks must be a list (empty when there are no captions)' );
	const tracks = Array.isArray( o.caption_tracks ) ? o.caption_tracks : [];
	need( tracks.length === 0 ? o.captions === null : o.captions === tracks[ 0 ].path, 'outputs.captions is the first caption track\u2019s path, or null when there are none' );
	need( new Set( tracks.map( t => t.language ) ).size === tracks.length, 'there is one caption track per language' );
	for ( const t of tracks ) {

		const who = `caption track ${ t && t.path }`;
		need( t && isStr( t.path ) && LANGUAGE.test( t.language || '' ), `${ who }: path and a language code are required` );
		need( t && CAPTION_SOURCES.includes( t.source ), `${ who }: source must be one of ${ CAPTION_SOURCES.join( ', ' ) }` );
		need( t && /^sha256:[0-9a-f]{64}$/.test( t.cues_sha256 || '' ) && /^sha256:[0-9a-f]{64}$/.test( t.structure_sha256 || '' ), `${ who }: cues_sha256 and structure_sha256 are required` );
		need( t && isInt( t.cue_count ) && t.cue_count > 0 && typeof t.addressable === 'boolean', `${ who }: cue_count and addressable are required` );
		need( ! t || t.source !== 'asr' || ( t.asr && isStr( t.asr.model ) ), `${ who }: an asr track says which model made it` );
		need( ! t || t.source !== 'asr' || t.addressable === false, `${ who }: an asr track has no authored ids, so it is not addressable` );
		need( ! t || ! t.translation_of || /^sha256:[0-9a-f]{64}$/.test( t.translated_from || '' ), `${ who }: a translation says which cues it was made from (translated_from)` );

	}
	if ( o.frame_hashes !== undefined ) need( isStr( o.frame_hashes.path ) && isInt( o.frame_hashes.count ) && o.frame_hashes.algorithm === 'sha256' && /^sha256:[0-9a-f]{64}$/.test( o.frame_hashes.root || '' ), 'outputs.frame_hashes needs path, count, algorithm sha256 and a sha256 root' );
	need( ! d.frames || ( o.frame_hashes && o.frame_hashes.count === r.frames ), 'determinism.frames is true only with a frame hash for every frame (outputs.frame_hashes.count == render.frames)' );
	const ec = j.inputs && j.inputs.end_card;
	if ( ec ) need( isStr( ec.path ) && /^sha256:[0-9a-f]{64}$/.test( ec.sha256 || '' ) && isInt( ec.bytes ) && ec.bytes > 0, 'inputs.end_card needs a path, a sha256 and its bytes' );
	if ( o.audio !== null && o.audio !== undefined ) {

		const a = o.audio;
		need( a.codec === 'mp4a.40.2' && isStr( a.playlist ) && isInt( a.segments ) && a.segments > 0 && isInt( a.max_segment_bytes ) && isPos( a.duration_s ) && isPos( a.sample_rate ) && isPos( a.channels ) && isPos( a.bitrate_kbps ), 'outputs.audio: codec, playlist, segments, max_segment_bytes, duration_s, sample_rate, channels and bitrate_kbps are required' );
		need( a.source && isStr( a.source.path ) && /^sha256:[0-9a-f]{64}$/.test( a.source.sha256 || '' ), 'outputs.audio.source needs a path and a sha256' );

	}

	const c = j.checks || {};
	for ( const k of [ 'segments_under_20mb', 'files_under_100mb', 'frame_count_matches_duration' ] ) need( typeof c[ k ] === 'boolean', `checks.${ k } must be a boolean` );
	for ( const k of [ 'encoder_recorded_per_rendition', 'master_matches_audio' ] ) need( c[ k ] === undefined || typeof c[ k ] === 'boolean', `checks.${ k } must be a boolean` );
	if ( o.file !== undefined ) need( o.file && isStr( o.file.path ) && isInt( o.file.bytes ) && o.file.bytes > 0 && o.file.container === 'mp4' && isStr( o.file.made_by ), 'outputs.file needs path, bytes, container mp4 and made_by' );
	need( ! o.audio || typeof c.audio_duration_matches_video === 'boolean', 'checks.audio_duration_matches_video is required when there is audio' );
	return e;

}

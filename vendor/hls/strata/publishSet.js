// ── publishSet.js ──────────────────────────────────────────────────────────────
// The publishable set of one render, as pure functions: the ladder, the captions, the file list with its sizes, the size gates and
// the warnings the Render tab shows before anything is committed. No browser APIs: the encoding lives in ladder.js.
//
//   renders/<scene>/render.json  poster.jpg  captions.vtt  master.m3u8
//   renders/<scene>/1080p60/init.mp4  seg00001.m4s …  index.m3u8   (and 720p60, 480p60)

import { masterPlaylist } from './fmp4.js';
import { subtitlePlaylist, subtitlePlaylistPath, withSubtitles } from './captions.js';
import { buildRenderJson, formatBytes, assessDeterminism, LIMITS } from './renderJson.js';
import { publicationBlock } from './releases.js';

/** The ladder, highest first: target heights and the bitrates the work order names. */
export const RUNGS = Object.freeze( [
	{ height: 1080, kbps: 3500 },
	{ height: 720, kbps: 1800 },
	{ height: 480, kbps: 900 },
] );

const even = n => Math.max( 2, Math.round( n / 2 ) * 2 );

/**
 * The rungs for a master of this size: never larger than the master (no upscaling), same aspect ratio, even dimensions.
 * `keep` (optional) is the list of heights the user left ticked. A master smaller than the lowest rung gets one rung at its own size.
 */
export function planLadder( { width, height, fps, keep = null } ) {

	const aspect = width / height;
	let rungs = RUNGS.filter( r => r.height <= height );
	if ( rungs.length === 0 ) rungs = [ { height, kbps: Math.max( 200, Math.round( RUNGS[ RUNGS.length - 1 ].kbps * ( height / RUNGS[ RUNGS.length - 1 ].height ) ** 2 ) ) } ];
	if ( keep ) rungs = rungs.filter( r => keep.includes( r.height ) );
	return rungs.map( r => ( {
		name: `${ r.height }p${ fps }`, height: r.height === height ? height : even( r.height ), width: r.height === height ? width : even( r.height * aspect ),
		kbps: r.kbps,
	} ) );

}

export { vttTime } from './captions.js';

/** renders/<scene-basename>/ for a scene file such as "piston.json". */
export function defaultPublishPath( sceneFile ) {

	const base = String( sceneFile || 'scene.json' ).split( '/' ).pop().replace( /\.[^./]+$/, '' ) || 'scene';
	return 'renders/' + base.replace( /[^A-Za-z0-9._+-]+/g, '-' );

}

const enc = new TextEncoder();
const bytesOf = v => typeof v === 'string' ? enc.encode( v ) : v;

/**
 * @param {object} i
 *   path:        'renders/piston'
 *   scene:       { repo, file, branch, commit, hash }
 *   render:      { mode, renderer, device, fps, frames, frameRange, width, height, renderedAt }
 *   rungs:       [{ rung: { name, width, height, kbps }, packaged: packageRendition() output, encoder: the rung's encoder record (ladder.js) }]
 *   poster:      Uint8Array
 *   captionTracks: [{ path, language, default, text, record }]   from captions.js cueTrack(): the WebVTT files (written whenever the scene has cues, burned in or not), each with the
 *                  record render.json keeps of it and an HLS subtitle playlist in master.m3u8
 *   audio:       null | { packaged: packageAudio(), name, language, source: { path, sha256, tool?, voice?, model? }, delaySamples, wavBytes? }
 *                (wavBytes: the narration WAV, written as narration.wav when dub.webcli.app made it, so the set holds what the audio came from)
 *   download:    null | { name, bytes, command, audio: boolean, captions: boolean, videoFrom: 'master' | rung name }   the single-file MP4 made by ffmpeg.webcli.app
 *   determinism: { mode, encoder, hasEndCard, playbackWasRunning, verification }   (assessDeterminism's input)
 *   frameHashes: null | { text, root, count }       the sidecar text (frame-hashes.txt) and its root hash: sha256 of every frame, before encoding
 *   endCard:     null | { bytes (PNG), sha256, url, stamp, width, height }   the end card image the frames were composited from (endcard.png)
 *   publication: null | { storage, repo, tag, canonical? }   where this set will live (releases.js); render.json records it with the folder and the size of every other file.
 *                canonical: false writes the legacy block (a jsDelivr url) instead of the canonical address and its mirrors
 *   files.sha256 is added by filesManifest.js addManifest() (async, it hashes every file); render.json declares it in outputs.manifest
 * @returns {{ files: { path, bytes: Uint8Array }[], renderJson, total: number, errors: string[], warnings: string[], tree: { path, bytes }[] }}
 */
export function assemblePublishSet( { path, scene, render, rungs, poster, captionTracks = [], audio = null, download = null, determinism, frameHashes = null, endCard = null, publication = null, audit = undefined, audioAbsence = null } ) {

	const files = [];
	const rel = ( ...p ) => path + '/' + p.join( '/' );
	const add = ( relPath, data ) => files.push( { path: rel( relPath ), bytes: bytesOf( data ) } );

	add( 'poster.jpg', poster );
	// the captions: each file, its one-segment HLS subtitle playlist, and what render.json will say of it. The master gets the subtitle group below.
	const hlsTracks = [], captionRecords = [];
	for ( const t of captionTracks ) {

		const uri = subtitlePlaylistPath( t.language );
		add( t.path, t.text );
		add( uri, subtitlePlaylist( { uri: '../../' + t.path, durationS: render.frames / render.fps } ) );
		hlsTracks.push( { language: t.language, uri, default: !! t.default } );
		captionRecords.push( { ...t.record, hls: uri } );

	}
	if ( frameHashes ) add( 'frame-hashes.txt', frameHashes.text );
	if ( endCard ) add( 'endcard.png', endCard.bytes );

	const renditions = [];
	for ( const { rung, packaged, encoder } of rungs ) {

		add( `${ rung.name }/init.mp4`, packaged.init );
		for ( const s of packaged.segments ) add( `${ rung.name }/${ s.name }`, s.data );
		add( `${ rung.name }/index.m3u8`, packaged.playlist );
		renditions.push( {
			name: rung.name, width: rung.width, height: rung.height, bitrateKbps: rung.kbps,
			playlist: `${ rung.name }/index.m3u8`, segments: packaged.segments.length, maxSegmentBytes: packaged.maxSegmentBytes, encoder: encoder || null,
		} );

	}

	let audioMeta = null;
	if ( audio ) {

		const a = audio.packaged;
		add( 'audio/init.mp4', a.init );
		for ( const s of a.segments ) add( `audio/${ s.name }`, s.data );
		add( 'audio/index.m3u8', a.playlist );
		if ( audio.wavBytes ) add( audio.source.path, audio.wavBytes );
		audioMeta = {
			name: audio.name, language: audio.language, bitrateKbps: 128, sampleRate: 48000, channels: 2, playlist: 'audio/index.m3u8', segments: a.segments.length,
			maxSegmentBytes: a.maxSegmentBytes, durationS: a.durationSeconds, source: audio.source, delaySamples: audio.delaySamples,
		};

	}

	if ( download ) add( download.name, download.bytes );
	const masterText = withSubtitles( masterPlaylist( rungs.map( ( { rung, packaged } ) => ( {
		name: rung.name, width: rung.width, height: rung.height, playlist: `${ rung.name }/index.m3u8`,
		codec: packaged.codec, bandwidth: packaged.bandwidth, averageBandwidth: packaged.averageBandwidth,
	} ) ), render.fps, audio ? { groupId: 'aud', name: audio.name, language: audio.language, uri: 'audio/index.m3u8', codec: 'mp4a.40.2', bandwidth: audio.packaged.bandwidth, averageBandwidth: audio.packaged.averageBandwidth } : null  ), hlsTracks );
	add( 'master.m3u8', masterText );

	const renderJson = buildRenderJson( {
		masterText, scene, render, renditions, captions: captionRecords.length ? captionRecords[ 0 ].path : null, captionTracks: captionRecords, audio: audioMeta, download,
		// hls-webcli patch: `audit` is passed through, so a render that was not made by Strata's time-source-audited renderer does not claim the audit
		...( audit ? { audit } : {} ), ...( audioAbsence ? { audioAbsence } : {} ),
		determinism: assessDeterminism( { ...determinism, ...( audit ? { audit } : {} ), frameHashes: frameHashes ? { count: frameHashes.count, root: frameHashes.root } : null, endCard } ),
		frameHashes: frameHashes ? { path: 'frame-hashes.txt', count: frameHashes.count, root: frameHashes.root } : null,
		endCard: endCard ? { path: 'endcard.png', sha256: endCard.sha256, bytes: endCard.bytes.length, url: endCard.url, stamp: endCard.stamp, width: endCard.width, height: endCard.height } : null,
		files: files.map( f => ( { path: f.path, bytes: f.bytes.length } ) ),
		publication: publication ? publicationBlock( { storage: publication.storage, repo: publication.repo, path, tag: publication.tag || null, canonical: publication.canonical !== false, sizeBytes: files.reduce( ( n, f ) => n + f.bytes.length, 0 ) } ) : null,
	} );
	files.unshift( { path: rel( 'render.json' ), bytes: enc.encode( JSON.stringify( renderJson, null, 2 ) + '\n' ) } );

	const total = files.reduce( ( n, f ) => n + f.bytes.length, 0 );
	const { errors, warnings } = sizeReport( files, total, audioMeta ? [ ...renditions, { name: 'audio', maxSegmentBytes: audioMeta.maxSegmentBytes } ] : renditions, renderJson.render.determinism, download );
	if ( publication && publication.storage === 'renders-repo' ) {

		// the advice about a separate branch or repository is what this publish already does
		const i = warnings.findIndex( w => w.startsWith( 'To keep scene history light' ) );
		if ( i >= 0 ) warnings[ i ] = `This goes to ${ publication.repo }, a repository of its own, so the scene repository stays small. It is published as the new tag ${ publication.tag }: a tag never moves, and this render is a version, not a replacement.`;

	}
	return { files, renderJson, total, errors, warnings, tree: files.map( f => ( { path: f.path, bytes: f.bytes.length } ) ) };

}

/**
 * The size gates (errors block the publish) and the warnings (shown with the real numbers before the commit).
 *   error:   a segment at or over 20 MB (jsDelivr's cap), any file at or over 100 MB (GitHub's hard limit)
 *   warning: always, the total and what git does with binaries; louder over 100 MB
 */
export function sizeReport( files, total, renditions, determinism, download = null ) {

	const errors = [];
	const warnings = [];
	for ( const r of renditions ) {

		if ( r.maxSegmentBytes >= LIMITS.segmentBytes ) errors.push( `${ r.name }: a segment is ${ formatBytes( r.maxSegmentBytes ) }, over the 20 MB per-file limit this ladder is built for (publication.constraints; jsDelivr, a mirror, serves no more). Drop this rung or lower its bitrate.` );

	}
	for ( const f of files ) {

		if ( f.bytes.length >= LIMITS.fileBytes ) errors.push( `${ f.path } is ${ formatBytes( f.bytes.length ) }: GitHub refuses files of 100 MB or more.` );

	}

	if ( download && download.bytes.length >= LIMITS.segmentBytes ) warnings.push( `${ download.name } is ${ formatBytes( download.bytes.length ) }: GitHub stores it, but jsDelivr will not serve a file over 20 MB, so link to it from GitHub, or leave it out.` );

	let warning = `This commit adds ${ formatBytes( total ) } in ${ files.length } files. Git keeps every version of a binary forever: rendering and publishing six times stores six full copies (about ${ formatBytes( total * 6 ) }).`;
	if ( total > LIMITS.warnTotalBytes ) warning = `This commit is over 100 MB (${ formatBytes( total ) } in ${ files.length } files). ` + warning.replace( /^This commit adds [^.]*\.\s*/, '' );
	warnings.push( warning );
	warnings.push( 'To keep scene history light, publish to a separate "renders" branch (it can be squashed without touching the scene\u2019s history) or to a separate media repository.' );
	if ( determinism && determinism.frames ) warnings.push( 'The frames of this render are deterministic: the shuffled-order test passed on every frame, and frame-hashes.txt lets anyone check it. It can be regenerated from the scene, render.json and the pinned inputs, so it is a build artifact and old renders can be pruned.' + ( determinism.bytes ? ' The bytes repeat too (software encoder).' : ' The encoded bytes are not promised to repeat (hardware encoder), only the frames.' ) );
	return { errors, warnings };

}

/** "scene unchanged since render" or the stale warning, from the two hashes. */
export function stalenessLine( renderHash, currentHash ) {

	if ( ! renderHash ) return { stale: true, text: 'The scene\u2019s state at render time was not recorded; treat this render as stale.' };
	if ( renderHash === currentHash ) return { stale: false, text: 'Scene unchanged since render.' };
	return { stale: true, text: 'The scene has changed \u2014 this render is stale. Render again before publishing, or publish it knowing it no longer matches the scene.' };

}


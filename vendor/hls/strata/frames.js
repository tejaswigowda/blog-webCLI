// ── frames.js ──────────────────────────────────────────────────────────────────
// The offline renderer's clock, as pure functions. The frame number is the ONLY time source:
// frame n shows timeline time n / fps, whatever this machine happens to manage. Nothing here
// reads a wall clock, so the same inputs give the same numbers everywhere.

/** What the Render tab promises, and what it does not. One source: the UI and guides/TIME_SOURCES.md both quote these strings. */
/** The two renderers, stated where someone tunes against the preview. Measured on ten matched frames: guides/TIME_SOURCES.md, "Preview and export". */
export const RENDERER_COPY = 'Preview draws with WebGPU; export draws with WebGL2 (a separate, dedicated renderer). On a real GPU the two agreed closely on the scene tested (mean difference under 1 level in 255; edges and text anti-aliasing differ), but they are different renderers: judge a render by rendering it.';

export const DETERMINISM_COPY = {
	temporal: 'Frame n always shows timeline time n / fps, so duration and frame count are exact.',
	frames: 'Frames: frame n depends on n / fps and the pinned inputs and on nothing else, and that is checked, not assumed. Verify redraws the frames in a shuffled order and each must match the sequential render; render.json says frames: true only after every frame passed, and publishes the sha256 of every frame so anyone can check.',
	bytes: 'Bytes: the encoded file repeats byte for byte only with the software encoder (and the same browser build). A hardware encoder is faster and its bytes are not promised; that is a property of the encoder and does not change the frames.',
	crossDevice: 'Across different GPUs and drivers, pixels may differ in the last bit; that is not promised.',
	offline: 'Render (offline): every frame is drawn and captured, takes as long as it takes, exact timeline.',
	preview: 'Preview (realtime): plays at what this machine manages, may drop frames, not reproducible.',
};

/** Frames in a render of `lengthSeconds` at `fps`. */
export function totalFrames( lengthSeconds, fps ) {

	return Math.max( 1, Math.round( lengthSeconds * fps ) );

}

/** PTS of frame `n` in microseconds: the WebCodecs timestamp. */
export function frameTimestampUs( n, fps ) {

	return Math.round( n * 1e6 / fps );

}

/** Presentation duration of one frame in microseconds (the encoder rounds; the muxer's table is exact). */
export function frameDurationUs( fps ) {

	return Math.round( 1e6 / fps );

}

/**
 * The inclusive 0-based frame range to render. Blank / NaN means "from the first" and "to the last".
 * Returns { start, end, count } or { error } when the range is empty or outside the render.
 */
export function resolveRange( startRaw, endRaw, total ) {

	const parse = ( v, dflt ) => {

		if ( v === '' || v === null || v === undefined ) return dflt;
		const n = Number( v );
		return Number.isFinite( n ) ? Math.floor( n ) : NaN;

	};
	const start = parse( startRaw, 0 );
	const end = parse( endRaw, total - 1 );
	if ( Number.isNaN( start ) || Number.isNaN( end ) ) return { error: 'Frame range must be whole numbers.' };
	if ( start < 0 || end > total - 1 ) return { error: `Frame range must lie within 0 \u2013 ${ total - 1 } for this render.` };
	if ( end < start ) return { error: 'The last frame comes before the first.' };
	return { start, end, count: end - start + 1 };

}

/**
 * The three times that drive output frame `n`:
 *   outT  — output video time, n / fps (subtitles, shot sequence)
 *   t     — timeline time, offset by the skipped lead-in and held at the end for the tail
 *   shotT — shot / camera-cut time: NOT clamped to the duration, so a cut at the very end still finishes its fade
 */
export function frameTimes( n, fps, skip, duration ) {

	const outT = n / fps;
	return { outT, t: Math.min( duration, skip + outT ), shotT: skip + outT };

}

// H.264 levels by capability: max frame size in macroblocks, and max macroblocks per second.
const AVC_LEVELS = [
	[ 0x1f, 3600, 108000 ], [ 0x28, 8192, 245760 ], [ 0x2a, 8704, 522240 ],
	[ 0x32, 22080, 589824 ], [ 0x33, 36864, 983040 ], [ 0x34, 36864, 2073600 ],
];

/** Candidate WebCodecs H.264 (High profile) codec strings that can carry this size and rate, smallest level first. */
export function avcCodecCandidates( width, height, fps ) {

	const mbs = Math.ceil( width / 16 ) * Math.ceil( height / 16 );
	return AVC_LEVELS
		.filter( ( [ , frameMbs, rateMbs ] ) => mbs <= frameMbs && mbs * fps <= rateMbs )
		.map( ( [ level ] ) => 'avc1.6400' + level.toString( 16 ).padStart( 2, '0' ) );

}

/** Encoder bitrate, bits per second. */
export function targetBitrate( width, height, fps ) {

	return Math.round( Math.min( 24_000_000, width * height * fps * 0.15 ) );

}

/** "7,719 frames · ~6 min · exact 60.000 fps" — the contract line shown before a render. */
export function contractLine( count, fps, msPerFrame ) {

	const parts = [ `${ count.toLocaleString( 'en-US' ) } frames` ];
	if ( msPerFrame > 0 ) parts.push( '~' + formatEstimate( count * msPerFrame / 1000 ) );
	parts.push( `exact ${ fps.toFixed( 3 ) } fps` );
	return parts.join( ' \u00b7 ' );

}

export function formatEstimate( seconds ) {

	if ( seconds < 90 ) return Math.max( 1, Math.round( seconds ) ) + ' s';
	const minutes = Math.round( seconds / 60 );
	if ( minutes < 90 ) return minutes + ' min';
	return ( minutes / 60 ).toFixed( 1 ) + ' h';

}

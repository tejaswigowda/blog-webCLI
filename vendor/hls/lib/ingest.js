// ── ingest.js ──────────────────────────────────────────────────────────────────
// An uploaded MP4 or MOV, read into the `master` that Strata's ladder (strata/ladder.js) transcodes:
//   { width, height, fps, samples: Uint8Array[], keyframes: number[], avcC: Uint8Array, ptsUs?: number[] }
// No browser APIs: it runs in the page and in node (tests).
//
// It refuses rather than guesses. A file that plays here and stutters on a phone is worse than a refusal, because nothing downstream reports it.
// Each refusal has a reason code, and wouldRefuse() answers like Strata's SEG.wouldRefuse: null, or { reason, detail }.

import { frameTimestampUs } from '../strata/frames.js';

export const INGEST_VERSION = '1.0.0';

export const REASONS = Object.freeze( [
	'not-mp4', 'fragmented-input', 'no-video', 'unsupported-codec', 'rotated-input',
	'unknown-frame-rate', 'vfr-input', 'fractional-frame-rate', 'no-keyframes',
] );

const CONTAINERS = new Set( [ 'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex' ] );
const td = new TextDecoder( 'latin1' );

function* boxes( dv, start, end ) {

	let p = start;
	while ( p + 8 <= end ) {

		let size = dv.getUint32( p ), head = 8;
		const type = td.decode( new Uint8Array( dv.buffer, dv.byteOffset + p + 4, 4 ) );
		if ( size === 1 ) { size = Number( dv.getBigUint64( p + 8 ) ); head = 16; } else if ( size === 0 ) size = end - p;
		if ( size < head || p + size > end ) return;
		yield { type, start: p, body: p + head, end: p + size };
		p += size;

	}

}

function find( dv, parent, ...path ) {

	let cur = parent;
	for ( const t of path ) {

		let hit = null;
		for ( const b of boxes( dv, cur.body, cur.end ) ) if ( b.type === t ) { hit = b; break; }
		if ( ! hit ) return null;
		cur = hit;

	}
	return cur;

}

function findAll( dv, parent, type ) {

	return [ ...boxes( dv, parent.body, parent.end ) ].filter( b => b.type === type );

}

const median = a => { const s = [ ...a ].sort( ( x, y ) => x - y ); return s[ s.length >> 1 ]; };

/** The tables of one trak, or null. Sample numbers are 0-based and in decode order. */
function readTrack( dv, trak ) {

	const mdia = find( dv, trak, 'mdia' );
	if ( ! mdia ) return null;
	const hdlr = find( dv, mdia, 'hdlr' ), mdhd = find( dv, mdia, 'mdhd' ), stbl = find( dv, mdia, 'minf', 'stbl' );
	if ( ! hdlr || ! mdhd || ! stbl ) return null;
	const handler = td.decode( new Uint8Array( dv.buffer, dv.byteOffset + hdlr.body + 8, 4 ) );
	const timescale = dv.getUint32( mdhd.body + ( dv.getUint8( mdhd.body ) === 1 ? 20 : 12 ) );
	const out = { handler, timescale, stbl };

	const tkhd = find( dv, trak, 'tkhd' );
	if ( tkhd ) {

		const m = tkhd.body + ( dv.getUint8( tkhd.body ) === 1 ? 52 : 40 );
		out.matrix = [ dv.getInt32( m ) / 65536, dv.getInt32( m + 4 ) / 65536, dv.getInt32( m + 12 ) / 65536, dv.getInt32( m + 16 ) / 65536 ];

	}
	return out;

}

function sampleTable( dv, stbl, timescale ) {

	const full = ( type ) => { const b = find( dv, stbl, type ); return b ? { b, at: b.body + 4 } : null; };
	const stts = full( 'stts' ), stsz = full( 'stsz' ), stsc = full( 'stsc' ), stss = full( 'stss' ), ctts = find( dv, stbl, 'ctts' );
	const stco = find( dv, stbl, 'stco' ), co64 = find( dv, stbl, 'co64' );
	if ( ! stts || ! stsz || ! stsc || ! ( stco || co64 ) ) return null;

	const count = dv.getUint32( stsz.at + 4 ), fixed = dv.getUint32( stsz.at );
	const sizes = new Array( count );
	for ( let i = 0; i < count; i ++ ) sizes[ i ] = fixed || dv.getUint32( stsz.at + 8 + 4 * i );

	const dts = new Array( count ), deltas = new Array( count );
	let n = 0, t = 0;
	for ( let e = 0, c = dv.getUint32( stts.at ); e < c && n < count; e ++ ) {

		const reps = dv.getUint32( stts.at + 4 + 8 * e ), d = dv.getUint32( stts.at + 8 + 8 * e );
		for ( let r = 0; r < reps && n < count; r ++ ) { dts[ n ] = t; deltas[ n ] = d; t += d; n ++; }

	}
	if ( n < count ) return null;

	const cts = new Array( count ).fill( 0 );
	if ( ctts ) {

		const v = dv.getUint8( ctts.body ), at = ctts.body + 4;
		let k = 0;
		for ( let e = 0, c = dv.getUint32( at ); e < c && k < count; e ++ ) {

			const reps = dv.getUint32( at + 4 + 8 * e ), off = v === 1 ? dv.getInt32( at + 8 + 8 * e ) : dv.getUint32( at + 8 + 8 * e );
			for ( let r = 0; r < reps && k < count; r ++ ) cts[ k ++ ] = off;

		}

	}

	const sync = stss ? new Set( Array.from( { length: dv.getUint32( stss.at ) }, ( _, i ) => dv.getUint32( stss.at + 4 + 4 * i ) - 1 ) ) : null;

	const chunkOffsets = [];
	if ( stco ) for ( let i = 0, c = dv.getUint32( stco.body + 4 ); i < c; i ++ ) chunkOffsets.push( dv.getUint32( stco.body + 8 + 4 * i ) );
	else for ( let i = 0, c = dv.getUint32( co64.body + 4 ); i < c; i ++ ) chunkOffsets.push( Number( dv.getBigUint64( co64.body + 8 + 8 * i ) ) );

	const runs = Array.from( { length: dv.getUint32( stsc.at ) }, ( _, i ) => ( { first: dv.getUint32( stsc.at + 4 + 12 * i ) - 1, per: dv.getUint32( stsc.at + 8 + 12 * i ) } ) );
	const offsets = new Array( count );
	let s = 0;
	for ( let ci = 0; ci < chunkOffsets.length && s < count; ci ++ ) {

		let ri = runs.length - 1;
		while ( ri > 0 && runs[ ri ].first > ci ) ri --;
		let o = chunkOffsets[ ci ];
		for ( let k = 0; k < runs[ ri ].per && s < count; k ++ ) { offsets[ s ] = o; o += sizes[ s ]; s ++; }

	}
	if ( s < count ) return null;
	return { count, sizes, offsets, dts, cts, deltas, sync, timescale };

}

/**
 * What the file holds and what would stop it being packaged. Reads only the moov box's tables; the samples are views into `bytes`, not copies.
 * @returns {{ ok: boolean, refusals: {reason,detail}[], wouldRefuse: {reason,detail}|null, hasAudio: boolean, info: object, master: object|null }}
 */
export function inspectVideo( bytes ) {

	const refusals = [];
	const refuse = ( reason, detail ) => refusals.push( { reason, detail, ingest_version: INGEST_VERSION } );
	const result = () => ( { ok: refusals.length === 0, refusals, wouldRefuse: refusals[ 0 ] || null, hasAudio, info, master: refusals.length ? null : master } );
	let hasAudio = false, info = {}, master = null;

	const dv = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	const top = [ ...boxes( dv, 0, bytes.byteLength ) ];
	if ( ! top.some( b => b.type === 'ftyp' ) || ! top.some( b => b.type === 'moov' || b.type === 'moof' ) ) { refuse( 'not-mp4', 'This is not an MP4 or MOV file (no ftyp and moov). Other containers are not read here.' ); return result(); }
	const moov = top.find( b => b.type === 'moov' );
	if ( ! moov || top.some( b => b.type === 'moof' ) ) { refuse( 'fragmented-input', 'A fragmented MP4 has no sample tables to read. Give it a plain MP4 (or, to repackage an existing HLS render, point the Library at its repository).' ); return result(); }

	const tracks = findAll( dv, moov, 'trak' ).map( t => readTrack( dv, t ) ).filter( Boolean );
	hasAudio = tracks.some( t => t.handler === 'soun' );
	const v = tracks.find( t => t.handler === 'vide' );
	if ( ! v ) { refuse( 'no-video', 'The file has no video track.' ); return result(); }

	const stsd = find( dv, v.stbl, 'stsd' );
	const entry = stsd && [ ...boxes( dv, stsd.body + 8, stsd.end ) ][ 0 ];
	const codec = entry ? entry.type : null;
	if ( codec !== 'avc1' ) { refuse( 'unsupported-codec', `The video is ${ codec || 'unknown' }, and only H.264 with its parameter sets in the file header (avc1) is read. ${ codec === 'avc3' ? 'avc3 keeps them in the stream.' : '' }`.trim() ); return result(); }
	const width = dv.getUint16( entry.start + 32 ), height = dv.getUint16( entry.start + 34 );
	const avcCBox = [ ...boxes( dv, entry.start + 86, entry.end ) ].find( b => b.type === 'avcC' );
	if ( ! avcCBox ) { refuse( 'unsupported-codec', 'The H.264 track has no avcC box, so its decoder configuration is not known.' ); return result(); }
	const avcC = bytes.slice( avcCBox.body, avcCBox.end );

	if ( v.matrix && ! ( Math.abs( v.matrix[ 0 ] - 1 ) < 1e-3 && Math.abs( v.matrix[ 1 ] ) < 1e-3 && Math.abs( v.matrix[ 2 ] ) < 1e-3 && Math.abs( v.matrix[ 3 ] - 1 ) < 1e-3 ) ) {

		refuse( 'rotated-input', 'The track carries a rotation or flip, which the decoder output would not apply: the ladder would come out sideways. Bake the rotation into the video first.' );

	}

	const table = sampleTable( dv, v.stbl, v.timescale );
	if ( ! table || table.count < 2 || ! v.timescale ) { refuse( 'unknown-frame-rate', 'The sample tables do not give a frame rate (fewer than two frames, or no timing).' ); return result(); }

	const order = Array.from( { length: table.count }, ( _, i ) => i ).sort( ( a, b ) => ( table.dts[ a ] + table.cts[ a ] ) - ( table.dts[ b ] + table.cts[ b ] ) || a - b );
	const pts = order.map( i => table.dts[ i ] + table.cts[ i ] );
	const gaps = pts.slice( 1 ).map( ( p, i ) => p - pts[ i ] );
	const avg = ( pts[ pts.length - 1 ] - pts[ 0 ] ) / gaps.length;
	if ( ! ( avg > 0 ) ) { refuse( 'unknown-frame-rate', 'Every frame has the same time, so there is no frame rate.' ); return result(); }
	const fpsExact = v.timescale / avg;
	const tickRounding = Math.max( 1, Math.ceil( avg * 0.005 ) );
	const worst = gaps.reduce( ( w, g ) => Math.abs( g - avg ) > Math.abs( w - avg ) ? g : w, gaps[ 0 ] );
	info = { codec, width, height, frames: table.count, timescale: v.timescale, fps: fpsExact, hasAudio, medianGapTicks: median( gaps ), reordered: order.some( ( i, k ) => i !== k ) };

	if ( Math.abs( worst - avg ) > tickRounding ) {

		refuse( 'vfr-input', `Frame times are not evenly spaced: a gap of ${ worst } ticks against an average of ${ avg.toFixed( 2 ) } (timescale ${ v.timescale }). A variable-rate file would play at the wrong speed in an HLS ladder.` );
		return result();

	}
	const fps = Math.round( fpsExact );
	if ( Math.abs( fpsExact - fps ) / fpsExact > 2e-4 || fps < 1 ) {

		refuse( 'fractional-frame-rate', `${ fpsExact.toFixed( 3 ) } fps is not a whole number. Strata's ladder places a keyframe every 2 × fps frames and writes a timescale of fps × 1000, so it takes whole frame rates (24, 25, 30, 50, 60). Convert the frame rate first.` );
		return result();

	}
	info.fps = fps;

	const keyframes = [];
	for ( let i = 0; i < table.count; i ++ ) if ( ! table.sync || table.sync.has( i ) ) keyframes.push( i );
	if ( keyframes.length === 0 || keyframes[ 0 ] !== 0 ) { refuse( 'no-keyframes', keyframes.length === 0 ? 'The file marks no frame as a keyframe, so decoding cannot start anywhere.' : 'The first frame is not a keyframe.' ); return result(); }
	info.keyframes = keyframes.length;

	const samples = table.offsets.map( ( o, i ) => bytes.subarray( o, o + table.sizes[ i ] ) );
	if ( samples.some( s => s.length === 0 ) || table.offsets[ table.count - 1 ] + table.sizes[ table.count - 1 ] > bytes.length ) { refuse( 'not-mp4', 'The sample tables point past the end of the file: it is truncated.' ); return result(); }

	master = { width, height, fps, samples, keyframes, avcC };
	if ( info.reordered ) {

		const rank = new Array( table.count );
		order.forEach( ( i, k ) => { rank[ i ] = k; } );
		master.ptsUs = rank.map( k => frameTimestampUs( k, fps ) );

	}
	return result();

}

/** null, or the first reason the file would be refused for: { reason, detail }. Nothing is changed. */
export const wouldRefuse = bytes => inspectVideo( bytes ).wouldRefuse;

// ── fmp4.js ────────────────────────────────────────────────────────────────────
// Fragmented MP4 (CMAF-style) segments and HLS playlists for ONE H.264 track, written by Strata itself.
//   init.mp4        ftyp + moov with an empty sample table and an `mvex`: the codec setup, shared by every segment of a rung
//   segNNNNN.m4s    styp + moof + mdat: a run of whole GOPs, starting on a keyframe
//   index.m3u8      one rung's playlist, EXT-X-MAP -> init.mp4
//   master.m3u8     every rung, with bandwidth, resolution, frame rate and codec
// Like Mp4Muxer it is exact and clock-free: the timescale is fps * 1000 and every sample lasts 1000 ticks, so a segment's
// `tfdt` is simply (first frame number) * 1000 and the same samples always give the same bytes.

const enc = new TextEncoder();

function concat( parts ) {

	let size = 0;
	for ( const p of parts ) size += p.length;
	const out = new Uint8Array( size );
	let at = 0;
	for ( const p of parts ) { out.set( p, at ); at += p.length; }
	return out;

}

const u8 = ( ...v ) => Uint8Array.from( v );
const u16 = n => u8( ( n >>> 8 ) & 255, n & 255 );
const u32 = n => u8( ( n >>> 24 ) & 255, ( n >>> 16 ) & 255, ( n >>> 8 ) & 255, n & 255 );
const zeros = n => new Uint8Array( n );
const ascii = s => enc.encode( s );

function box( type, ...children ) {

	const body = concat( children );
	return concat( [ u32( body.length + 8 ), ascii( type ), body ] );

}

const fullBox = ( type, version, flags, ...children ) => box( type, u8( version, ( flags >>> 16 ) & 255, ( flags >>> 8 ) & 255, flags & 255 ), ...children );
const MATRIX = concat( [ u32( 0x00010000 ), u32( 0 ), u32( 0 ), u32( 0 ), u32( 0x00010000 ), u32( 0 ), u32( 0 ), u32( 0 ), u32( 0x40000000 ) ] );

// sample_flags: a keyframe depends on nothing; every other frame depends on another and is not a sync sample
const KEY_FLAGS = 0x02000000;
const DELTA_FLAGS = 0x01010000;

/** The codec string for HLS (`avc1.PPCCLL`) from an avcC record: profile, profile-compatibility and level bytes. */
export function codecFromAvcC( avcC ) {

	if ( ! avcC || avcC.length < 4 ) throw new Error( 'fmp4: an avcC record is needed for the codec string' );
	return 'avc1.' + [ avcC[ 1 ], avcC[ 2 ], avcC[ 3 ] ].map( b => b.toString( 16 ).padStart( 2, '0' ) ).join( '' );

}

/** The shared init segment of one rendition. */
export function initSegment( { width, height, fps, avcC } ) {

	if ( ! Number.isInteger( fps ) || fps <= 0 ) throw new Error( 'fmp4: fps must be a positive whole number' );
	if ( width % 2 || height % 2 ) throw new Error( `fmp4: H.264 needs even dimensions, got ${ width } \u00d7 ${ height }` );
	const timescale = fps * 1000;

	const ftyp = box( 'ftyp', ascii( 'iso6' ), u32( 0 ), ascii( 'iso6' ), ascii( 'cmfc' ), ascii( 'avc1' ), ascii( 'mp41' ) );
	const mvhd = fullBox( 'mvhd', 0, 0, u32( 0 ), u32( 0 ), u32( timescale ), u32( 0 ), u32( 0x00010000 ), u16( 0x0100 ), zeros( 10 ), MATRIX, zeros( 24 ), u32( 2 ) );
	const tkhd = fullBox( 'tkhd', 0, 3, u32( 0 ), u32( 0 ), u32( 1 ), u32( 0 ), u32( 0 ), zeros( 8 ), u16( 0 ), u16( 0 ), u16( 0 ), u16( 0 ), MATRIX, u32( width * 65536 ), u32( height * 65536 ) );
	const mdhd = fullBox( 'mdhd', 0, 0, u32( 0 ), u32( 0 ), u32( timescale ), u32( 0 ), u16( 0x55c4 ), u16( 0 ) );
	const hdlr = fullBox( 'hdlr', 0, 0, u32( 0 ), ascii( 'vide' ), zeros( 12 ), ascii( 'VideoHandler\0' ) );
	const vmhd = fullBox( 'vmhd', 0, 1, u16( 0 ), zeros( 6 ) );
	const dinf = box( 'dinf', fullBox( 'dref', 0, 0, u32( 1 ), fullBox( 'url ', 0, 1 ) ) );
	const avc1 = box( 'avc1',
		zeros( 6 ), u16( 1 ), zeros( 16 ), u16( width ), u16( height ),
		u32( 0x00480000 ), u32( 0x00480000 ), u32( 0 ), u16( 1 ), new Uint8Array( 32 ), u16( 0x18 ), u16( 0xffff ),
		box( 'avcC', avcC ),
		box( 'colr', ascii( 'nclx' ), u16( 1 ), u16( 1 ), u16( 1 ), u8( 0 ) ) );
	const stbl = box( 'stbl',
		fullBox( 'stsd', 0, 0, u32( 1 ), avc1 ),
		fullBox( 'stts', 0, 0, u32( 0 ) ), fullBox( 'stsc', 0, 0, u32( 0 ) ), fullBox( 'stsz', 0, 0, u32( 0 ), u32( 0 ) ), fullBox( 'stco', 0, 0, u32( 0 ) ) );
	const trak = box( 'trak', tkhd, box( 'mdia', mdhd, hdlr, box( 'minf', vmhd, dinf, stbl ) ) );
	const mvex = box( 'mvex', fullBox( 'trex', 0, 0, u32( 1 ), u32( 1 ), u32( 1000 ), u32( 0 ), u32( DELTA_FLAGS ) ) );
	return concat( [ ftyp, box( 'moov', mvhd, trak, mvex ) ] );

}

/**
 * One media segment: `samples` are { data: Uint8Array (AVCC), key: boolean }, the first one a keyframe;
 * `firstFrame` is the 0-based number of the first sample in the whole film; `sequence` counts from 1.
 */
export function mediaSegment( { sequence, firstFrame, samples } ) {

	if ( samples.length === 0 ) throw new Error( 'fmp4: a segment needs at least one sample' );
	if ( ! samples[ 0 ].key ) throw new Error( 'fmp4: a segment must start on a keyframe' );

	const styp = box( 'styp', ascii( 'msdh' ), u32( 0 ), ascii( 'msdh' ), ascii( 'msix' ) );
	const n = samples.length;

	// trun: sample_duration, sample_size and sample_flags per sample, data_offset (from the start of the moof)
	const entries = new Uint8Array( n * 12 );
	const view = new DataView( entries.buffer );
	samples.forEach( ( s, i ) => {

		view.setUint32( i * 12, 1000, false );
		view.setUint32( i * 12 + 4, s.data.length, false );
		view.setUint32( i * 12 + 8, s.key ? KEY_FLAGS : DELTA_FLAGS, false );

	} );

	const build = dataOffset => box( 'moof',
		fullBox( 'mfhd', 0, 0, u32( sequence ) ),
		box( 'traf',
			fullBox( 'tfhd', 0, 0x020000, u32( 1 ) ),                          // default-base-is-moof
			fullBox( 'tfdt', 1, 0, u32( 0 ), u32( firstFrame * 1000 ) ),        // 64-bit base decode time
			fullBox( 'trun', 0, 0x000701, u32( n ), u32( dataOffset ), entries ) ) );

	const moofSize = build( 0 ).length;
	const moof = build( moofSize + 8 );
	let mdatSize = 8;
	for ( const s of samples ) mdatSize += s.data.length;
	return concat( [ styp, moof, u32( mdatSize ), ascii( 'mdat' ), ...samples.map( s => s.data ) ] );

}

/**
 * Where the segments start: a segment begins at a keyframe, and runs until the first keyframe at or after `targetSeconds`.
 * `keyframes` are the 0-based numbers of the keyframes; returns [{ first, count }] covering every frame.
 */
export function planSegments( frameCount, keyframes, fps, targetSeconds = 6 ) {

	if ( frameCount < 1 ) throw new Error( 'fmp4: no frames to segment' );
	if ( keyframes.length === 0 || keyframes[ 0 ] !== 0 ) throw new Error( 'fmp4: the first frame must be a keyframe' );
	const target = Math.max( 1, Math.round( targetSeconds * fps ) );
	const starts = [ 0 ];
	for ( const k of keyframes ) if ( k - starts[ starts.length - 1 ] >= target ) starts.push( k );
	return starts.map( ( first, i ) => ( { first, count: ( i + 1 < starts.length ? starts[ i + 1 ] : frameCount ) - first } ) );

}

export const segmentName = sequence => 'seg' + String( sequence ).padStart( 5, '0' ) + '.m4s';

/** A rung's playlist. `segments` are [{ name, frames }]; durations are exact (frames / fps). */
export function mediaPlaylist( segments, fps, { initName = 'init.mp4' } = {} ) {

	const durations = segments.map( s => s.frames / fps );
	const target = Math.ceil( Math.max( ...durations ) );
	const lines = [ '#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${ target }`, '#EXT-X-MEDIA-SEQUENCE:1', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-MAP:URI="${ initName }"` ];
	segments.forEach( ( s, i ) => lines.push( `#EXTINF:${ durations[ i ].toFixed( 6 ) },`, s.name ) );
	lines.push( '#EXT-X-ENDLIST', '' );
	return lines.join( '\n' );

}

/**
 * The master playlist. `renditions`: [{ name, width, height, playlist, codec, bandwidth, averageBandwidth }], highest first.
 * `audio` (optional): { groupId, name, language, uri, codec, bandwidth, averageBandwidth }: one audio rendition that every rung references,
 * so each rung's CODECS lists the audio codec too (a player reading a video-only string will not even try the audio).
 */
export function masterPlaylist( renditions, fps, audio = null ) {

	const lines = [ '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS' ];
	if ( audio ) lines.push( `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${ audio.groupId }",NAME="${ audio.name }",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="${ audio.language }",URI="${ audio.uri }"` );
	for ( const r of renditions ) {

		const codecs = audio ? `${ r.codec },${ audio.codec }` : r.codec;
		const tail = audio ? `,AUDIO="${ audio.groupId }"` : '';
		lines.push( `#EXT-X-STREAM-INF:BANDWIDTH=${ r.bandwidth + ( audio ? audio.bandwidth : 0 ) },AVERAGE-BANDWIDTH=${ r.averageBandwidth + ( audio ? audio.averageBandwidth : 0 ) },RESOLUTION=${ r.width }x${ r.height },FRAME-RATE=${ fps.toFixed( 3 ) },CODECS="${ codecs }"${ tail }`, r.playlist );

	}
	lines.push( '' );
	return lines.join( '\n' );

}

/**
 * Cuts one rendition's samples into a publishable set.
 * @param {{ width, height, fps, avcC: Uint8Array, samples: Uint8Array[], keyframes: number[] }} r  keyframes are 0-based frame numbers
 * @returns {{ init: Uint8Array, segments: { name, data, frames, first }[], playlist: string, codec: string, maxSegmentBytes: number, totalBytes: number, bandwidth: number, averageBandwidth: number }}
 */
export function packageRendition( { width, height, fps, avcC, samples, keyframes, targetSeconds = 6 } ) {

	const isKey = new Set( keyframes );
	const plan = planSegments( samples.length, keyframes, fps, targetSeconds );
	const init = initSegment( { width, height, fps, avcC } );
	const segments = plan.map( ( p, i ) => {

		const run = samples.slice( p.first, p.first + p.count ).map( ( data, k ) => ( { data, key: isKey.has( p.first + k ) } ) );
		return { name: segmentName( i + 1 ), data: mediaSegment( { sequence: i + 1, firstFrame: p.first, samples: run } ), frames: p.count, first: p.first };

	} );

	let maxSegmentBytes = 0, peak = 0, total = init.length;
	for ( const s of segments ) {

		maxSegmentBytes = Math.max( maxSegmentBytes, s.data.length );
		peak = Math.max( peak, s.data.length * 8 / ( s.frames / fps ) );
		total += s.data.length;

	}
	const seconds = samples.length / fps;
	return {
		init, segments, codec: codecFromAvcC( avcC ), maxSegmentBytes, totalBytes: total,
		playlist: mediaPlaylist( segments, fps ),
		bandwidth: Math.round( peak ), averageBandwidth: Math.round( total * 8 / seconds ),
	};

}

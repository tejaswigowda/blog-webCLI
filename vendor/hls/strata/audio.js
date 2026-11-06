// ── audio.js ───────────────────────────────────────────────────────────────────
// The narration track of a published render: ONE AAC-LC rendition, stored once and referenced by every video rung through an HLS audio
// group, instead of being muxed into every video segment.
//
//   scene.userData.renderAudio = { src: 'audio/projectile.wav', language: 'en', label: 'English' }     (path relative to the scene file's folder)
//   WAV --decode+resample--> 48 kHz stereo --AudioEncoder (AAC-LC, 128 kbps)--> raw AAC frames --> init.mp4 + seg00001.m4s … + index.m3u8
//
// AAC frames are 1024 samples, so a 6 s video segment is 281.25 audio frames. The audio segments do NOT pad to the video's boundaries (padding
// accumulates drift over a film): each audio segment starts at the first whole AAC frame at or after the video segment's start, and the
// durations differ slightly. Audio time is exact: timescale 48000, 1024 ticks per frame, tfdt = first frame * 1024.
// The AAC encoder's start-up delay (2112 samples, 44 ms, on the encoder measured) is calibrated per run and removed from the front of the
// input, so the decoded audio lines up with the picture from the first sample to the last.

export const AUDIO = Object.freeze( { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2, bitrate: 128000, frameSamples: 1024 } );

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

// ── WAV ───────────────────────────────────────────────────────────────────────

/** Reads a RIFF/WAVE file (8/16/24/32-bit PCM or 32-bit float, any rate, any channel count): { sampleRate, channels: Float32Array[] }. */
export function parseWav( bytes ) {

	const v = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	const tag = ( at ) => String.fromCharCode( ...bytes.subarray( at, at + 4 ) );
	if ( bytes.length < 12 || tag( 0 ) !== 'RIFF' || tag( 8 ) !== 'WAVE' ) throw new Error( 'Not a WAV file (no RIFF/WAVE header).' );
	let fmt = null, dataAt = -1, dataSize = 0, fmtAt = -1;
	for ( let at = 12; at + 8 <= bytes.length; ) {

		const id = tag( at ), size = v.getUint32( at + 4, true );
		if ( id === 'fmt ' ) fmtAt = at;
		if ( id === 'fmt ' ) fmt = { format: v.getUint16( at + 8, true ), channels: v.getUint16( at + 10, true ), sampleRate: v.getUint32( at + 12, true ), bits: v.getUint16( at + 22, true ) };
		if ( id === 'data' ) { dataAt = at + 8; dataSize = Math.min( size, bytes.length - dataAt ); break; }
		at += 8 + size + ( size & 1 );

	}
	if ( ! fmt || dataAt < 0 ) throw new Error( 'The WAV file has no fmt or data chunk.' );
	let { format } = fmt;
	if ( format === 0xfffe ) format = v.getUint16( fmtAt + 8 + 24, true );   // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format
	const float = format === 3;
	if ( ! float && format !== 1 ) throw new Error( `Unsupported WAV encoding (format ${ fmt.format }); use PCM or float.` );
	const bytesPer = fmt.bits / 8, frames = Math.floor( dataSize / ( bytesPer * fmt.channels ) );
	const channels = Array.from( { length: fmt.channels }, () => new Float32Array( frames ) );
	for ( let i = 0; i < frames; i ++ ) {

		for ( let c = 0; c < fmt.channels; c ++ ) {

			const at = dataAt + ( i * fmt.channels + c ) * bytesPer;
			let x;
			if ( float ) x = fmt.bits === 32 ? v.getFloat32( at, true ) : v.getFloat64( at, true );
			else if ( fmt.bits === 16 ) x = v.getInt16( at, true ) / 32768;
			else if ( fmt.bits === 24 ) x = ( ( v.getInt8( at + 2 ) << 16 ) | ( v.getUint8( at + 1 ) << 8 ) | v.getUint8( at ) ) / 8388608;
			else if ( fmt.bits === 32 ) x = v.getInt32( at, true ) / 2147483648;
			else if ( fmt.bits === 8 ) x = ( v.getUint8( at ) - 128 ) / 128;
			else throw new Error( `Unsupported WAV bit depth ${ fmt.bits }.` );
			channels[ c ][ i ] = x;

		}

	}
	return { sampleRate: fmt.sampleRate, channels };

}

/** Stereo at exactly `length` samples: mono is copied to both ears, extra channels dropped, short audio padded with silence, long audio cut. */
export function toStereo( channels, length ) {

	const left = new Float32Array( length ), right = new Float32Array( length );
	const a = channels[ 0 ], b = channels[ 1 ] || channels[ 0 ];
	left.set( a.subarray( 0, length ) );
	right.set( b.subarray( 0, length ) );
	return { left, right };

}

// ── AAC frames -> fMP4 ────────────────────────────────────────────────────────

const descriptor = ( tag, ...body ) => {

	const b = concat( body );
	if ( b.length > 127 ) throw new Error( 'audio: descriptor too long' );
	return concat( [ u8( tag, b.length ), b ] );

};

/** The audio init segment: ftyp + moov (an `mp4a` sample entry with its `esds`, an empty sample table, an mvex). */
export function audioInitSegment( { asc, sampleRate = AUDIO.sampleRate, channels = AUDIO.channels, bitrate = AUDIO.bitrate } ) {

	if ( ! asc || asc.length < 2 ) throw new Error( 'audio: the encoder gave no AudioSpecificConfig' );
	const esds = fullBox( 'esds', 0, 0, descriptor( 3, u16( 0 ), u8( 0 ),
		descriptor( 4, u8( 0x40 ), u8( 0x15 ), u8( 0, 0, 0 ), u32( bitrate ), u32( bitrate ), descriptor( 5, asc ) ),
		descriptor( 6, u8( 2 ) ) ) );
	const mp4a = box( 'mp4a', zeros( 6 ), u16( 1 ), zeros( 8 ), u16( channels ), u16( 16 ), u16( 0 ), u16( 0 ), u32( sampleRate * 65536 ), esds );
	const ftyp = box( 'ftyp', ascii( 'iso6' ), u32( 0 ), ascii( 'iso6' ), ascii( 'cmfc' ), ascii( 'mp41' ) );
	const mvhd = fullBox( 'mvhd', 0, 0, u32( 0 ), u32( 0 ), u32( sampleRate ), u32( 0 ), u32( 0x00010000 ), u16( 0x0100 ), zeros( 10 ), MATRIX, zeros( 24 ), u32( 2 ) );
	const tkhd = fullBox( 'tkhd', 0, 3, u32( 0 ), u32( 0 ), u32( 1 ), u32( 0 ), u32( 0 ), zeros( 8 ), u16( 0 ), u16( 0 ), u16( 0x0100 ), u16( 0 ), MATRIX, u32( 0 ), u32( 0 ) );
	const mdhd = fullBox( 'mdhd', 0, 0, u32( 0 ), u32( 0 ), u32( sampleRate ), u32( 0 ), u16( 0x55c4 ), u16( 0 ) );
	const hdlr = fullBox( 'hdlr', 0, 0, u32( 0 ), ascii( 'soun' ), zeros( 12 ), ascii( 'SoundHandler\0' ) );
	const smhd = fullBox( 'smhd', 0, 0, u16( 0 ), u16( 0 ) );
	const dinf = box( 'dinf', fullBox( 'dref', 0, 0, u32( 1 ), fullBox( 'url ', 0, 1 ) ) );
	const stbl = box( 'stbl', fullBox( 'stsd', 0, 0, u32( 1 ), mp4a ), fullBox( 'stts', 0, 0, u32( 0 ) ), fullBox( 'stsc', 0, 0, u32( 0 ) ), fullBox( 'stsz', 0, 0, u32( 0 ), u32( 0 ) ), fullBox( 'stco', 0, 0, u32( 0 ) ) );
	const trak = box( 'trak', tkhd, box( 'mdia', mdhd, hdlr, box( 'minf', smhd, dinf, stbl ) ) );
	const mvex = box( 'mvex', fullBox( 'trex', 0, 0, u32( 1 ), u32( 1 ), u32( AUDIO.frameSamples ), u32( 0 ), u32( 0x02000000 ) ) );
	return concat( [ ftyp, box( 'moov', mvhd, trak, mvex ) ] );

}

/** One audio media segment: `frames` are raw AAC frames (Uint8Array); `firstFrame` is the 0-based AAC frame number of the first. */
export function audioMediaSegment( { sequence, firstFrame, frames } ) {

	if ( frames.length === 0 ) throw new Error( 'audio: a segment needs at least one frame' );
	const styp = box( 'styp', ascii( 'msdh' ), u32( 0 ), ascii( 'msdh' ), ascii( 'msix' ) );
	const sizes = new Uint8Array( frames.length * 4 );
	const view = new DataView( sizes.buffer );
	frames.forEach( ( f, i ) => view.setUint32( i * 4, f.length, false ) );
	const build = dataOffset => box( 'moof', fullBox( 'mfhd', 0, 0, u32( sequence ) ),
		box( 'traf', fullBox( 'tfhd', 0, 0x020000, u32( 1 ) ), fullBox( 'tfdt', 1, 0, u32( 0 ), u32( firstFrame * AUDIO.frameSamples ) ),
			fullBox( 'trun', 0, 0x000201, u32( frames.length ), u32( dataOffset ), sizes ) ) );   // sample sizes; duration and flags come from the trex
	const moofSize = build( 0 ).length;
	const moof = build( moofSize + 8 );
	let mdat = 8;
	for ( const f of frames ) mdat += f.length;
	return concat( [ styp, moof, u32( mdat ), ascii( 'mdat' ), ...frames ] );

}

/**
 * Audio segment boundaries that follow the video's without padding it: segment i starts at the first whole AAC frame at or after the video
 * segment's start time. `videoStartsSeconds` are the starts of the video segments (the first is 0). Returns [{ first, count }].
 */
export function planAudioSegments( frameCount, videoStartsSeconds, sampleRate = AUDIO.sampleRate ) {

	if ( frameCount < 1 ) throw new Error( 'audio: no frames to segment' );
	const starts = [];
	for ( const t of videoStartsSeconds ) {

		const first = Math.max( 0, Math.ceil( ( t * sampleRate ) / AUDIO.frameSamples - 1e-9 ) ) + 0;
		if ( first < frameCount && ( starts.length === 0 || first > starts[ starts.length - 1 ] ) ) starts.push( first );

	}
	if ( starts[ 0 ] !== 0 ) starts.unshift( 0 );
	return starts.map( ( first, i ) => ( { first, count: ( i + 1 < starts.length ? starts[ i + 1 ] : frameCount ) - first } ) );

}

export const audioSegmentName = sequence => 'seg' + String( sequence ).padStart( 5, '0' ) + '.m4s';

/** The audio rendition's playlist: exact durations, frames * 1024 / 48000. */
export function audioPlaylist( segments, sampleRate = AUDIO.sampleRate ) {

	const durations = segments.map( s => s.frames * AUDIO.frameSamples / sampleRate );
	const lines = [ '#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${ Math.ceil( Math.max( ...durations ) ) }`, '#EXT-X-MEDIA-SEQUENCE:1', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-MAP:URI="init.mp4"' ];
	segments.forEach( ( s, i ) => lines.push( `#EXTINF:${ durations[ i ].toFixed( 6 ) },`, s.name ) );
	lines.push( '#EXT-X-ENDLIST', '' );
	return lines.join( '\n' );

}

/** Cuts the encoded frames into the publishable audio rendition, aligned to the video segments' starts. */
export function packageAudio( { frames, asc, videoStartsSeconds, sampleRate = AUDIO.sampleRate, channels = AUDIO.channels, bitrate = AUDIO.bitrate } ) {

	const plan = planAudioSegments( frames.length, videoStartsSeconds, sampleRate );
	const init = audioInitSegment( { asc, sampleRate, channels, bitrate } );
	const segments = plan.map( ( p, i ) => ( {
		name: audioSegmentName( i + 1 ), first: p.first, frames: p.count,
		data: audioMediaSegment( { sequence: i + 1, firstFrame: p.first, frames: frames.slice( p.first, p.first + p.count ) } ),
	} ) );
	let maxSegmentBytes = 0, total = init.length;
	for ( const s of segments ) { maxSegmentBytes = Math.max( maxSegmentBytes, s.data.length ); total += s.data.length; }
	const seconds = frames.length * AUDIO.frameSamples / sampleRate;
	return {
		init, segments, playlist: audioPlaylist( segments, sampleRate ), codec: AUDIO.codec, maxSegmentBytes, totalBytes: total,
		durationSeconds: seconds, bandwidth: Math.round( bitrate * 1.1 ), averageBandwidth: Math.round( total * 8 / seconds ),
	};

}

/** The video segments' start times in seconds, from packageRendition()'s segments. */
export const videoStarts = ( segments, fps ) => segments.map( s => s.first / fps );

// ── the browser half: decode, calibrate, encode ───────────────────────────────

const sleep = ms => new Promise( r => setTimeout( r, ms ) );

let decodeProbe = null;

/**
 * Can this browser DECODE the AAC it encodes? isConfigSupported says yes in Chromium builds without proprietary codecs (the VS Code / Electron
 * browser) and the decoder then fails at the first packet, so the only honest test is a real round trip. The encoder's start-up delay is measured
 * by decoding, so without a decoder it cannot be measured and the publish must not guess it.
 */
export function canDecodeAac() {

	if ( ! decodeProbe ) {

		decodeProbe = ( async () => {

			try {

				const x = new Float32Array( AUDIO.frameSamples * 6 );
				for ( let i = 0; i < x.length; i ++ ) x[ i ] = Math.sin( i * 0.05 ) * 0.2;
				const { frames, asc } = await encodeRaw( x, x );
				const y = await decodeRaw( frames, asc );
				return y.length > 0;

			} catch ( e ) { return false; }

		} )();

	}
	return decodeProbe;

}

/** Is AAC-LC encoding available here, and can the encoder's delay be measured? Resolves to { ok, reason }. */
export async function aacSupport() {

	if ( typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined' ) return { ok: false, reason: 'this browser has no WebCodecs AudioEncoder.' };
	try {

		const s = await AudioEncoder.isConfigSupported( { codec: AUDIO.codec, sampleRate: AUDIO.sampleRate, numberOfChannels: AUDIO.channels, bitrate: AUDIO.bitrate, aac: { format: 'aac' } } );
		if ( s && s.supported ) {

			if ( await canDecodeAac() ) return { ok: true, reason: '' };
			return { ok: false, reason: 'this browser can encode AAC but cannot decode it (a Chromium build without proprietary codecs, such as the VS Code or Electron browser). The AAC encoder\u2019s start-up delay can only be measured by decoding, and the publish will not guess it. Publish from desktop Chrome, Edge or Safari.' };

		}

	} catch ( e ) { /* fall through */ }
	return { ok: false, reason: 'this browser cannot encode AAC-LC (WebCodecs AudioEncoder mp4a.40.2). Publish from desktop Chrome or Edge.' };

}

/** Decodes any audio file the browser knows (WAV included) to exactly `length` samples of 48 kHz stereo. */
export async function decodeToStereo48k( bytes, length ) {

	const ctx = new OfflineAudioContext( 2, Math.max( 1, length ), AUDIO.sampleRate );
	const buffer = await ctx.decodeAudioData( bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength ) );   // resamples to the context's rate
	const channels = Array.from( { length: buffer.numberOfChannels }, ( _, c ) => buffer.getChannelData( c ) );
	return toStereo( channels, length );

}

/** Is this a file the browser can decode as audio, and how long is it? Resolves { seconds }; rejects with a message that names the problem. */
export async function probeAudio( bytes ) {

	if ( ! bytes || bytes.length < 12 ) throw new Error( 'the file is empty or too short to be audio' );
	let buffer;
	try {

		buffer = await new OfflineAudioContext( 1, 1, AUDIO.sampleRate ).decodeAudioData( bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength ) );

	} catch ( e ) { throw new Error( 'this browser cannot decode it as audio (use a WAV, or an MP3 or M4A the browser plays)' ); }
	return { seconds: buffer.duration };

}

async function encodeRaw( left, right, onProgress = () => {} ) {

	const frames = [];
	let asc = null, failure = null;
	const encoder = new AudioEncoder( {
		output( chunk, meta ) {

			const d = new Uint8Array( chunk.byteLength );
			chunk.copyTo( d );
			frames.push( d );
			const desc = meta && meta.decoderConfig && meta.decoderConfig.description;
			if ( desc && ! asc ) asc = new Uint8Array( ArrayBuffer.isView( desc ) ? desc.buffer.slice( desc.byteOffset, desc.byteOffset + desc.byteLength ) : desc.slice( 0 ) );

		},
		error( e ) { failure = failure || e; },
	} );
	encoder.configure( { codec: AUDIO.codec, sampleRate: AUDIO.sampleRate, numberOfChannels: AUDIO.channels, bitrate: AUDIO.bitrate, aac: { format: 'aac' } } );
	const total = left.length;
	for ( let at = 0; at < total; at += AUDIO.frameSamples ) {

		if ( failure ) throw failure;
		const n = Math.min( AUDIO.frameSamples, total - at );
		const planar = new Float32Array( n * 2 );
		planar.set( left.subarray( at, at + n ), 0 );
		planar.set( right.subarray( at, at + n ), n );
		const data = new AudioData( { format: 'f32-planar', sampleRate: AUDIO.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round( at * 1e6 / AUDIO.sampleRate ), data: planar } );
		encoder.encode( data );
		data.close();
		if ( ( at / AUDIO.frameSamples ) % 64 === 63 ) {

			while ( encoder.encodeQueueSize > 32 ) await sleep( 1 );
			onProgress( at / total );
			await sleep( 0 );

		}

	}
	await encoder.flush();
	encoder.close();
	if ( failure ) throw failure;
	if ( ! asc ) throw new Error( 'The AAC encoder gave no AudioSpecificConfig.' );
	return { frames, asc };

}

async function decodeRaw( frames, asc ) {

	const pcm = [];
	let failure = null, got = 0;
	const decoder = new AudioDecoder( { output( a ) { const f = new Float32Array( a.numberOfFrames ); a.copyTo( f, { planeIndex: 0, format: 'f32-planar' } ); pcm.push( f ); got += f.length; a.close(); }, error( e ) { failure = failure || e; } } );
	decoder.configure( { codec: AUDIO.codec, sampleRate: AUDIO.sampleRate, numberOfChannels: AUDIO.channels, description: asc } );
	frames.forEach( ( d, i ) => decoder.decode( new EncodedAudioChunk( { type: 'key', timestamp: Math.round( i * AUDIO.frameSamples * 1e6 / AUDIO.sampleRate ), duration: Math.round( AUDIO.frameSamples * 1e6 / AUDIO.sampleRate ), data: d } ) ) );
	await decoder.flush();
	decoder.close();
	if ( failure ) throw failure;
	const out = new Float32Array( got );
	let at = 0;
	for ( const p of pcm ) { out.set( p, at ); at += p.length; }
	return out;

}

/** Lag, in samples, of `decoded` behind `source` (first `window` samples; both start with a loud burst). */
export function lagOf( source, decoded, window = 6000, maxLag = 6000 ) {

	let best = - Infinity, bestLag = 0;
	for ( let lag = 0; lag <= maxLag; lag ++ ) {

		let s = 0;
		for ( let i = 0; i < window; i += 2 ) { const j = i + lag; if ( j < decoded.length ) s += source[ i ] * decoded[ j ]; }
		if ( s > best ) { best = s; bestLag = lag; }

	}
	return bestLag;

}

/** The encoder's start-up delay in samples, measured with a noise burst that starts at sample 0. */
export async function calibrateDelay() {

	const n = AUDIO.sampleRate / 2;
	const burst = new Float32Array( n );
	let seed = 7;
	for ( let i = 0; i < 12000; i ++ ) { seed = ( seed * 1664525 + 1013904223 ) >>> 0; burst[ i ] = ( seed / 4294967296 - 0.5 ) * 0.6; }
	const { frames, asc } = await encodeRaw( burst, burst );
	const decoded = await decodeRaw( frames, asc );
	return lagOf( burst, decoded );

}

/**
 * Narration bytes -> a publishable audio rendition.
 * @param {{ bytes: Uint8Array, durationSeconds: number, videoStartsSeconds: number[], onProgress?: (f:number, text:string)=>void }} o
 * @returns {Promise<{ packaged, delaySamples: number, sourceSamples: number }>}
 */
export async function buildAudioRendition( { bytes, durationSeconds, videoStartsSeconds, onProgress = () => {} } ) {

	const support = await aacSupport();
	if ( ! support.ok ) throw new Error( support.reason.charAt( 0 ).toUpperCase() + support.reason.slice( 1 ) );
	const length = Math.round( durationSeconds * AUDIO.sampleRate );
	onProgress( 0, 'Decoding the narration\u2026' );
	const { left, right } = await decodeToStereo48k( bytes, length );
	onProgress( 0.1, 'Measuring the AAC encoder\u2019s start-up delay\u2026' );
	const delay = await calibrateDelay();
	// the decoder will put `delay` samples of start-up in front: take them off the front of the input, and keep the length with silence
	const l = new Float32Array( length ), r = new Float32Array( length );
	l.set( left.subarray( delay ) );
	r.set( right.subarray( delay ) );
	const { frames, asc } = await encodeRaw( l, r, f => onProgress( 0.2 + 0.8 * f, 'Encoding the narration (AAC)\u2026' ) );
	// the encoder flushes a few frames beyond the input (its start-up delay, padding); only the frames that cover the film are kept, so the track is
	// the film's length to within one AAC frame, not 68 ms longer
	const needed = Math.ceil( length / AUDIO.frameSamples );
	return { packaged: packageAudio( { frames: frames.slice( 0, needed ), asc, videoStartsSeconds } ), delaySamples: delay, sourceSamples: length };

}

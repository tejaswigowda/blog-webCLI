// ── ladder.js ──────────────────────────────────────────────────────────────────
// Turns the finished offline master into the rungs of the ladder, in the browser, with WebCodecs.
//   master samples --VideoDecoder--> frames --scale--> one VideoEncoder per rung --> packageRendition()
// The master is decoded once; every frame is drawn into each rung's canvas at that rung's size and encoded at that rung's bitrate,
// with a keyframe every two seconds of film (so a ~6 s segment is three whole GOPs, and starts on a keyframe).
// No raw frames ever leave this page, and nothing here reads a wall clock: frame n keeps the timestamp n * 1e6 / fps it had
// in the master, and the result is checked frame by frame.
// The poster comes from the same pass: the decoded frame at 15% of the film.

import { avcCodecCandidates, frameTimestampUs, frameDurationUs } from './frames.js';
import { codecFromAvcC, packageRendition } from './fmp4.js';
import { encoderInfo } from './encoderInfo.js';

const sleep = ms => new Promise( r => setTimeout( r, ms ) );

/** The first H.264 level the browser can encode at this size and rate, as a WebCodecs config. */
export async function pickEncoderConfig( { width, height, fps, bitrate, software = false } ) {

	for ( const codec of avcCodecCandidates( width, height, fps ) ) {

		const config = { codec, width, height, framerate: fps, bitrate, latencyMode: 'quality', avc: { format: 'avc' }, hardwareAcceleration: software ? 'prefer-software' : 'no-preference' };
		try {

			const s = await VideoEncoder.isConfigSupported( config );
			if ( s && s.supported ) return s.config || config;

		} catch ( e ) { /* try the next level */ }

	}
	throw new Error( `No H.264 encoder in this browser can encode ${ width } \u00d7 ${ height } at ${ fps } fps.` );

}

const toBytes = d => d ? ( ArrayBuffer.isView( d ) ? new Uint8Array( d.buffer.slice( d.byteOffset, d.byteOffset + d.byteLength ) ) : new Uint8Array( d.slice( 0 ) ) ) : undefined;

/**
 * @param {{ master: { width, height, fps, samples: Uint8Array[], keyframes: number[], avcC: Uint8Array }, ladder: { name, width, height, kbps }[], onProgress?: (fraction:number, text:string)=>void, shouldCancel?: ()=>boolean, posterAt?: number }} o
 *   keyframes are 0-based frame numbers
 * @returns {Promise<{ rungs: { rung, packaged, encoder }[], poster: Uint8Array } | null>}   encoder: the record of what that rung's encoder was given (encoderInfo.js), stage 'ladder'  null when cancelled
 */
export async function transcodeLadder( { master, ladder, onProgress = () => {}, shouldCancel = () => false, posterAt = 0.15, software = false } ) {

	if ( ! window.VideoDecoder || ! window.VideoEncoder || ! window.VideoFrame ) throw new Error( 'This browser has no WebCodecs (VideoDecoder / VideoEncoder).' );
	const { width, height, fps, samples, keyframes, avcC } = master;
	const total = samples.length;
	const isKey = new Set( keyframes );
	const keyEvery = fps * 2;
	const posterIndex = Math.round( posterAt * ( total - 1 ) );
	let failure = null;
	const fail = e => { failure = failure || e; };

	// one encoder per rung
	const outs = [];
	for ( const rung of ladder ) {

		const config = await pickEncoderConfig( { width: rung.width, height: rung.height, fps, bitrate: rung.kbps * 1000, software } );
		// what THIS rung's encoder was given, recorded here because it is not the master's: the master is encoded once at a mezzanine bitrate, and each rung is a
		// re-encode of the decoded master at its own size and bitrate (render.json records the two as separate stages)
		const record = { ...await encoderInfo( { kind: software ? 'software' : 'hardware', config, extra: { keyEvery }, userAgent: navigator.userAgent, brands: navigator.userAgentData && navigator.userAgentData.brands } ), stage: 'ladder', input: 'master' };
		const out = { rung, record, samples: [], keyframes: [], avcC: null, canvas: new OffscreenCanvas( rung.width, rung.height ), encoder: null };
		out.ctx = out.canvas.getContext( '2d' );
		out.ctx.imageSmoothingQuality = 'high';
		out.encoder = new VideoEncoder( {
			output( chunk, meta ) {

				try {

					const k = out.samples.length;
					if ( Math.abs( chunk.timestamp - frameTimestampUs( k, fps ) ) > 1 ) throw new Error( `${ rung.name }: encoded frame ${ k } has timestamp ${ chunk.timestamp } \u00b5s, expected ${ frameTimestampUs( k, fps ) } (dropped, repeated or reordered frame)` );
					const data = new Uint8Array( chunk.byteLength );
					chunk.copyTo( data );
					const d = meta && meta.decoderConfig && toBytes( meta.decoderConfig.description );
					if ( d && ! out.avcC ) out.avcC = d;
					if ( chunk.type === 'key' ) out.keyframes.push( k );
					out.samples.push( data );

				} catch ( e ) { fail( e ); }

			},
			error: fail,
		} );
		out.encoder.configure( config );
		outs.push( out );

	}

	let posterBlob = null;
	let produced = 0;
	const posterCanvas = new OffscreenCanvas( width, height );

	const decoder = new VideoDecoder( {
		output( frame ) {

			try {

				const n = produced ++;
				if ( Math.abs( frame.timestamp - frameTimestampUs( n, fps ) ) > 1 ) throw new Error( `decoded frame ${ n } has timestamp ${ frame.timestamp } \u00b5s, expected ${ frameTimestampUs( n, fps ) }` );
				if ( n === posterIndex ) {

					posterCanvas.getContext( '2d' ).drawImage( frame, 0, 0, width, height );
					posterBlob = posterCanvas.convertToBlob( { type: 'image/jpeg', quality: 0.88 } );

				}
				for ( const out of outs ) {

					out.ctx.drawImage( frame, 0, 0, out.rung.width, out.rung.height );
					const scaled = new VideoFrame( out.canvas, { timestamp: frameTimestampUs( n, fps ), duration: frameDurationUs( fps ) } );
					out.encoder.encode( scaled, { keyFrame: n % keyEvery === 0 } );
					scaled.close();

				}

			} catch ( e ) { fail( e ); } finally { frame.close(); }

		},
		error: fail,
	} );
	decoder.configure( { codec: codecFromAvcC( avcC ), codedWidth: width, codedHeight: height, description: avcC } );

	for ( let n = 0; n < total; n ++ ) {

		if ( failure ) throw failure;
		if ( shouldCancel() ) { decoder.close(); outs.forEach( o => o.encoder.close() ); return null; }
		decoder.decode( new EncodedVideoChunk( { type: isKey.has( n ) ? 'key' : 'delta', timestamp: master.ptsUs ? master.ptsUs[ n ] : frameTimestampUs( n, fps ), duration: frameDurationUs( fps ), data: samples[ n ] } ) );   // hls-webcli patch: ptsUs, for a master with reordered (B) frames
		if ( n % 8 === 7 ) {

			// backpressure: let the decoder and every encoder drain, and let the page paint and hear Cancel
			while ( decoder.decodeQueueSize > 16 || outs.some( o => o.encoder.encodeQueueSize > 16 ) ) await sleep( 1 );
			onProgress( n / total, `Encoding the ladder \u2014 frame ${ n.toLocaleString( 'en-US' ) } of ${ total.toLocaleString( 'en-US' ) }` );
			await sleep( 0 );

		}

	}

	await decoder.flush();
	if ( failure ) throw failure;
	await Promise.all( outs.map( o => o.encoder.flush() ) );
	if ( failure ) throw failure;
	decoder.close();
	outs.forEach( o => o.encoder.close() );

	if ( produced !== total ) throw new Error( `The decoder produced ${ produced } frames from ${ total } samples.` );
	for ( const o of outs ) {

		if ( o.samples.length !== total ) throw new Error( `${ o.rung.name }: ${ o.samples.length } frames encoded, expected ${ total }.` );
		if ( ! o.avcC ) throw new Error( `${ o.rung.name }: the encoder gave no codec description.` );

	}
	if ( ! posterBlob ) throw new Error( 'No poster frame was captured.' );

	const rungs = outs.map( o => ( { rung: o.rung, encoder: o.record, packaged: packageRendition( { width: o.rung.width, height: o.rung.height, fps, avcC: o.avcC, samples: o.samples, keyframes: o.keyframes } ) } ) );
	const poster = new Uint8Array( await ( await posterBlob ).arrayBuffer() );
	onProgress( 1, 'Ladder encoded.' );
	return { rungs, poster };

}

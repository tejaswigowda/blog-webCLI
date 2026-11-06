// ── encoderInfo.js ───────────────────────────────────────────────────────────────────────────────
// The encoder as a recorded choice (render.json, render.encoder). Byte determinism is not a failure to be reported: it is a property that a software encoder at a
// recorded version with recorded settings has, and a hardware encoder does not promise. So the record says which was used, what it was, and what it was given.
//
//   kind           'software' | 'hardware'
//   name           what wrote the bytes: the browser's WebCodecs VideoEncoder (H.264)
//   version        the browser build (the encoder ships inside it, so the same bytes are promised for the same build)
//   settings_hash  sha256 of the exact configuration handed to the encoder (key order fixed), so two renders can be compared by one string
//   threads        null: WebCodecs does not let a page choose, and the record does not pretend it does

const hex = ( buf ) => Array.from( new Uint8Array( buf ), b => b.toString( 16 ).padStart( 2, '0' ) ).join( '' );

/** JSON with object keys in sorted order at every level: the same value is the same text. */
export function canonicalJson( v ) {

	if ( Array.isArray( v ) ) return '[' + v.map( canonicalJson ).join( ',' ) + ']';
	if ( v && typeof v === 'object' ) return '{' + Object.keys( v ).sort().filter( k => v[ k ] !== undefined ).map( k => JSON.stringify( k ) + ':' + canonicalJson( v[ k ] ) ).join( ',' ) + '}';
	return JSON.stringify( v === undefined ? null : v );

}

/** "Chrome 130.0.6723.58" from userAgentData brands when there are any, else from the user agent string. */
export function browserVersionOf( userAgent = '', brands = null ) {

	if ( Array.isArray( brands ) ) {

		const real = brands.filter( b => b && b.brand && ! /not.?a.?brand/i.test( b.brand ) );
		const pick = real.find( b => /chrome|edge|opera|brave/i.test( b.brand ) ) || real[ 0 ];
		if ( pick ) return `${ pick.brand } ${ pick.version }`;

	}
	const m = /(Edg|OPR|Chrome|Firefox|Version)\/([\d.]+)/.exec( userAgent );
	if ( ! m ) return null;
	const name = { Edg: 'Edge', OPR: 'Opera', Version: 'Safari' }[ m[ 1 ] ] || m[ 1 ];
	return `${ name } ${ m[ 2 ] }`;

}

/**
 * The record. `config` is what was given to VideoEncoder.configure (the codec string, size, bitrate, frame rate, avc format, latency mode, acceleration
 * preference) and `extra` any other setting that changes the bytes (the keyframe interval).
 */
export async function encoderInfo( { kind, config, extra = {}, userAgent = '', brands = null } ) {

	const used = {
		codec: config.codec, width: config.width, height: config.height, bitrate: config.bitrate, framerate: config.framerate,
		avc: config.avc || null, latencyMode: config.latencyMode || null, hardwareAcceleration: config.hardwareAcceleration || null, ...extra,
	};
	const hash = hex( await crypto.subtle.digest( 'SHA-256', new TextEncoder().encode( canonicalJson( used ) ) ) );
	return { kind: kind === 'software' ? 'software' : 'hardware', name: 'WebCodecs VideoEncoder (H.264)', version: browserVersionOf( userAgent, brands ), settings_hash: 'sha256:' + hash, threads: null, config: used };

}

// ── frameHashes.js ───────────────────────────────────────────────────────────────────────────────
// Making the determinism claim checkable. Every rendered frame is hashed (sha256 over its raw RGB, as drawn, before the encoder sees it), and the list is
// published beside the render with a root hash in render.json. Three things follow:
//   1  two renders are compared by diffing two lists: the frames that differ are named, with no re-render and no eyeballing
//   2  a third party can verify the claim
//   3  frames and bytes are separated by construction: the same hashes with different file bytes is the encoder, and nothing else
//
// And the test that the claim needs (guides/TIME_SOURCES.md, "The shuffled-order test"): frame n must depend on n / fps and on nothing else. A sequential render
// can repeat the same leaked state twice and look deterministic while being wrong, so the frames are drawn again in a shuffled order and compared with the
// sequential hashes. A transition that carries state from one frame to the next fails at once, and the failure names the frames.
//
// Pure functions (and one async hash that uses WebCrypto, which node has too), so all of it runs in node tests.

export const FRAME_HASHES_VERSION = 1;
export const FRAME_HASH_OVER = 'raw RGB, 8 bits per channel, row by row, of the composited frame before encoding';

const hex = ( buf ) => Array.from( new Uint8Array( buf ), b => b.toString( 16 ).padStart( 2, '0' ) ).join( '' );

/** RGBA pixels (canvas getImageData) to RGB: the alpha channel of a finished frame is always opaque and says nothing. `out` may be reused. */
export function packRgb( rgba, out = null ) {

	const n = rgba.length / 4;
	const rgb = out && out.length === n * 3 ? out : new Uint8Array( n * 3 );
	for ( let i = 0, j = 0; i < rgba.length; i += 4, j += 3 ) { rgb[ j ] = rgba[ i ]; rgb[ j + 1 ] = rgba[ i + 1 ]; rgb[ j + 2 ] = rgba[ i + 2 ]; }
	return rgb;

}

/** sha256 of the RGB of one frame, as 64 hex characters. */
export async function hashFrame( rgba ) {

	return hex( await crypto.subtle.digest( 'SHA-256', packRgb( rgba ) ) );

}

export async function sha256Text( text ) {

	return hex( await crypto.subtle.digest( 'SHA-256', new TextEncoder().encode( text ) ) );

}

/**
 * The sidecar file (frame-hashes.txt): a short header, then one line per frame, `<frame number> <sha256>`. One line per frame, so that `diff` of two
 * renders' files is the list of frames that differ.
 */
export function sidecarText( { hashes, first = 0, width, height, fps } ) {

	const lines = [
		`# strata-frame-hashes ${ FRAME_HASHES_VERSION }`,
		`# sha256 over ${ FRAME_HASH_OVER }`,
		`# size ${ width }x${ height } at ${ fps } fps`,
		`# frames ${ hashes.length }, numbered from ${ first }`,
	];
	hashes.forEach( ( h, i ) => lines.push( `${ first + i } ${ h }` ) );
	return lines.join( '\n' ) + '\n';

}

/** The sidecar's frame list, or an error when a line is not "<n> <64 hex>" or the numbers are not consecutive. */
export function parseSidecar( text ) {

	const hashes = [];
	let first = null;
	for ( const line of String( text ).split( '\n' ) ) {

		if ( ! line || line.startsWith( '#' ) ) continue;
		const m = /^(\d+) ([0-9a-f]{64})$/.exec( line );
		if ( ! m ) return { error: `not a frame hash line: "${ line.slice( 0, 40 ) }"` };
		const n = Number( m[ 1 ] );
		if ( first === null ) first = n;
		else if ( n !== first + hashes.length ) return { error: `frame ${ n } is out of order (expected ${ first + hashes.length })` };
		hashes.push( m[ 2 ] );

	}
	return { first: first === null ? 0 : first, hashes };

}

/** The root hash: sha256 of the sidecar's bytes, as "sha256:<hex>". It is what render.json carries. */
export async function rootHash( sidecar ) {

	return 'sha256:' + await sha256Text( sidecar );

}

/** Frames whose hashes differ between two renders of the same frame numbers: { frames: [n…], onlyIn: { a: [n…], b: [n…] } }. */
export function diffHashes( a, b ) {

	const A = new Map( a.hashes.map( ( h, i ) => [ a.first + i, h ] ) ), B = new Map( b.hashes.map( ( h, i ) => [ b.first + i, h ] ) );
	const frames = [], onlyA = [], onlyB = [];
	for ( const [ n, h ] of A ) { if ( ! B.has( n ) ) onlyA.push( n ); else if ( B.get( n ) !== h ) frames.push( n ); }
	for ( const n of B.keys() ) if ( ! A.has( n ) ) onlyB.push( n );
	return { frames, onlyIn: { a: onlyA, b: onlyB } };

}

/** Collapses [310, 311, 312, 610, 620] to "310-312, 610, 620" (what a person reads); `limit` ranges at most. */
export function frameRanges( frames, limit = 12 ) {

	const out = [];
	for ( const n of frames ) {

		const last = out[ out.length - 1 ];
		if ( last && n === last[ 1 ] + 1 ) last[ 1 ] = n; else out.push( [ n, n ] );

	}
	const text = out.slice( 0, limit ).map( ( [ a, b ] ) => ( a === b ? String( a ) : `${ a }-${ b }` ) ).join( ', ' );
	return out.length > limit ? text + `, and ${ out.length - limit } more ranges` : text;

}

/** Every `every`-th frame of first..last, always including the last (a fade ends there), as a list. every = 1 is all of them. */
export function strideFrames( first, last, every = 1 ) {

	const step = Math.max( 1, Math.floor( every ) ), out = [];
	for ( let n = first; n <= last; n += step ) out.push( n );
	if ( out[ out.length - 1 ] !== last ) out.push( last );
	return out;

}

/** A small seeded generator (mulberry32): the shuffle must itself be reproducible, or a failure could not be repeated. */
export function mulberry32( seed ) {

	let a = seed >>> 0;
	return () => {

		a = ( a + 0x6D2B79F5 ) >>> 0;
		let t = a;
		t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
		t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

/** A 32-bit seed from any string (FNV-1a). */
export function seedOf( text ) {

	let h = 0x811C9DC5;
	for ( let i = 0; i < text.length; i ++ ) { h ^= text.charCodeAt( i ); h = Math.imul( h, 0x01000193 ) >>> 0; }
	return h >>> 0;

}

/**
 * The frames in a shuffled order. It is a derangement-ish shuffle, not just a shuffle: no frame is left next to the frame that came before it in the
 * sequential render, because a leak that only shows between neighbours would hide in a shuffle that happens to keep some of them together.
 */
export function shuffledOrder( frames, seed ) {

	const rand = mulberry32( seed ), order = frames.slice();
	for ( let attempt = 0; attempt < 8; attempt ++ ) {

		for ( let i = order.length - 1; i > 0; i -- ) { const j = Math.floor( rand() * ( i + 1 ) ); [ order[ i ], order[ j ] ] = [ order[ j ], order[ i ] ]; }
		if ( ! hasNeighbours( order ) ) return order;

	}
	return order;

}

function hasNeighbours( order ) {

	for ( let i = 1; i < order.length; i ++ ) if ( Math.abs( order[ i ] - order[ i - 1 ] ) === 1 ) return true;
	return false;

}

/**
 * The result of the shuffled-order test, in the form render.json carries. `sequential` and `shuffled` are { frame: hash } for the frames checked.
 * `complete` is true only when every frame of the render was checked (every = 1): a stride is evidence, not a claim.
 */
export function verificationResult( { sequential, shuffled, first, last, every, seed } ) {

	const mismatches = [];
	for ( const n of Object.keys( shuffled ).map( Number ).sort( ( a, b ) => a - b ) ) if ( sequential[ n ] !== shuffled[ n ] ) mismatches.push( n );
	const checked = Object.keys( shuffled ).length, total = last - first + 1;
	return {
		method: 'shuffled-order',
		every, seed, frames_checked: checked, of: total,
		complete: every === 1 && checked === total,
		passed: mismatches.length === 0,
		mismatched_frames: mismatches.slice( 0, 200 ),
		mismatched_count: mismatches.length,
	};

}

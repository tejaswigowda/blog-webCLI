// files.sha256: the hash of every file of a published render, in the format `sha256sum -c` reads. Frame hashes are taken before encoding and cover no segment, so
// until now nothing said whether a mirror holds the bytes that were published. The manifest does: it is what the sync to storage is verified against, what each mirror
// is checked against, and what makes a half-synced mirror show as missing files instead of silently playing wrong. Pure logic over an injected fetch and hash, so it
// runs in the editor, in node (tools/verify-publication.mjs) and in the tests.

import { sha256Hex } from './records.js';

export const MANIFEST_NAME = 'files.sha256';

const byPath = ( a, b ) => a < b ? - 1 : a > b ? 1 : 0;

/** "<hex>  <path>\n" per file, sorted by path, paths relative to the folder. The manifest never lists itself. */
export async function buildManifest( files, folder, sha256 = sha256Hex ) {

	const prefix = folder.replace( /\/+$/, '' ) + '/';
	const rows = [];
	for ( const f of files ) {

		if ( ! f.path.startsWith( prefix ) ) throw new Error( `${ f.path } is outside ${ folder }/` );
		const rel = f.path.slice( prefix.length );
		if ( rel === MANIFEST_NAME ) continue;
		rows.push( [ rel, await sha256( f.bytes ) ] );

	}
	rows.sort( ( a, b ) => byPath( a[ 0 ], b[ 0 ] ) );
	return rows.map( ( [ rel, hash ] ) => `${ hash }  ${ rel }\n` ).join( '' );

}

/** { entries: Map<path, hex>, errors: string[] } of a manifest's text; a malformed or duplicate line is an error, not skipped. */
export function parseManifest( text ) {

	const entries = new Map(), errors = [];
	String( text ).split( '\n' ).forEach( ( line, i ) => {

		if ( line === '' ) return;
		const m = /^([0-9a-f]{64}) [ *](.+)$/.exec( line );
		if ( ! m ) { errors.push( `line ${ i + 1 } is not "<sha256>  <path>"` ); return; }
		if ( entries.has( m[ 2 ] ) ) errors.push( `${ m[ 2 ] } is listed twice` );
		entries.set( m[ 2 ], m[ 1 ] );

	} );
	return { entries, errors };

}

/** The set with files.sha256 added: it lists every other file, render.json included. Returns the same object, updated. */
export async function addManifest( set, folder, sha256 = sha256Hex ) {

	const text = await buildManifest( set.files, folder, sha256 );
	const bytes = new TextEncoder().encode( text );
	const path = folder.replace( /\/+$/, '' ) + '/' + MANIFEST_NAME;
	set.files = set.files.filter( f => f.path !== path );
	set.files.push( { path, bytes } );
	set.tree = set.files.map( f => ( { path: f.path, bytes: f.bytes.length } ) );
	set.total = set.files.reduce( ( n, f ) => n + f.bytes.length, 0 );
	return set;

}

/**
 * Checks a folder served at `base` against its own files.sha256.
 *   fetchBytes( url ) -> Uint8Array, throwing an Error with .status on an HTTP failure
 * @returns {{ ok, checked, missing: string[], mismatched: string[], flaky: { path, attempts }[], errors: string[], manifest: boolean }}
 *   `missing`: listed and not served after every attempt (a half-synced mirror shows here); `mismatched`: served with other bytes (never retried: a wrong answer is not transient);
 *   `flaky`: served only on a later attempt. A CDN edge can answer 404 or nothing for a file that exists (seen on jsDelivr, run to run), so one failure is not "missing"; a file that needs
 *   a retry is reported, because it is how a mirror's reliability shows.
 */
export async function verifyBase( base, { fetchBytes, sha256 = sha256Hex, concurrency = 6, onProgress = () => {}, only = null, attempts = 4, delayMs = 1000, sleep = ms => new Promise( r => setTimeout( r, ms ) ) } ) {

	const root = base.replace( /\/*$/, '/' );
	let text = null, lastError = null;
	for ( let t = 0; t < attempts && text === null; t ++ ) {

		if ( t > 0 ) await sleep( delayMs * 2 ** ( t - 1 ) );
		try { text = new TextDecoder().decode( await fetchBytes( root + MANIFEST_NAME ) ); } catch ( e ) { lastError = e; }

	}
	if ( text === null ) {

		const e = lastError;
		return { ok: false, checked: 0, missing: [], mismatched: [], flaky: [], errors: [ `${ MANIFEST_NAME } is not served at ${ root } (${ e.message })` ], manifest: false };

	}
	const { entries, errors } = parseManifest( text );
	const paths = [ ...entries.keys() ].filter( p => ! only || only( p ) );
	const missing = [], mismatched = [], flaky = [];
	let next = 0, checked = 0;
	await Promise.all( Array.from( { length: Math.min( concurrency, paths.length ) }, async () => {

		while ( next < paths.length ) {

			const p = paths[ next ++ ];
			const url = root + p.split( '/' ).map( encodeURIComponent ).join( '/' ).replace( /%2B/g, '+' );
			let bytes = null, tries = 0;
			while ( bytes === null && tries < attempts ) {

				if ( tries ++ > 0 ) await sleep( delayMs * 2 ** ( tries - 2 ) );
				try { bytes = await fetchBytes( url ); } catch ( e ) { /* try again */ }

			}
			if ( bytes === null ) missing.push( p );
			else {

				if ( tries > 1 ) flaky.push( { path: p, attempts: tries } );
				if ( await sha256( bytes ) !== entries.get( p ) ) mismatched.push( p );

			}
			onProgress( ++ checked, paths.length );

		}

	} ) );
	missing.sort(); mismatched.sort(); flaky.sort( ( a, b ) => byPath( a.path, b.path ) );
	return { ok: errors.length === 0 && missing.length === 0 && mismatched.length === 0, checked, missing, mismatched, flaky, errors, manifest: true };

}

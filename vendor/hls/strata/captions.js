// ── captions.js ───────────────────────────────────────────────────────────────────────────────────
// Captions as a projection of the scene's cue list, not a transcription. The cue list is the same object that drove the narration's timing, so a caption built
// from it cannot drift against the audio: they are two renderings of one thing. That is what makes a missing caption file an export that has not been run, and
// not a transcription job; only a render whose scene has no cue list needs ASR, and then the track says so (source: "asr") because an ASR timing is
// inferred and a cue-derived one is exact.
//
// Four things in this file, all pure (node and the browser share them):
//   1  the cue's identity. A cue id is authored and stable, never positional: it is written as the WebVTT cue identifier, so a caption is addressable the way a
//      scene object is (a player can seek to it, a claim can be tied to the moment it is made, a link can name a cue instead of a timestamp)
//   2  the VTT writer and parser, with a NOTE block that makes the file say what it was generated from (the scene, the hash of the cues, the source)
//   3  the track record that goes in render.json, and the HLS subtitle group that goes in master.m3u8
//   4  the state of a render's captions (present / stale / missing), by comparing what the file CONTAINS with what the scene's cues say now: a caption can be
//      present and wrong, and a presence check cannot see that

export const CAPTION_SOURCES = [ 'cues', 'asr', 'manual' ];
export const SUBTITLE_GROUP = 'subs';

// ── 1. identity ────────────────────────────────────────────────────────────────────────────────────

/** What an id may be: it is a VTT identifier, a URL parameter (&cue=<id>) and a file-safe token. */
export const CUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/;

/** A cue's text as it is written: no blank line (it would end the cue), no "-->" (it would start a timing line). */
const clean = t => String( t ?? '' ).replace( /\r/g, '' ).replace( /\n{2,}/g, '\n' ).replace( /-->/g, '\u2192' ).trim();
const ms = s => Math.round( ( Number.isFinite( +s ) ? +s : 0 ) * 1000 );

/**
 * The cues a caption file holds, from a scene's cue list: the ones with words and a positive length, in time order, times at millisecond precision, text as
 * written. Order is start, then end, then id, so it is the same list whatever order the scene stored them in.
 */
export function captionCues( cues ) {

	return ( Array.isArray( cues ) ? cues : [] )
		.filter( c => c && clean( c.text ) !== '' && ms( c.end ) > ms( c.start ) )
		.map( c => ( { id: c.id === undefined || c.id === null ? null : String( c.id ), start: ms( c.start ) / 1000, end: ms( c.end ) / 1000, text: clean( c.text ) } ) )
		.sort( ( a, b ) => a.start - b.start || a.end - b.end || String( a.id ).localeCompare( String( b.id ) ) );

}

/** Problems with the ids of these cues (each is a sentence): none, an invalid one, or a duplicate. Empty when every cue is addressable. */
export function cueIdProblems( cues ) {

	const out = [], seen = new Map();
	for ( const c of captionCues( cues ) ) {

		const label = `the cue at ${ c.start } s ("${ c.text.slice( 0, 24 ) }${ c.text.length > 24 ? '\u2026' : '' }")`;
		if ( c.id === null || c.id === '' ) { out.push( `${ label } has no id` ); continue; }
		if ( ! CUE_ID_PATTERN.test( c.id ) ) out.push( `${ label } has the id "${ c.id }", which is not a valid cue id (letters, digits, "." "_" "~" "-", starting with a letter or digit, at most 64)` );
		if ( seen.has( c.id ) ) out.push( `the id "${ c.id }" is used by ${ label } and by ${ seen.get( c.id ) }: an id names one cue` );
		else seen.set( c.id, label );

	}
	return out;

}

/** A readable id for a cue from its words ("Why do these three molecules..." -> "why-do-these-three"), unique among `taken`. For authoring; never computed from position. */
export function slugCueId( text, taken = new Set() ) {

	const words = String( text || '' ).toLowerCase().normalize( 'NFKD' ).replace( /[\u0300-\u036f]/g, '' ).replace( /[^a-z0-9]+/g, ' ' ).trim().split( ' ' ).filter( Boolean );
	let base = words.slice( 0, 4 ).join( '-' ).slice( 0, 40 ) || 'cue';
	let id = base, n = 2;
	while ( taken.has( id ) ) id = `${ base }-${ n ++ }`;
	return id;

}

/**
 * New cues (from an imported .srt, say) with the ids of the cues they are the edit of. An .srt has no ids, so an import used to give every cue a new one, which
 * silently broke every link made before it. A cue keeps the id of an old cue with the same words and times; failing that the same words (re-timed), failing that the
 * same times (re-worded). One old id is used once. Anything left over keeps the id it was given.
 */
export function reconcileIds( oldCues, newCues ) {

	// every old cue with an id, including one with no words yet (a cue just added): it is still a cue, and still has a name
	const olds = ( Array.isArray( oldCues ) ? oldCues : [] ).filter( c => c && typeof c.id === 'string' && c.id ).map( c => ( { id: c.id, start: ms( c.start ) / 1000, end: ms( c.end ) / 1000, text: clean( c.text ) } ) ), used = new Set();
	const take = ( pred ) => { const o = olds.find( c => ! used.has( c.id ) && pred( c ) ); if ( o ) used.add( o.id ); return o ? o.id : null; };
	const out = newCues.map( c => ( { ...c } ) );
	const done = new Array( out.length ).fill( false );
	const pass = ( pred ) => out.forEach( ( c, i ) => { if ( done[ i ] ) return; const id = take( o => pred( o, c ) ); if ( id ) { c.id = id; done[ i ] = true; } } );
	pass( ( o, c ) => o.text === clean( c.text ) && o.start === ms( c.start ) / 1000 && o.end === ms( c.end ) / 1000 );
	pass( ( o, c ) => o.text === clean( c.text ) );
	pass( ( o, c ) => o.start === ms( c.start ) / 1000 && o.end === ms( c.end ) / 1000 );
	// what is left keeps the id it was given (a cue with none is left without one, for the caller to number), unless that id is one an old cue now holds
	const taken = new Set( out.filter( ( c, i ) => done[ i ] ).map( c => c.id ) );
	for ( let i = 0; i < out.length; i ++ ) if ( ! done[ i ] && out[ i ].id ) { while ( taken.has( out[ i ].id ) || used.has( out[ i ].id ) ) out[ i ].id = out[ i ].id + 'x'; taken.add( out[ i ].id ); }
	return out;

}

/**
 * `newCues` with an id on every cue that came without one, taken from the old cue it is the edit of (see reconcileIds), so that a caller that only has words and times
 * (the Shell's setSubtitles, a script) does not hand every cue a new id each time it saves. A cue that already has an id keeps it; one that matches nothing is left
 * without, for normalizeCues to number.
 */
export function fillIds( oldCues, newCues ) {

	const list = Array.isArray( newCues ) ? newCues : [];
	const has = c => c && typeof c.id === 'string' && c.id !== '';
	const kept = new Set( list.filter( has ).map( c => c.id ) );
	const free = ( Array.isArray( oldCues ) ? oldCues : [] ).filter( c => has( c ) && ! kept.has( c.id ) );
	const need = list.map( ( c, i ) => [ c, i ] ).filter( ( [ c ] ) => c && ! has( c ) );
	const got = reconcileIds( free, need.map( ( [ c ] ) => ( { ...c, id: undefined } ) ) );
	const out = list.map( c => c );
	need.forEach( ( [ c, i ], k ) => { out[ i ] = got[ k ].id ? { ...c, id: got[ k ].id } : c; } );
	return out;

}

// ── hashes ─────────────────────────────────────────────────────────────────────────────────────────

const hex = buf => Array.from( new Uint8Array( buf ), b => b.toString( 16 ).padStart( 2, '0' ) ).join( '' );
const sha256 = async text => 'sha256:' + hex( await crypto.subtle.digest( 'SHA-256', new TextEncoder().encode( text ) ) );

/** sha256 of the cues as a caption file holds them: id, start, end and text of each, so it changes exactly when the file's cues should. */
export async function cuesHash( cues ) {

	return sha256( JSON.stringify( captionCues( cues ).map( c => [ c.id, ms( c.start ), ms( c.end ), c.text ] ) ) );

}

/** sha256 of the ids and times only, with no words: what a translation must share with the cues it translates. */
export async function structureHash( cues ) {

	return sha256( JSON.stringify( captionCues( cues ).map( c => [ c.id, ms( c.start ), ms( c.end ) ] ) ) );

}

// ── 2. the VTT ─────────────────────────────────────────────────────────────────────────────────────

/** Seconds -> 00:00:04.650 (WebVTT timestamp). */
export function vttTime( seconds ) {

	const t = Math.round( seconds * 1000 ), pad = ( n, w = 2 ) => String( n ).padStart( w, '0' );
	return `${ pad( Math.floor( t / 3600000 ) ) }:${ pad( Math.floor( t / 60000 ) % 60 ) }:${ pad( Math.floor( t / 1000 ) % 60 ) }.${ pad( t % 1000, 3 ) }`;

}

/** 00:00:04.650 or 04.650 or 1:04.650 -> seconds, or null. */
export function parseVttTime( str ) {

	const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})$/.exec( String( str ).trim() );
	return m ? ( +( m[ 1 ] || 0 ) ) * 3600 + ( +m[ 2 ] ) * 60 + ( +m[ 3 ] ) + ( +m[ 4 ] ) / 1000 : null;

}

const NOTE_KEYS = [ 'scene', 'cues', 'structure', 'source', 'language', 'ids', 'translation_of', 'translated_from', 'asr', 'exporter' ];

/**
 * The provenance block: `NOTE` and one `key  value` line each, so a file that travels away from its render (uploaded to a platform, sent to a translator) still
 * says where it came from and what it was generated against. Nothing in it changes when nothing about the cues does: no date, no counter.
 */
export function noteBlock( fields ) {

	const keys = NOTE_KEYS.filter( k => fields[ k ] !== undefined && fields[ k ] !== null && fields[ k ] !== '' );
	return 'NOTE\n' + keys.map( k => `${ k.padEnd( 15 ) } ${ String( fields[ k ] ).replace( /-->/g, '\u2192' ).replace( /\s*\n\s*/g, ' ' ) }` ).join( '\n' ) + '\n';

}

/** "tejaswigowda/test1@fdb3a56 a+b-cubed.json" from a scene record, or null when there is nothing to say. */
export function sceneLine( scene ) {

	if ( ! scene ) return null;
	const at = scene.commit ? `${ scene.repo || '' }@${ String( scene.commit ).slice( 0, 7 ) }` : ( scene.repo || '' );
	return `${ at } ${ scene.file || '' }`.trim() || null;

}

/**
 * One caption file. `cues`: the scene's cue list (or, for source "asr", cues with no ids). `ids: false` writes no identifiers (an ASR track has no authored ids, and
 * a positional one would be worse than none). Resolves { text, cues_sha256, structure_sha256, cue_count }, or null when there is nothing to write.
 */
export async function vttFile( { cues, language = 'en', source = 'cues', scene = null, exporter = null, translationOf = null, translatedFrom = null, asr = null, ids = true } ) {

	const list = captionCues( cues );
	if ( list.length === 0 ) return null;
	if ( ids ) { const bad = cueIdProblems( list ); if ( bad.length ) throw new Error( 'captions: ' + bad.join( '; ' ) ); }
	const cues_sha256 = await cuesHash( list ), structure_sha256 = await structureHash( list );
	const note = noteBlock( { scene: sceneLine( scene ), cues: cues_sha256, structure: structure_sha256, source, language, ids: ids ? 'authored' : 'none', translation_of: translationOf, translated_from: translatedFrom, asr: asr ? [ asr.model, asr.version ].filter( Boolean ).join( ' ' ) : null, exporter } );
	const body = list.map( c => `${ ids ? c.id + '\n' : '' }${ vttTime( c.start ) } --> ${ vttTime( c.end ) }\n${ c.text }\n` ).join( '\n' );
	return { text: `WEBVTT\n\n${ note }\n${ body }`, cues_sha256, structure_sha256, cue_count: list.length };

}

/**
 * A caption file read back: { cues: [{ id|null, start, end, text }], provenance: {key: value}|null, problems: [] }. NOTE, STYLE and REGION blocks are skipped (the NOTE
 * that carries `source` or `cues` is the provenance), cue settings after the timing are ignored, and a line of text may not be mistaken for an identifier.
 */
export function parseVtt( text ) {

	const problems = [], cues = [];
	let provenance = null;
	const blocks = String( text ).replace( /^\uFEFF/, '' ).replace( /\r\n?/g, '\n' ).split( /\n{2,}/ );
	const head = ( blocks.shift() || '' ).split( '\n' )[ 0 ];
	if ( ! /^WEBVTT(?:[ \t]|$)/.test( head ) ) problems.push( 'does not start with WEBVTT' );
	for ( const raw of blocks ) {

		const lines = raw.split( '\n' ).filter( ( l, i, a ) => ! ( l === '' && ( i === 0 || i === a.length - 1 ) ) );
		if ( lines.length === 0 ) continue;
		if ( /^NOTE(?:[ \t]|$)/.test( lines[ 0 ] ) ) {

			const fields = {};
			for ( const l of lines.slice( 1 ) ) { const m = /^([a-z_]+)\s+(.+)$/.exec( l.trim() ); if ( m ) fields[ m[ 1 ] ] = m[ 2 ].trim(); }
			if ( ( fields.cues || fields.source ) && ! provenance ) provenance = fields;
			continue;

		}
		if ( /^(STYLE|REGION)(?:[ \t]|$)/.test( lines[ 0 ] ) ) continue;
		const at = lines.findIndex( l => l.includes( '-->' ) );
		if ( at < 0 || at > 1 ) { problems.push( `a block with no timing: "${ lines[ 0 ].slice( 0, 30 ) }"` ); continue; }
		const m = /^(\S+)\s+-->\s+(\S+)/.exec( lines[ at ] );
		const start = m && parseVttTime( m[ 1 ] ), end = m && parseVttTime( m[ 2 ] );
		if ( start === null || end === null || ! m ) { problems.push( `a timing line that is not one: "${ lines[ at ].slice( 0, 40 ) }"` ); continue; }
		cues.push( { id: at === 1 ? lines[ 0 ] : null, start, end, text: lines.slice( at + 1 ).join( '\n' ) } );

	}
	return { cues, provenance, problems };

}

// ── 3. the record, and the HLS group ───────────────────────────────────────────────────────────────

/** captions.vtt for the first (or only) track of a render, captions.<language>.vtt for the others. */
export const trackPath = ( language, isDefault ) => isDefault ? 'captions.vtt' : `captions.${ language }.vtt`;
export const subtitlePlaylistPath = ( language ) => `subs/${ language }/index.m3u8`;

export const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** What render.json says of one caption track (outputs.caption_tracks). `cues_sha256` is of what THIS file holds; `translated_from` of the cues it was made from. */
export function trackRecord( { path, language, source, file, translationOf = null, translatedFrom = null, asr = null, ids = true } ) {

	const r = { path, language, source, cues_sha256: file.cues_sha256, structure_sha256: file.structure_sha256, cue_count: file.cue_count, addressable: !! ids };
	if ( translationOf ) { r.translation_of = translationOf; r.translated_from = translatedFrom; }
	if ( asr ) r.asr = { model: asr.model, version: asr.version === undefined ? null : asr.version };
	return r;

}

/**
 * One cue-derived track, ready to publish: { path, language, default, text, record }, or null when there are no cues. `isDefault` is the render's own track
 * (captions.vtt); the others are captions.<language>.vtt. The record is what render.json says of it (the HLS playlist is added where the master is).
 */
export async function cueTrack( { cues, language = 'en', scene = null, exporter = null, isDefault = true } ) {

	const file = await vttFile( { cues, language, source: 'cues', scene, exporter } );
	if ( ! file ) return null;
	const path = trackPath( language, isDefault );
	return { path, language, default: isDefault, text: file.text, record: trackRecord( { path, language, source: 'cues', file } ) };

}

/** The record of a track read back from its own file (the file is the truth: its NOTE says how it was made, its cues say what it holds). */
export async function recordOfFile( path, text, { defaultLanguage = 'en' } = {} ) {

	const { cues, provenance, problems } = parseVtt( text );
	const list = captionCues( cues );
	const p = provenance || {};
	const asrParts = p.asr ? p.asr.split( ' ' ) : null;
	const addressable = list.length > 0 && list.every( c => c.id );
	const r = {
		path, language: p.language || defaultLanguage, source: CAPTION_SOURCES.includes( p.source ) ? p.source : ( provenance ? 'manual' : null ),
		cues_sha256: await cuesHash( list ), structure_sha256: await structureHash( list ), cue_count: list.length, addressable,
	};
	if ( p.translation_of ) { r.translation_of = p.translation_of; r.translated_from = p.translated_from || null; }
	if ( asrParts ) r.asr = { model: asrParts[ 0 ], version: asrParts[ 1 ] || null };
	return { record: r, provenance, problems, cues: list, noteCues: p.cues || null };

}

/** Display name of a language in itself ("Español"), falling back to the code. */
export function languageName( language ) {

	try { const n = new Intl.DisplayNames( [ language ], { type: 'language' } ).of( language ); return n ? n.charAt( 0 ).toUpperCase() + n.slice( 1 ) : language; } catch ( e ) { return language; }

}

/** The subtitle playlist of one track: a single WebVTT segment, the whole caption file, over the length of the render. */
export function subtitlePlaylist( { uri, durationS } ) {

	return [ '#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${ Math.max( 1, Math.ceil( durationS ) ) }`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
		`#EXTINF:${ durationS.toFixed( 6 ) },`, uri, '#EXT-X-ENDLIST', '' ].join( '\n' );

}

/**
 * master.m3u8 with the subtitle group: one EXT-X-MEDIA TYPE=SUBTITLES per track and SUBTITLES="subs" on every variant. It removes what an earlier call added first, so
 * it can be applied again and again, to a master that has none or one that is out of date, and give the same text. `tracks`: [{ language, uri, default }].
 */
export function withSubtitles( master, tracks, group = SUBTITLE_GROUP ) {

	const lines = String( master ).replace( /\r/g, '' ).split( '\n' ).filter( l => ! /^#EXT-X-MEDIA:TYPE=SUBTITLES/.test( l ) )
		.map( l => /^#EXT-X-STREAM-INF:/.test( l ) ? l.replace( /,SUBTITLES="[^"]*"/, '' ) : l );
	if ( ! tracks.length ) return lines.join( '\n' );
	const media = tracks.map( t => `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${ group }",NAME="${ languageName( t.language ) }",DEFAULT=${ t.default ? 'YES' : 'NO' },AUTOSELECT=YES,FORCED=NO,LANGUAGE="${ t.language }",URI="${ t.uri }"` );
	const last = lines.reduce( ( acc, l, i ) => ( /^#EXT-X-(MEDIA|INDEPENDENT-SEGMENTS|VERSION)|^#EXTM3U/.test( l ) ? i : acc ), 0 );
	lines.splice( last + 1, 0, ...media );
	return lines.map( l => /^#EXT-X-STREAM-INF:/.test( l ) ? `${ l },SUBTITLES="${ group }"` : l ).join( '\n' );

}

// ── 4. the state of a render's captions ────────────────────────────────────────────────────────────

/**
 * The state of one caption track, by comparing what the file CONTAINS with what the scene's cues say now. Three states, not two:
 *   present   the file is there and its cues are the scene's (for a translation: the same ids and times, made from the scene's current words)
 *   stale     the file is there and is not: the cue list changed after it was written, it was edited by hand, or it carries no provenance
 *   missing   there is no file
 * Resolves { state, reasons: [] , action }. `file`: null (no file) or { record, provenance, noteCues, problems }; `scene`: { cues_sha256, structure_sha256, ids: [...],
 * hasCues } for the scene's cue list now; `base`: whether this is the render's own track, as opposed to a translation of it.
 */
export function assessTrack( { file, scene, base = true } ) {

	if ( ! file ) return { state: 'missing', reasons: [ 'there is no caption file' ], action: scene.hasCues ? ( base ? 'generate' : 'translate' ) : 'asr' };
	const r = file.record, reasons = [];
	if ( file.problems.length ) reasons.push( `the file does not parse (${ file.problems[ 0 ] })` );
	if ( ! file.provenance ) reasons.push( 'it carries no provenance (no NOTE block), so what it was generated from is not known' );
	else if ( file.noteCues && file.noteCues !== r.cues_sha256 ) reasons.push( 'it was edited after it was exported: its NOTE says one thing and its cues another' );

	if ( ! base ) {

		// a translation: same ids and same times as the scene, made from the words the scene has now
		const fileIds = new Set( ( file.cues || [] ).map( c => c.id ) ), sceneIds = new Set( scene.ids );
		const dropped = scene.ids.filter( id => ! fileIds.has( id ) ), extra = [ ...fileIds ].filter( id => id && ! sceneIds.has( id ) );
		if ( dropped.length ) reasons.push( `it has dropped ${ dropped.length } cue${ dropped.length === 1 ? '' : 's' } (${ dropped.slice( 0, 4 ).join( ', ' ) }${ dropped.length > 4 ? ', \u2026' : '' })` );
		if ( extra.length ) reasons.push( `it has ${ extra.length } cue${ extra.length === 1 ? '' : 's' } the scene no longer has (${ extra.slice( 0, 4 ).join( ', ' ) }${ extra.length > 4 ? ', \u2026' : '' })` );
		if ( ! dropped.length && ! extra.length && r.structure_sha256 !== scene.structure_sha256 ) reasons.push( 'the same cues, but some have been re-timed since' );
		if ( ! dropped.length && ! extra.length && r.structure_sha256 === scene.structure_sha256 && r.translated_from !== scene.cues_sha256 ) reasons.push( 'the words of the cues have changed since it was translated' );
		return reasons.length ? { state: 'stale', reasons, action: 'retranslate' } : { state: 'present', reasons: [], action: null };

	}

	if ( r.source === 'asr' || r.source === 'manual' ) {

		// not derived from the cue list, so it is not compared with it; say so when the scene now has cues that could replace it
		const note = scene.hasCues && r.source === 'asr' ? [ 'the scene has a cue list now: an exact track can replace this inferred one (--replace)' ] : [];
		return reasons.length ? { state: 'stale', reasons, action: scene.hasCues ? 'generate' : 'asr', notes: note } : { state: 'present', reasons: [], action: null, notes: note };

	}
	if ( ! scene.hasCues ) { reasons.push( 'the scene has no cue list to compare it with' ); return { state: 'stale', reasons, action: 'asr' }; }
	if ( r.cues_sha256 !== scene.cues_sha256 ) reasons.push( file.provenance ? 'the scene\u2019s cues have changed since it was written' : 'its cues are not the scene\u2019s (the ids, times or words differ)' );
	return reasons.length ? { state: 'stale', reasons, action: 'generate' } : { state: 'present', reasons: [], action: null };

}

/** The scene's cue list as `assessTrack` wants it. */
export async function sceneCues( cues ) {

	const list = captionCues( cues );
	return { hasCues: list.length > 0, cues: list, ids: list.map( c => c.id ), cues_sha256: await cuesHash( list ), structure_sha256: await structureHash( list ) };

}

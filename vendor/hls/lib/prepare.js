// ── prepare.js ─────────────────────────────────────────────────────────────────
// An uploaded video to a publish set, and a publish set to a tagged release. Everything that makes the set is Strata's code (docs/strata/); this file wires an
// upload to it the way Strata's Publish panel wires a finished render:
//   inspectVideo → planLadder → transcodeLadder → (buildAudioRendition) → assemblePublishSet → addManifest → gateRelease
// The browser-only steps (WebCodecs) are injected, so the same flow runs in node against a fake encoder in the tests.

import { inspectVideo } from './ingest.js';
import { planLadder, assemblePublishSet } from '../strata/publishSet.js';
import { addManifest } from '../strata/filesManifest.js';
import { planRelease, commitRelease, slugProblem, gateRelease, ReleaseError, publicationOf, shareBase, releaseBase, playerLink, CANONICAL_ORIGIN } from '../strata/releases.js';
import { recordOfFile } from '../strata/captions.js';
import { sha256Hex } from '../strata/records.js';
import { formatBytes } from '../strata/renderJson.js';

/** A video the tool will not package, with the code of why (ingest.js REASONS). */
export class RefusedError extends Error {

	constructor( refusal ) { super( refusal.detail ); this.name = 'RefusedError'; this.reason = refusal.reason; this.detail = refusal.detail; }

}

/** A fixed audit: an uploaded file was not drawn by Strata's time-source-audited renderer, so none of that audit's claims are made for it. */
export const UPLOAD_AUDIT = Object.freeze( { document: 'guides/TIME_SOURCES.md', passed: false, confirmed: [], residuals: [] } );

/** A file name as a render name: "My Clip (final).MP4" -> "my-clip-final". The result still goes through slugProblem(). */
export function slugFromFilename( name ) {

	return String( name || '' ).split( '/' ).pop().replace( /\.[^.]+$/, '' ).toLowerCase().replace( /[^a-z0-9+]+/g, '-' ).replace( /^-+|-+$/g, '' );

}

/**
 * @param {object} o
 *   file:     { name, bytes: Uint8Array }              the uploaded MP4 / MOV
 *   slug:     the render's name (folder and tag namespace)
 *   repo, branch:  where it will be published (owner/name); read for the next version, nothing is written
 *   keep:     heights of the ladder rungs to keep (null: all that fit)
 *   captions: null | { text, language }                a WebVTT file, shipped as it is, with its record read back from the file
 *   audio:    'keep' | 'drop'                          what to do with the file's audio track
 *   canonical: whether publication records Strata's permanent address (strataeditor.dev/video/<tag>/); only right for the renders repository that site serves
 *   api, deps: { transcodeLadder, buildAudioRendition, aacSupport }
 * @returns {{ set, plan, gate, ladder, info, renderJson }}
 */
export async function prepareUpload( { file, slug, repo, branch = 'main', keep = null, captions = null, audio = 'keep', canonical = false, api, deps, onProgress = () => {}, shouldCancel = () => false, now = () => new Date() } ) {

	onProgress( 0, 'Reading the video\u2026' );
	const seen = inspectVideo( file.bytes );
	if ( ! seen.ok ) throw new RefusedError( seen.wouldRefuse );
	const problem = slugProblem( slug );
	if ( problem ) throw new ReleaseError( 'bad-input', problem );
	const { master } = seen, info = seen.info;
	const frames = master.samples.length;

	let hasAudio = false;
	if ( seen.hasAudio && audio === 'keep' ) {

		const support = await deps.aacSupport();
		if ( ! support.ok ) throw new ReleaseError( 'bad-input', `The video has an audio track, and ${ support.reason } Drop the audio to package the picture alone.` );
		hasAudio = true;

	}

	let track = null;
	if ( captions ) {

		const read = await recordOfFile( 'captions.vtt', captions.text, { defaultLanguage: captions.language || 'en' } );
		if ( read.problems.length ) throw new ReleaseError( 'bad-input', `The captions file does not parse: ${ read.problems[ 0 ] }.` );
		if ( read.record.cue_count === 0 ) throw new ReleaseError( 'bad-input', 'The captions file has no cues.' );
		const record = { ...read.record, source: read.record.source || 'manual', language: captions.language || read.record.language };
		track = { path: 'captions.vtt', language: record.language, default: true, text: captions.text, record };

	}

	onProgress( 0.02, 'Checking the repository\u2026' );
	const plan = await planRelease( api, { repo, slug, branch } );

	const ladder = planLadder( { width: master.width, height: master.height, fps: master.fps, keep } );
	if ( ladder.length === 0 ) throw new ReleaseError( 'bad-input', 'Keep at least one rung of the ladder.' );
	const result = await deps.transcodeLadder( { master, ladder, onProgress, shouldCancel } );
	if ( ! result ) return null;

	let audioRendition = null;
	if ( hasAudio ) {

		const built = await deps.buildAudioRendition( { bytes: file.bytes, durationSeconds: frames / master.fps, videoStartsSeconds: result.rungs[ 0 ].packaged.segments.map( s => s.first / master.fps ), onProgress } );
		audioRendition = {
			packaged: built.packaged, name: 'Original', language: 'und', delaySamples: built.delaySamples,
			source: { path: file.name, sha256: 'sha256:' + await sha256Hex( file.bytes ) },
		};

	}

	const uploadHash = 'sha256:' + await sha256Hex( file.bytes );
	const encoder = { kind: 'hardware', name: `uploaded ${ info.codec } video (${ file.name })`, version: null, settings_hash: null, threads: null, config: null };
	let set = assemblePublishSet( {
		path: slug,
		scene: { repo, file: file.name, branch, commit: null, hash: uploadHash },
		render: { mode: 'offline', renderer: 'upload', device: 'webcodecs', encoder, fps: master.fps, frames, frameRange: [ 0, frames - 1 ], width: master.width, height: master.height, renderedAt: now().toISOString() },
		rungs: result.rungs, poster: result.poster, captionTracks: track ? [ track ] : [], audio: audioRendition,
		determinism: { mode: 'offline', encoder, hasEndCard: false, playbackWasRunning: false, verification: null },
		publication: { storage: 'renders-repo', repo, tag: plan.tag, canonical },
		audit: UPLOAD_AUDIT,
		audioAbsence: seen.hasAudio ? 'The audio track of the uploaded video was dropped at packaging.' : 'The uploaded video has no audio track. The master declares no audio group and no audio codec.',
	} );
	set = await addManifest( set, slug );
	const gate = gateRelease( { renderJson: set.renderJson, errors: set.errors, files: set.files } );
	onProgress( 1, gate.ok ? 'Ready to publish.' : 'Prepared, but a check failed.' );
	return { set, plan, gate, ladder, info, renderJson: set.renderJson, repo, branch, slug };

}

/** Concrete, before anything is sent: how many files, how many bytes, to which repository and tag. */
export function describePublish( prepared, { user = null } = {} ) {

	const { set, plan } = prepared;
	const bytes = set.files.reduce( ( n, f ) => n + f.bytes.length, 0 );
	return {
		files: set.files.length, bytes, size: formatBytes( bytes ), repo: plan.repo, branch: plan.branch, tag: plan.tag, version: plan.version, user, needsInit: plan.needsInit,
		text: `${ set.files.length } files, ${ formatBytes( bytes ) }, to github.com/${ plan.repo } (${ plan.branch }) as ${ plan.tag }${ user ? ', as @' + user : '' }`,
	};

}

/**
 * Commits the set as one commit and tags it. The tag is planned again first: if it exists by now nothing is written. The prepared set is not changed.
 * @returns the receipt: what was sent, where, when, the resulting commit and tag, and the hashes
 */
export async function publishPrepared( api, prepared, { onProgress = () => {}, now = () => new Date(), playerRoot = CANONICAL_ORIGIN + '/player/' } = {} ) {

	if ( ! prepared.gate.ok ) throw new ReleaseError( 'check-failed', 'REFUSED: ' + prepared.gate.failures[ 0 ] );
	const { set, plan: first, slug, repo, branch } = prepared;
	const plan = await planRelease( api, { repo, slug, branch, version: first.version } );
	const out = await commitRelease( api, plan, { files: set.files, message: `${ plan.tag }: Publish ${ prepared.renderJson.scene.file }, ${ prepared.renderJson.outputs.renditions.map( r => r.name ).join( ', ' ) }`, onProgress } );
	const pub = publicationOf( set.renderJson );
	const base = shareBase( pub ) || out.base;
	const manifest = set.files.find( f => f.path === `${ slug }/files.sha256` );
	return {
		at: now().toISOString(), repo, branch, tag: out.tag, commit: out.commit.sha, base, pinned: releaseBase( { repo, tag: out.tag, slug } ), player: playerLink( playerRoot, base ),
		files: set.files.length, bytes: set.files.reduce( ( n, f ) => n + f.bytes.length, 0 ), files_sha256: 'sha256:' + await sha256Hex( manifest.bytes ),
	};

}

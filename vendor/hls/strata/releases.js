// Releases: where a published render lives, what its address is, whether it is stale, whether it can be verified. Pure logic and one orchestration over an injected
// GitHub `api`, so all of it is tested in node against a fake GitHub (export/__tests__/releases.test.mjs). The UI (ReleasesPanel.js, PublishPanel.js) is a thin wrapper.
//
// The decisions (guides/PUBLISH.md, "Where renders live"):
//   - Renders live in a SEPARATE repository (default <owner>/renders), one folder per scene, so the scene repo stays small and clonable.
//     jsDelivr's gh/ endpoint serves the git tree and NOT release assets (checked with curl: a real release asset gives 404 there), so a tagged tree it is.
//   - A release is a tag `<slug>/v<N>`. Tags are created, never moved or deleted by this code; a re-render is v<N+1>.
//   - Every address this module produces is pinned (a tag or a commit sha). There is no function here that returns @latest or a branch.
//   - Renders already published into the scene repo (renders/<slug>/) keep working untouched; they are `storage: source-repo` and pinned by commit sha.
//   - The address a render is SHARED at names no provider: https://strataeditor.dev/video/<slug>/v<N>/ (guides/CDN_INDEPENDENCE.md). The renders repository stays the
//     source of truth; where the bytes are served from is a routing rule, and every other place that holds them is listed in `publication.mirrors`.

import { diffHashes, frameRanges, parseSidecar } from './frameHashes.js';
import { validateRenderJson } from './renderJson.js';

export const RENDERS_REPO_NAME = 'renders';
export const CDN = 'https://cdn.jsdelivr.net/gh';
export const CANONICAL_ORIGIN = 'https://strataeditor.dev';
export const CANONICAL_PREFIX = '/video/';
export const ARCHIVE_ORIGIN = 'https://archive.org/download';
/**
 * What is live today. The ONE place to change when routing or the archive go live (guides/CDN_INDEPENDENCE.md): every publication records the canonical address either
 * way, so flipping a switch edits no published artifact and no page; it changes which address the editor hands out and which mirrors a new publication claims.
 *   canonicalLive: https://strataeditor.dev/video/ is routed to storage. Off: share links use the first mirror (jsDelivr), and the canonical address is only recorded.
 *   archive:       the Internet Archive upload exists. Off: a new publication does not list an archive mirror it does not have.
 */
export const DELIVERY = { canonicalLive: false, archive: false };

/** The limits this deployment was designed under, recorded in every publication so a ladder's shape is a decision on file and not a fact about HLS. */
export const DEPLOY_CONSTRAINTS = Object.freeze( { max_file_bytes: 20 * 1024 * 1024, target_segment_s: 6 } );
export const STORAGE = Object.freeze( { renders: 'renders-repo', source: 'source-repo' } );

export class ReleaseError extends Error {

	/** code: 'tag-exists' | 'not-separate' | 'check-failed' | 'branch-moved' | 'no-token' | 'truncated' | 'bad-input' */
	constructor( code, message, detail = null ) {

		super( message );
		this.name = 'ReleaseError';
		this.code = code;
		this.detail = detail;

	}

}

// ── names ───────────────────────────────────────────────────────────────────

/** The scene's slug, the folder and tag namespace of its renders: "a+b-cubed.json" -> "a+b-cubed". Same rule as defaultPublishPath. */
export function sceneSlug( sceneFile ) {

	const base = String( sceneFile || 'scene.json' ).split( '/' ).pop().replace( /\.[^./]+$/, '' ) || 'scene';
	return base.replace( /[^A-Za-z0-9._+-]+/g, '-' );

}

/**
 * The naming convention for a render (guides/PUBLISH.md): the name is the scene file's stem, lowercase, with words joined by "-" (and "+" where a name has one, as
 * in a+b-cubed), and it names the CONTENT. It is the folder in the renders repository, the tag namespace and the path /video/<name>/v<N>/, so there is one spelling.
 * A word for the category (short, video, ...) is refused because the second render of that category would collide with the first.
 */
export const SLUG_RULE = /^[a-z0-9]+(?:[+-][a-z0-9]+)*$/;
export const CATEGORY_WORDS = Object.freeze( [ 'short', 'shorts', 'video', 'videos', 'render', 'renders', 'film', 'clip', 'movie', 'scene', 'test', 'tmp', 'temp', 'draft', 'untitled', 'new', 'final' ] );

/** null when `slug` is a valid render name, else what is wrong and how to fix it. */
export function slugProblem( slug ) {

	const s = String( slug );
	if ( ! SLUG_RULE.test( s ) ) return `"${ s }" is not a valid render name: use lowercase letters and digits joined by "-" (a "+" is allowed between words). The name is the scene file's stem, so rename the scene file (for example "${ s.toLowerCase().replace( /[^a-z0-9+]+/g, '-' ).replace( /^-+|-+$/g, '' ) || 'bus-stop' }.json").`;
	if ( CATEGORY_WORDS.includes( s ) ) return `"${ s }" names a category, not the content, so the next ${ s } would collide with this one at /video/${ s }/v<N>/. Name the scene for what it shows (for example "bus-stop") and rename the scene file to match.`;
	return null;

}

export const tagFor = ( slug, version ) => `${ slug }/v${ version }`;

/** "a+b-cubed/v3" -> { slug, version: 3 }, or null when it is not a release tag (of `slug` when given). */
export function parseTag( tag, slug = null ) {

	const m = /^(.+)\/v([1-9]\d*)$/.exec( String( tag ) );
	if ( ! m || ( slug !== null && m[ 1 ] !== slug ) ) return null;
	return { slug: m[ 1 ], version: Number( m[ 2 ] ) };

}

/** The next version of a scene's renders given every tag name that exists: one more than the highest vN of this slug, 1 for the first. */
export function nextVersion( tags, slug ) {

	let max = 0;
	for ( const t of tags ) { const p = parseTag( t, slug ); if ( p && p.version > max ) max = p.version; }
	return max + 1;

}

/** Release tags of a slug, newest version first. */
export function releaseTags( tags, slug ) {

	return tags.map( t => parseTag( t, slug ) ).filter( Boolean ).sort( ( a, b ) => b.version - a.version ).map( p => tagFor( p.slug, p.version ) );

}

// ── addresses (all pinned) ──────────────────────────────────────────────────

const HEX_SHA = /^[0-9a-f]{7,40}$/;

/** A ref that names one immutable thing: a release tag (<slug>/vN) or a commit sha. Not a branch, not "latest". */
export function isPinnedRef( ref ) {

	return HEX_SHA.test( String( ref ) ) || parseTag( ref ) !== null;

}

/** https://cdn.jsdelivr.net/gh/<repo>@<ref>/<path>. Refuses a ref that is not pinned: nothing in the share path can hand out @latest or a branch. */
export function pinnedUrl( { repo, ref, path = '' } ) {

	if ( ! isPinnedRef( ref ) ) throw new ReleaseError( 'bad-input', `"${ ref }" is not a tag or a commit: a share link must be pinned.` );
	return `${ CDN }/${ repo }@${ ref }/${ String( path ).replace( /^\/+/, '' ) }`;

}

/** The folder of a release, with a trailing slash: the base the player is given. */
export const releaseBase = ( { repo, tag, slug } ) => pinnedUrl( { repo, ref: tag, path: slug + '/' } );

/** The address a release is shared at, with a trailing slash. The path is the tag, so it is pinned by construction: a tag never moves. */
export const canonicalBase = ( { tag, origin = CANONICAL_ORIGIN } ) => `${ origin }${ CANONICAL_PREFIX }${ tag }/`;

/** The Internet Archive item a release is deposited as: letters, digits, "_", "-" and "." only ("a+b-cubed/v1" -> "strata-a-b-cubed-v1"). */
export const archiveItem = tag => 'strata-' + String( tag ).replace( /\/v(?=\d+$)/, '-v' ).replace( /[^A-Za-z0-9._-]+/g, '-' );

export const archiveBase = tag => `${ ARCHIVE_ORIGIN }/${ archiveItem( tag ) }/`;

/** True for an address that names one immutable folder: a jsDelivr-style @<tag or sha>/ address, or a canonical /video/<slug>/v<N>/ one. */
export function isPinnedBase( base ) {

	return /@(?:[0-9a-f]{7,40}|.+\/v[1-9]\d*)\//.test( base ) || /^https:\/\/[^/]+\/video\/.+\/v[1-9]\d*\/$/.test( base );

}

/** The player link for a pinned base. `playerRoot` is the player page's address (docs/player/), `cue` an optional authored cue id. */
export function playerLink( playerRoot, base, { cue = null } = {} ) {

	if ( ! isPinnedBase( base ) ) throw new ReleaseError( 'bad-input', 'The player link must point at a pinned base.' );
	return `${ playerRoot }#${ base }${ cue ? '&cue=' + encodeURIComponent( cue ) : '' }`;

}

/** Where a release's files are: the tag of a renders-repo render, or the commit a legacy render was found at. */
export function locationOf( pub, { commit = null } = {} ) {

	if ( pub.canonical ) return { ref: pub.tag, base: shareBase( pub ) };
	if ( pub.storage === STORAGE.renders ) return { ref: pub.tag, base: releaseBase( { repo: pub.repo, tag: pub.tag, slug: pub.path } ) };
	if ( ! commit ) return { ref: null, base: null };
	return { ref: commit, base: pinnedUrl( { repo: pub.repo, ref: commit, path: pub.path + '/' } ) };

}

// ── render.json's `publication` ─────────────────────────────────────────────

/**
 * Where a render lives, recorded in render.json. Two shapes, and a render.json carries one of them:
 *
 * v2 (a renders-repo render, canonical on, the default): nothing durable names a provider.
 *   { canonical: 'https://strataeditor.dev/video/<slug>/v<N>/',         the address it is shared at; the first place a player looks
 *     source:    { repo, tag, path },                                  the source of truth: the folder <path>/ of <repo> at <tag>
 *     mirrors:   [ <folder URL>, ... ],                                 every other place that holds the same bytes, in the order to try them
 *     target:    'generic',                                            what the ladder was shaped for
 *     constraints: { max_file_bytes, target_segment_s },               the limits that shaped it: a deployment decision on file, so it is not mistaken for a fact about HLS
 *     size_bytes }                                                      every file of the folder except render.json and files.sha256
 * legacy (published before this, and still served where it is): { storage, repo, path, tag, url, size_bytes }; `url` is the pinned jsDelivr folder, which publicationOf
 * lists as the one mirror so a manifest is honest about where the bytes are. A legacy render is migrated only when it is re-rendered.
 */
export function publicationBlock( { storage, repo, path, tag = null, sizeBytes = null, canonical = true, mirrors = null, archive = DELIVERY.archive } ) {

	if ( canonical && storage === STORAGE.renders && tag ) {

		return {
			canonical: canonicalBase( { tag } ),
			source: { repo, tag, path },
			mirrors: mirrors || [ releaseBase( { repo, tag, slug: path } ), ...( archive ? [ archiveBase( tag ) ] : [] ) ],
			target: 'generic',
			constraints: { ...DEPLOY_CONSTRAINTS },
			size_bytes: sizeBytes,
		};

	}
	const url = storage === STORAGE.renders && tag ? releaseBase( { repo, tag, slug: path } ) : null;
	return { storage, repo, path, tag, url, size_bytes: sizeBytes };

}

const isFolderUrl = u => typeof u === 'string' && /^https:\/\/[^/\s]+\/\S*\/$/.test( u );

function validatePublicationV2( p ) {

	const e = [];
	const need = ( c, m ) => { if ( ! c ) e.push( m ); };
	const src = p.source;
	need( src && typeof src === 'object', 'publication.source must be { repo, tag, path }' );
	if ( src && typeof src === 'object' ) {

		need( /^[^/\s]+\/[^/\s]+$/.test( src.repo || '' ), 'publication.source.repo must be owner/name' );
		need( typeof src.path === 'string' && src.path.length > 0, 'publication.source.path is required' );
		need( parseTag( src.tag, src.path ) !== null, 'publication.source.tag must be <path>/v<N>' );
		need( isFolderUrl( p.canonical ) && p.canonical.endsWith( `/video/${ src.tag }/` ), 'publication.canonical must be an https folder URL ending /video/<source.tag>/' );

	}
	need( Array.isArray( p.mirrors ), 'publication.mirrors must be an array' );
	if ( Array.isArray( p.mirrors ) ) {

		need( p.mirrors.every( isFolderUrl ), 'every publication.mirrors entry must be an https folder URL ending in /' );
		need( new Set( p.mirrors ).size === p.mirrors.length && ! p.mirrors.includes( p.canonical ), 'publication.mirrors must not repeat itself or the canonical address' );

	}
	need( typeof p.target === 'string' && p.target.length > 0, 'publication.target is required' );
	const c = p.constraints;
	need( c && Number.isInteger( c.max_file_bytes ) && c.max_file_bytes > 0 && typeof c.target_segment_s === 'number' && c.target_segment_s > 0, 'publication.constraints must be { max_file_bytes, target_segment_s }' );
	need( p.size_bytes === null || ( Number.isInteger( p.size_bytes ) && p.size_bytes >= 0 ), 'publication.size_bytes must be a non-negative integer or null' );
	return e;

}

/** [] when `p` is a valid publication block (render.json without one is a legacy source-repo render and is valid). */
export function validatePublication( p ) {

	if ( p === undefined ) return [];
	const e = [];
	const need = ( c, m ) => { if ( ! c ) e.push( m ); };
	if ( ! p || typeof p !== 'object' ) return [ 'publication must be an object' ];
	if ( 'canonical' in p || 'source' in p ) return validatePublicationV2( p );
	need( p.storage === STORAGE.renders || p.storage === STORAGE.source, 'publication.storage must be renders-repo or source-repo' );
	need( /^[^/\s]+\/[^/\s]+$/.test( p.repo || '' ), 'publication.repo must be owner/name' );
	need( typeof p.path === 'string' && p.path.length > 0, 'publication.path is required' );
	if ( p.storage === STORAGE.renders ) {

		const t = parseTag( p.tag, p.path );
		need( t !== null, 'publication.tag must be <path>/v<N> for a renders-repo render' );
		need( typeof p.url === 'string' && p.url.includes( '@' + p.tag + '/' ), 'publication.url must be pinned to publication.tag' );

	} else {

		need( p.tag === null && p.url === null, 'a source-repo render has no tag and no stored url (it is pinned by commit)' );

	}
	need( p.size_bytes === null || ( Number.isInteger( p.size_bytes ) && p.size_bytes >= 0 ), 'publication.size_bytes must be a non-negative integer or null' );
	return e;

}

/**
 * What a render.json says about where it lives, either shape normalised to one: { storage, repo, path, tag, canonical, mirrors, url, size_bytes, inferred }.
 * `canonical` is null for a render published before the canonical address existed; its one pinned location is then listed in `mirrors` and `url`.
 */
export function publicationOf( renderJson, { repo = null, path = null } = {} ) {

	const p = renderJson && renderJson.publication;
	if ( p && p.source ) {

		return { storage: STORAGE.renders, repo: p.source.repo, path: p.source.path, tag: p.source.tag, canonical: p.canonical, mirrors: p.mirrors || [], url: p.canonical, target: p.target, constraints: p.constraints, size_bytes: p.size_bytes, inferred: false };

	}
	if ( p ) return { ...p, canonical: null, mirrors: p.url ? [ p.url ] : [], inferred: false };
	return { storage: STORAGE.source, repo: repo || ( renderJson && renderJson.scene && renderJson.scene.repo ), path, tag: null, url: null, canonical: null, mirrors: [], size_bytes: null, inferred: true };

}

/**
 * The folder a release is SHARED at: the canonical address once it is routed (DELIVERY.canonicalLive), until then the render's first mirror. `pub` is publicationOf()'s
 * result. Returns null when there is nowhere to point (a legacy render found without a commit).
 */
export function shareBase( pub, { delivery = DELIVERY } = {} ) {

	if ( delivery.canonicalLive && pub.canonical ) return pub.canonical;
	return pub.mirrors && pub.mirrors[ 0 ] ? pub.mirrors[ 0 ] : pub.canonical || null;

}

// ── the gate (R6) ───────────────────────────────────────────────────────────

/**
 * A publish is refused, not warned about, when anything is wrong: a size error, a render.json that does not validate, or a manifest check that is false.
 * Returns { ok, failures: string[] }.
 */
export function gateRelease( { renderJson, errors = [], files = null } ) {

	const failures = [ ...errors ];
	for ( const p of validateRenderJson( renderJson ) ) failures.push( 'render.json: ' + p );
	for ( const p of validatePublication( renderJson && renderJson.publication ) ) failures.push( 'render.json: ' + p );
	const checks = ( renderJson && renderJson.checks ) || {};
	const text = {
		segments_under_20mb: 'a segment is 20 MB or more (over publication.constraints.max_file_bytes; a mirror such as jsDelivr will not serve it)',
		files_under_100mb: 'a file is 100 MB or more (GitHub refuses it)',
		frame_count_matches_duration: 'the frame count does not match the duration',
		audio_duration_matches_video: 'the narration audio is not the same length as the video',
		encoder_recorded_per_rendition: 'a rendition has no recorded encoder, or the recorded settings are not the ones that produced it',
		master_matches_audio: 'the master playlist disagrees with whether the render has audio (an audio group, or an mp4a codec, that is not there, or one that is missing)',
	};
	for ( const [ k, v ] of Object.entries( checks ) ) if ( v !== true ) failures.push( `check failed: ${ text[ k ] || k }` );
	// a render.json that declares a manifest is refused when the set does not hold it: a mirror could not be checked against it
	const manifest = renderJson && renderJson.outputs && renderJson.outputs.manifest;
	if ( manifest && files && ! files.some( f => f.path.endsWith( '/' + manifest.path ) ) ) failures.push( `${ manifest.path } is declared by render.json and missing from the set` );
	return { ok: failures.length === 0, failures };

}

// ── staleness (D) ───────────────────────────────────────────────────────────

/**
 * current / behind / none, exactly as with captions.
 *   published:    whether any render is published for this scene
 *   sourceCommit: the commit the latest render records (render.json scene.commit), or null
 *   headCommit:   the scene branch's current commit
 *   compare:      GitHub's compare of sourceCommit...headCommit: { status, ahead_by, commits: [{ sha }] }  (null when sourceCommit is null or the call failed)
 *   touching:     shas of the commits (newest first) that changed the scene file on that branch
 * "behind" counts the commits that CHANGED THE SCENE FILE since the render, which is what "four commits behind its scene" means; commits that touch other files are
 * reported in `otherCommits` and do not make a render stale. When the render's commit is not an ancestor of the branch (history was rewritten) the render is behind by an unknown amount.
 * @returns {{ state: 'current'|'behind'|'none', behind: number|null, atLeast: boolean, otherCommits: number, exact: boolean, reason: string }}
 */
export function assessStaleness( { published, sourceCommit, headCommit, compare = null, touching = [] } ) {

	const out = ( state, behind, reason, extra = {} ) => ( { state, behind, atLeast: false, otherCommits: 0, exact: true, reason, ...extra } );
	if ( ! published ) return out( 'none', null, 'No render is published for this scene.' );
	if ( ! sourceCommit ) return out( 'behind', null, 'This render does not record the commit it was made from, so it cannot be compared with the scene.', { exact: false } );
	if ( ! headCommit ) return out( 'current', null, 'The scene\u2019s current commit is unknown, so it cannot be compared.', { exact: false } );
	const same = ( a, b ) => a.startsWith( b ) || b.startsWith( a );
	if ( same( sourceCommit, headCommit ) ) return out( 'current', 0, 'The render was made from the scene\u2019s current commit.' );
	if ( ! compare ) return out( 'behind', null, 'The scene has moved on from the render\u2019s commit (the comparison could not be fetched).', { exact: false } );
	if ( compare.status === 'identical' ) return out( 'current', 0, 'The render was made from the scene\u2019s current commit.' );
	if ( compare.status !== 'ahead' ) return out( 'behind', null, 'The render\u2019s commit is not part of the scene branch\u2019s history (it was rewritten, or the render came from another branch).', { exact: false } );

	const commits = compare.commits || [];
	const complete = commits.length >= compare.ahead_by;
	const touch = new Set( touching );
	const since = commits.filter( c => touch.has( c.sha ) ).length;
	const others = Math.max( 0, compare.ahead_by - since );
	if ( since === 0 && complete ) return out( 'current', 0, `${ compare.ahead_by } newer commit${ compare.ahead_by === 1 ? '' : 's' }, none of which change this scene.`, { otherCommits: others } );
	return out( 'behind', since, `${ since }${ complete ? '' : '+' } commit${ since === 1 ? '' : 's' } changed this scene since the render${ others ? ` (and ${ others } more commit${ others === 1 ? ' that does' : 's that do' } not touch it)` : '' }.`, { atLeast: ! complete, otherCommits: others } );

}

// ── verify (F) ──────────────────────────────────────────────────────────────

/**
 * Can this published render be rebuilt and checked? The honest answer comes first, from the manifest alone.
 * @returns {{ can: boolean, why: string[], settings?: object }}   `why` lists what blocks it; `settings` is what the re-render must use
 */
export function verifyPlan( renderJson ) {

	const why = [];
	const r = renderJson && renderJson.render;
	if ( ! r ) return { can: false, why: [ 'There is no render.json to verify against.' ] };
	const d = r.determinism || {};
	if ( ! d.frames ) why.push( 'The render declared its frames non-deterministic' + ( d.reasons && d.reasons.frames && d.reasons.frames.length ? ' (' + d.reasons.frames.join( '; ' ) + ')' : '' ) + ', so a rebuild would not be expected to match.' );
	if ( r.mode !== 'offline' ) why.push( 'It was a realtime capture; only offline renders are rebuilt frame by frame.' );
	const fh = renderJson.outputs && renderJson.outputs.frame_hashes;
	if ( ! fh ) why.push( 'It publishes no per-frame hashes to compare against.' );
	const s = renderJson.scene || {};
	if ( ! s.commit ) why.push( 'It does not record the scene commit it was made from.' );
	if ( ! /^sha256:[0-9a-f]{64}$/.test( s.hash || '' ) ) why.push( 'It does not record the scene\u2019s hash.' );
	if ( why.length ) return { can: false, why };
	return {
		can: true, why: [],
		settings: { repo: s.repo, file: s.file, commit: s.commit, sceneHash: s.hash, fps: r.fps, width: r.width, height: r.height, range: r.frame_range, encoder: r.encoder && r.encoder.kind, sidecar: fh.path, frames: fh.count, root: fh.root, device: r.device, renderer: r.renderer },
	};

}

/**
 * The verdict of a rebuild: 'match', 'differs' (with the frames), or 'cannot-verify' (with why). The wording stays within what was shown:
 * frames are promised per device, so a match on another machine than the render's is a match of these frames, and a difference there may be the device.
 * @param published  the published sidecar text; rebuilt  { first, hashes } from this machine's render; sameDevice  boolean | null
 */
export function verifyOutcome( { plan, published, rebuilt, sameDevice = null } ) {

	if ( ! plan.can ) return { result: 'cannot-verify', why: plan.why, summary: 'Cannot verify: ' + plan.why[ 0 ] };
	const a = parseSidecar( published );
	if ( a.error ) return { result: 'cannot-verify', why: [ 'The published frame-hashes.txt is unreadable: ' + a.error ], summary: 'Cannot verify: the published frame hashes are unreadable.' };
	if ( ! rebuilt || ! rebuilt.hashes || ! rebuilt.hashes.length ) return { result: 'cannot-verify', why: [ 'No frames were rebuilt.' ], summary: 'Cannot verify: nothing was rebuilt.' };
	const d = diffHashes( a, rebuilt );
	const missing = d.onlyIn.a.length + d.onlyIn.b.length;
	if ( d.frames.length === 0 && missing === 0 ) {

		return { result: 'match', frames: a.hashes.length, summary: `Match: all ${ a.hashes.length } frames rebuilt from the recorded scene are identical to the published ones.` + ( sameDevice === false ? ' (A different device from the original render\u2019s: the match holds for these frames.)' : '' ) };

	}
	const bad = [ ...d.frames, ...d.onlyIn.a, ...d.onlyIn.b ].sort( ( x, y ) => x - y );
	return {
		result: 'differs', frames: bad,
		summary: `Differs at frames [${ frameRanges( bad ) }] (${ bad.length } of ${ a.hashes.length }).` + ( sameDevice !== true ? ' Frames are only promised identical on the device the render was made on, and this one is ' + ( sameDevice === false ? 'a different device' : 'not known to be the same device' ) + ', so the difference may be the device and not the scene.' : '' ),
	};

}

// ── the list ────────────────────────────────────────────────────────────────

/** What the Releases list shows for one published render.json. `ref` is its tag (or commit) and `base` its pinned folder. */
export function releaseSummary( renderJson, { ref, base, repo, date = null } ) {

	const r = renderJson.render, o = renderJson.outputs, s = renderJson.scene;
	const pub = publicationOf( renderJson, { repo } );
	return {
		ref, base, mirrors: pub.mirrors.filter( m => m !== base ), canonical: pub.canonical, storage: pub.storage, tag: pub.tag, repo: pub.repo, date: date || r.rendered_at,
		durationS: r.duration_s, fps: r.fps, width: r.width, height: r.height,
		ladder: ( o.renditions || [] ).map( x => x.name ),
		sizeBytes: pub.size_bytes,
		sourceRepo: s.repo, sourceCommit: s.commit, sourceFile: s.file,
		sourceUrl: s.commit ? `https://github.com/${ s.repo }/commit/${ s.commit }` : null,
		// version 1 (published before frames and bytes were separate) carried one boolean, which claimed both
		frames: r.determinism ? r.determinism.frames : !! r.deterministic, bytes: r.determinism ? r.determinism.bytes : !! r.deterministic,
		legacyFormat: ! r.determinism,
		links: {
			renderJson: base + 'render.json', poster: base + o.poster,
			captions: ( o.caption_tracks || ( o.captions ? [ { language: 'en', source: null, path: o.captions } ] : [] ) ).map( t => ( { language: t.language, source: t.source, url: base + t.path } ) ),
		},
	};

}

// ── publishing, over an injected GitHub ─────────────────────────────────────
// api.get( path ) -> json (throws an Error with .status), api.send( method, path, body ) -> json (throws with .status).

const encPath = p => String( p ).split( '/' ).map( encodeURIComponent ).join( '/' );
const status = e => ( e && ( e.status || ( /GitHub (\d+)/.exec( e.message || '' ) || [] )[ 1 ] ) ) | 0;
const bad = ( e, ...codes ) => codes.includes( status( e ) );

/**
 * Everything to know before committing: the repository, the version this will be, and that the tag is free. Writes nothing.
 * @returns {{ repo, branch, slug, version, tag, needsInit, base }}
 */
export async function planRelease( api, { repo, slug, branch = 'main', sceneRepo = null, allowSceneRepo = false, version = null } ) {

	if ( ! /^[^/\s]+\/[^/\s]+$/.test( repo || '' ) ) throw new ReleaseError( 'bad-input', 'The renders repository must be owner/name.' );
	if ( sceneRepo && repo.toLowerCase() === sceneRepo.toLowerCase() && ! allowSceneRepo ) {

		throw new ReleaseError( 'not-separate', `${ repo } is the scene repository. Renders go in a separate repository (default ${ repo.split( '/' )[ 0 ] }/${ RENDERS_REPO_NAME }) so the scene repo stays small; publish there, or opt in explicitly to the legacy layout.` );

	}
	const problem = slugProblem( slug );
	if ( problem ) throw new ReleaseError( 'bad-input', problem );
	let refs = [];
	try { refs = await api.get( `/repos/${ repo }/git/matching-refs/tags/${ encPath( slug ) }/` ); } catch ( e ) { if ( ! bad( e, 409 ) ) throw e; }     // 409: an empty repository has no refs yet
	const names = ( Array.isArray( refs ) ? refs : [] ).map( r => String( r.ref ).replace( /^refs\/tags\//, '' ) );
	const v = version === null ? nextVersion( names, slug ) : version;
	const tag = tagFor( slug, v );
	if ( names.includes( tag ) ) throw new ReleaseError( 'tag-exists', `${ tag } is already published. A published tag never moves; a re-render is v${ nextVersion( names, slug ) }.`, { tag } );

	let needsInit = false;
	try { await api.get( `/repos/${ repo }/git/ref/heads/${ encPath( branch ) }` ); } catch ( e ) {

		if ( bad( e, 404, 409 ) ) needsInit = true; else throw e;

	}
	return { repo, branch, slug, version: v, tag, needsInit, base: releaseBase( { repo, tag, slug } ), existingTags: names };

}

const README = repo => `# ${ repo.split( '/' )[ 1 ] }\n\nPublished renders (HLS ladders) made by the Strata editor, one folder per scene, one tag per release: \`<scene>/v<N>\`.\nTags are never moved. Scenes live in their own repositories; each render's \`render.json\` records the repository and commit it was made from.\n`;

/**
 * Commits `files` (paths already prefixed with the slug) as the new contents of <slug>/ on `branch`, then creates the tag on that commit.
 * Files of the slug that the new set does not have are deleted in the same commit (a re-render with fewer rungs leaves nothing stale behind),
 * but nothing outside <slug>/ is touched. The tag is only ever created: if it exists, GitHub answers 422 and this refuses. The branch moves fast-forward only.
 * @returns {{ commit, tag, base, repo, branch }}
 */
export async function commitRelease( api, plan, { files, message, onProgress = () => {} } ) {

	const { repo, branch, slug, tag } = plan;
	if ( ! files.length ) throw new ReleaseError( 'bad-input', 'Nothing to publish.' );
	for ( const f of files ) if ( ! f.path.startsWith( slug + '/' ) ) throw new ReleaseError( 'bad-input', `${ f.path } is outside ${ slug }/.` );
	const R = `/repos/${ repo }`;

	if ( plan.needsInit ) {

		onProgress( 0, 'Initialising the renders repository\u2026' );
		await api.send( 'PUT', `${ R }/contents/README.md`, { message: 'Initialise renders repository', content: btoa( README( repo ) ), branch } );

	}

	const head = await api.get( `${ R }/git/ref/heads/${ encPath( branch ) }` );
	const headSha = head.object.sha;
	const headCommit = await api.get( `${ R }/git/commits/${ headSha }` );

	// the slug's folder as it is now, to delete what the new set no longer has
	let old = [];
	try {

		const sub = await api.get( `${ R }/git/trees/${ headCommit.tree.sha }:${ encPath( slug ) }?recursive=1` );
		if ( sub.truncated ) throw new ReleaseError( 'truncated', `${ slug }/ is too large for GitHub to list in one call, so stale files cannot be removed safely.` );
		old = ( sub.tree || [] ).filter( t => t.type === 'blob' ).map( t => slug + '/' + t.path );

	} catch ( e ) { if ( e instanceof ReleaseError ) throw e; if ( ! bad( e, 404 ) ) throw e; }

	const items = [];
	let done = 0;
	for ( const f of files ) {

		const blob = await api.send( 'POST', `${ R }/git/blobs`, { content: toBase64( f.bytes ), encoding: 'base64' } );
		items.push( { path: f.path, mode: '100644', type: 'blob', sha: blob.sha } );
		onProgress( ++ done / files.length, `Uploading ${ done }/${ files.length }\u2026` );

	}
	const keep = new Set( files.map( f => f.path ) );
	for ( const p of old ) if ( ! keep.has( p ) ) items.push( { path: p, mode: '100644', type: 'blob', sha: null } );

	const tree = await api.send( 'POST', `${ R }/git/trees`, { base_tree: headCommit.tree.sha, tree: items } );
	const commit = await api.send( 'POST', `${ R }/git/commits`, { message: message || `Publish ${ tag }`, tree: tree.sha, parents: [ headSha ] } );
	try { await api.send( 'PATCH', `${ R }/git/refs/heads/${ encPath( branch ) }`, { sha: commit.sha } ); } catch ( e ) {

		if ( bad( e, 422 ) ) throw new ReleaseError( 'branch-moved', `${ branch } moved while publishing, so nothing was published. Run it again.` );
		throw e;

	}
	try { await api.send( 'POST', `${ R }/git/refs`, { ref: `refs/tags/${ tag }`, sha: commit.sha } ); } catch ( e ) {

		if ( bad( e, 422 ) ) throw new ReleaseError( 'tag-exists', `${ tag } already exists (published meanwhile); it was not moved.`, { tag, commit: commit.sha } );
		throw e;

	}
	onProgress( 1, `\u2713 Published ${ tag }` );
	return { commit, tag, base: plan.base, repo, branch };

}

function toBase64( bytes ) {

	let s = '';
	for ( let i = 0; i < bytes.length; i += 0x8000 ) s += String.fromCharCode.apply( null, bytes.subarray( i, i + 0x8000 ) );
	return btoa( s );

}

/** Tags of a slug in a renders repo, with the commit each points at: [{ tag, version, sha }] newest first. */
export async function listReleaseTags( api, { repo, slug } ) {

	const refs = await api.get( `/repos/${ repo }/git/matching-refs/tags/${ encPath( slug ) }/` );
	return ( Array.isArray( refs ) ? refs : [] ).map( r => ( { tag: String( r.ref ).replace( /^refs\/tags\//, '' ), sha: r.object && r.object.sha } ) )
		.map( x => ( { ...x, p: parseTag( x.tag, slug ) } ) ).filter( x => x.p ).sort( ( a, b ) => b.p.version - a.p.version )
		.map( x => ( { tag: x.tag, version: x.p.version, sha: x.sha } ) );

}

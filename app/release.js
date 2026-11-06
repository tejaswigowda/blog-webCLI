// Creating a video release from the blog app: tag a folder that is already in the video repository,
// or upload a finished HLS render (a folder of playlists and segments) and tag that. The app does
// not transcode: a render comes from hls.webcli.app or ffmpeg. A release is one commit and one tag
// <name>/v<N>; a published tag never moves, so the next change is the next version.
import { parseRepoRef } from '../lib/reporef.js';
import { Refusal } from '../lib/errors.js';
import { checkRelease, nextVersion, releaseFolders, releaseTag, versionsOf } from '../lib/release.js';
import { gitBlobSha } from './github.js';
import { fmtBytes } from './net.js';

async function context(gh, where) {
  const { repo, folder } = parseRepoRef(where);
  const info = await gh.repoInfo(repo);
  const branch = info.default_branch;
  const head = await gh.headCommit(repo, branch);
  const tree = await gh.tree(repo, head.treeSha);
  return { repo, folder, branch, head, tree, prefix: folder ? `${folder}/` : '', canPush: !!(info.permissions && info.permissions.push) };
}

const under = (tree, dir) => [...tree].filter(([p]) => p.startsWith(dir));
const needWrite = (c) => {
  if (!c.canPush) throw new Error(`You do not have write access to ${c.repo}; a release is a commit and a tag there.`);
};

// Per video repository: the folders that look like a render (they hold master.m3u8), and whether
// each is already released as it stands. Never throws for one repository: its error is returned.
export async function listReleaseFolders(gh, blog, { compare = true } = {}) {
  const out = [];
  for (const [key, where] of Object.entries((blog.video && blog.video.repos) || {})) {
    try {
      const c = await context(gh, where);
      const tags = await gh.tags(c.repo);
      const folders = [];
      for (const name of releaseFolders(c.tree, c.prefix)) {
        const dir = `${c.prefix}${name}/`;
        const mine = under(c.tree, dir);
        const versions = versionsOf(tags, name);
        const latest = versions.length ? versions[versions.length - 1] : 0;
        let state = latest ? 'unknown' : 'new';
        if (latest && compare) {
          try {
            const then = under(await gh.tree(c.repo, await gh.tagTreeSha(c.repo, releaseTag(name, latest))), dir);
            state = then.length === mine.length && then.every(([p, sha]) => c.tree.get(p) === sha) ? 'released' : 'changed';
          } catch {
            state = 'unknown'; // a repository too large to compare is not a reason to refuse
          }
        }
        folders.push({ name, files: mine.length, latest, next: latest + 1, state });
      }
      out.push({ key, where, repo: c.repo, folder: c.folder, branch: c.branch, canPush: c.canPush, folders });
    } catch (e) {
      out.push({ key, where, error: e.message || String(e), folders: [] });
    }
  }
  return out;
}

// The video repositories and whether each can be written, without scanning their contents:
// enough for an upload, which names its own folder.
export async function videoRepositories(gh, blog) {
  const out = [];
  for (const [key, where] of Object.entries((blog.video && blog.video.repos) || {})) {
    try {
      const { repo, folder } = parseRepoRef(where);
      const info = await gh.repoInfo(repo);
      out.push({ key, where, repo, folder, branch: info.default_branch, canPush: !!(info.permissions && info.permissions.push), folders: [] });
    } catch (e) {
      out.push({ key, where, error: e.message || String(e), folders: [] });
    }
  }
  return out;
}

// Tag a folder that is already in the repository, at the commit it is in now.
export async function planTagRelease(gh, { where, name }) {
  const c = await context(gh, where);
  needWrite(c);
  const dir = `${c.prefix}${name}/`;
  if (!c.tree.has(`${dir}master.m3u8`)) throw new Refusal('bad-release', `${dir} has no master.m3u8, so it is not a release folder`);
  const tags = await gh.tags(c.repo);
  const version = nextVersion(tags, name);
  return { kind: 'tag', repo: c.repo, folder: c.folder, branch: c.branch, head: c.head, name, version, tag: releaseTag(name, version), dir, files: under(c.tree, dir).length, bytes: 0, changes: [] };
}

// Upload a finished render into <video folder>/<name>/, replacing what is there, and tag it.
export async function planUploadRelease(gh, { where, name, files }) {
  const { files: checked, bytes } = checkRelease(name, files);
  const c = await context(gh, where);
  needWrite(c);
  const dir = `${c.prefix}${name}/`;
  const tags = await gh.tags(c.repo);
  const version = nextVersion(tags, name);
  const changes = [];
  const keep = new Set();
  for (const f of checked) {
    const path = `${dir}${f.path}`;
    keep.add(path);
    const have = c.tree.get(path);
    if (have !== (await gitBlobSha(f.bytes))) changes.push({ path, bytes: f.bytes, size: f.bytes.length, action: have ? 'update' : 'add' });
  }
  for (const [path] of under(c.tree, dir)) if (!keep.has(path)) changes.push({ path, size: 0, action: 'delete', delete: true });
  if (!changes.length) throw new Refusal('bad-release', `${dir} already holds exactly this render. Tag it instead of uploading it again.`);
  const sent = changes.filter((x) => !x.delete);
  return { kind: 'upload', repo: c.repo, folder: c.folder, branch: c.branch, head: c.head, name, version, tag: releaseTag(name, version), dir, files: sent.length, bytes: sent.reduce((n, x) => n + x.size, 0), changes, total: { files: checked.length, bytes } };
}

export function describeRelease(plan) {
  if (plan.kind === 'tag') return [`Tag ${plan.tag} on github.com/${plan.repo} (${plan.branch}), the commit it is at now. ${plan.files} files already in ${plan.dir}; nothing is uploaded.`];
  const gone = plan.changes.filter((x) => x.delete).length;
  return [`${plan.files} file${plan.files === 1 ? '' : 's'}, ${fmtBytes(plan.bytes)}, to github.com/${plan.repo} (${plan.branch}) in ${plan.dir} as ${plan.tag}`, ...(gone ? [`${gone} file${gone === 1 ? '' : 's'} of the folder's previous contents removed, so the release is exactly what was picked`] : [])];
}

// One commit (for an upload), then the tag. If the tag fails after the commit, the folder is in
// the repository and tagging it is the retry.
export async function executeRelease(gh, plan, { onProgress = () => {} } = {}) {
  const receipt = { repo: plan.repo, branch: plan.branch, tag: plan.tag, tagUrl: `https://github.com/${plan.repo}/tree/${plan.tag.split('/').map(encodeURIComponent).join('/')}`, commit: null };
  let sha = plan.head.sha;
  if (plan.kind === 'upload') {
    const c = await gh.commit(plan.repo, {
      branch: plan.branch,
      parent: plan.head.sha,
      baseTree: plan.head.treeSha,
      files: plan.changes.map((x) => (x.delete ? { path: x.path, delete: true } : { path: x.path, content: x.bytes })),
      message: `Add video release ${plan.tag}`,
      onProgress,
    });
    receipt.commit = { sha: c.sha, url: c.url };
    sha = c.sha;
  }
  if (await gh.tagExists(plan.repo, plan.tag)) throw new Refusal('bad-release', `${plan.tag} already exists, and a tag never moves. Choose the next version.`);
  try {
    await gh.createTag(plan.repo, plan.tag, sha);
  } catch (e) {
    if (receipt.commit) e.message = `The files are committed (${receipt.commit.sha.slice(0, 7)}) but tagging ${plan.tag} failed: ${e.message}. Open "Create a release" again and tag the folder.`;
    throw e;
  }
  return receipt;
}

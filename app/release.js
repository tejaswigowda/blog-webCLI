// Publishing a video release from the blog app: tag a render folder that is already in the video repository. The app does
// not transcode and does not upload video: a render is made and committed by hls.webcli.app (or ffmpeg). A release is one tag
// <name>/v<N>; a published tag never moves, so the next change is the next version.
import { parseRepoRef } from '../lib/reporef.js';
import { Refusal } from '../lib/errors.js';
import { nextVersion, releaseFolders, releaseTag, versionsOf } from '../lib/release.js';

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

export function describeRelease(plan) {
  return [`Tag ${plan.tag} on github.com/${plan.repo} (${plan.branch}), the commit it is at now. ${plan.files} files already in ${plan.dir}; nothing is uploaded.`];
}

// One tag, at the commit the branch is at now. A tag never moves.
export async function executeRelease(gh, plan) {
  const receipt = { repo: plan.repo, branch: plan.branch, tag: plan.tag, tagUrl: `https://github.com/${plan.repo}/tree/${plan.tag.split('/').map(encodeURIComponent).join('/')}`, commit: null };
  if (await gh.tagExists(plan.repo, plan.tag)) throw new Refusal('bad-release', `${plan.tag} already exists, and a tag never moves. Choose the next version.`);
  await gh.createTag(plan.repo, plan.tag, plan.head.sha);
  return receipt;
}

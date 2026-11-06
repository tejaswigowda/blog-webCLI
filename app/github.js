// Minimal GitHub client: raw reads for public repos, REST for everything with a token,
// and the Git Data API for multi-file commits.
import { Refusal } from '../lib/errors.js';

export class GitHubError extends Error {
  constructor(status, message, hint = '') {
    super(`GitHub ${status}: ${message}${hint ? `\n\n${hint}` : ''}`);
    this.status = status;
  }
}

// A fine-grained token that lacks a permission, or does not list the repository, gets a
// bare "Resource not accessible". Say which request, which permission and which repository.
export function permissionHint(status, method, path, message) {
  if (status === 422 && method === 'PATCH' && /fast forward/i.test(message)) {
    return 'The branch changed after this publish was planned (someone pushed, or another tab published), so the commit was not applied and nothing on the branch was overwritten. Reload the page and publish again.';
  }
  if (status !== 403 || !/not accessible by/i.test(message)) return '';
  const m = /^\/repos\/([^/]+\/[^/?]+)/.exec(path);
  if (!m) return '';
  const write = method !== 'GET' && method !== 'HEAD';
  const need = /\/pulls(\/|\?|$)/.test(path) ? 'Pull requests: Read and write' : write ? 'Contents: Read and write' : 'Contents: Read-only';
  return `The request that GitHub refused: ${method} ${path.replace(/\?.*$/, '')}\nThe token needs "${need}" on ${m[1]}, and ${m[1]} must be one of the repositories selected for the token (github.com/settings/personal-access-tokens). Being able to read a public repository, or being its owner, does not give the token write access.`;
}

const API = 'https://api.github.com';
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

export function assertToken(token) {
  if (/^ghp_/.test(token)) {
    throw new Refusal('classic-token', 'a classic token with repo scope can write to every repository you own. Create a fine-grained token limited to the blog and asset repositories.');
  }
  if (!token || /\s/.test(token)) throw new Error('That does not look like a token.');
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function gitBlobSha(bytes) {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head);
  all.set(bytes, head.length);
  const digest = await crypto.subtle.digest('SHA-1', all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class GitHub {
  constructor(net, { token = null, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.net = net;
    this.token = token;
    this.wait = wait;
    this.onWait = null; // (seconds) => void, told when a write is being retried after a rate limit
  }

  headers(extra = {}) {
    const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  // GitHub throttles content creation (a secondary rate limit, answered 403 or 429). A video upload is
  // many blobs, so wait it out and retry the same request, as hls.webcli.app does, rather than fail
  // halfway through. Reads and other errors are not retried.
  async api(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request(method, path, body);
      } catch (e) {
        const limited = method !== 'GET' && (e.status === 403 || e.status === 429) && /rate limit/i.test(e.message);
        if (!limited || attempt >= 4) throw e;
        const seconds = 70 * (attempt + 1);
        if (this.onWait) this.onWait(seconds);
        await this.wait(seconds * 1000);
      }
    }
  }

  async request(method, path, body) {
    const res = await this.net.request(`${API}${path}`, {
      method,
      headers: this.headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = res.text().slice(0, 200);
      try {
        msg = res.json().message || msg;
      } catch {
        /* keep raw text */
      }
      throw new GitHubError(res.status, msg, permissionHint(res.status, method, path, msg));
    }
    return res.status === 204 ? null : res.json();
  }

  // Text file at ref, or null when absent. Public repos are read without the API.
  async readText(repo, path, ref) {
    const res = this.token
      ? await this.net.request(`${API}/repos/${repo}/contents/${encPath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, {
          headers: this.headers({ Accept: 'application/vnd.github.raw+json' }),
        })
      : await this.net.request(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref || 'HEAD')}/${encPath(path)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubError(res.status, res.text().slice(0, 200));
    return res.text();
  }

  // Raw bytes of a file at ref (binary-safe), or null when absent.
  async readBytes(repo, path, ref) {
    const res = this.token
      ? await this.net.request(`${API}/repos/${repo}/contents/${encPath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, { headers: this.headers({ Accept: 'application/vnd.github.raw+json' }) })
      : await this.net.request(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref || 'HEAD')}/${encPath(path)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubError(res.status, res.text().slice(0, 200));
    return res.bytes;
  }

  async branchExists(repo, name) {
    try {
      await this.api('GET', `/repos/${repo}/git/ref/heads/${encPath(name)}`);
      return true;
    } catch (e) {
      if (e.status === 404) return false;
      throw e;
    }
  }

  async listDir(repo, path, ref) {
    try {
      const list = await this.api('GET', `/repos/${repo}/contents/${encPath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
      return Array.isArray(list) ? list.map((e) => e.name) : [];
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  }

  async tagExists(repo, tag) {
    try {
      await this.api('GET', `/repos/${repo}/git/ref/tags/${encPath(tag)}`);
      return true;
    } catch (e) {
      if (e.status === 404) return false;
      throw e;
    }
  }

  // A lightweight tag. Never moved: the caller checks that it does not exist, and GitHub refuses a second.
  createTag(repo, tag, sha) {
    return this.api('POST', `/repos/${repo}/git/refs`, { ref: `refs/tags/${tag}`, sha });
  }

  // The tree a tag points at, whether the tag is lightweight or annotated.
  async tagTreeSha(repo, tag) {
    let obj = (await this.api('GET', `/repos/${repo}/git/ref/tags/${encPath(tag)}`)).object;
    if (obj && obj.type === 'tag') obj = (await this.api('GET', `/repos/${repo}/git/tags/${obj.sha}`)).object;
    if (!obj) return null;
    return (await this.api('GET', `/repos/${repo}/git/commits/${obj.sha}`)).tree.sha;
  }

  // Tag names of a repository ("clip/v3"), newest first is the caller's business.
  async tags(repo) {
    const refs = await this.api('GET', `/repos/${repo}/git/matching-refs/tags`);
    return refs.map((r) => r.ref.replace(/^refs\/tags\//, ''));
  }

  repoInfo(repo) {
    return this.api('GET', `/repos/${repo}`);
  }

  async headCommit(repo, branch) {
    const c = await this.api('GET', `/repos/${repo}/commits/${encodeURIComponent(branch)}`);
    return { sha: c.sha, treeSha: c.commit.tree.sha };
  }

  async tree(repo, treeSha) {
    const t = await this.api('GET', `/repos/${repo}/git/trees/${treeSha}?recursive=1`);
    if (t.truncated) throw new Error('Repository tree is too large to list in one request.');
    return new Map(t.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
  }

  // Latest commit sha touching `path`, or null when the file does not exist.
  async pathSha(repo, path, branch) {
    const list = await this.api('GET', `/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1${branch ? `&sha=${encodeURIComponent(branch)}` : ''}`);
    return list.length ? list[0].sha : null;
  }

  // files: [{ path, content: string | Uint8Array } | { path, delete: true }]
  async commit(repo, { branch, parent, baseTree, files, message, newBranch = false, onProgress = () => {} }) {
    const entries = [];
    let done = 0;
    for (const f of files) {
      onProgress(done++, files.length);
      if (f.delete) entries.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
      else if (typeof f.content === 'string') entries.push({ path: f.path, mode: '100644', type: 'blob', content: f.content });
      else {
        const blob = await this.api('POST', `/repos/${repo}/git/blobs`, { content: toBase64(f.content), encoding: 'base64' });
        entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
    }
    const tree = await this.api('POST', `/repos/${repo}/git/trees`, { base_tree: baseTree, tree: entries });
    const commit = await this.api('POST', `/repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [parent] });
    if (newBranch) await this.api('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
    else await this.api('PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha });
    return { sha: commit.sha, treeSha: tree.sha, url: `https://github.com/${repo}/commit/${commit.sha}` };
  }

  createPull(repo, { title, head, base, body }) {
    return this.api('POST', `/repos/${repo}/pulls`, { title, head, base, body });
  }

  whoami() {
    return this.api('GET', '/user');
  }
}

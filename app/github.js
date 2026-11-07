// Minimal GitHub client: raw reads for public repos, REST for everything with a token,
// and the Git Data API for multi-file commits.
import { Refusal } from '../lib/errors.js';

export class GitHubError extends Error {
  constructor(status, message, hint = '') {
    super(`GitHub ${status}: ${message}${hint ? `\n\n${hint}` : ''}`);
    this.status = status;
    this.retrySeconds = 0; // when GitHub said how long to wait (Retry-After, or the hourly limit's reset)
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
const TREE_CHUNK = 1_500_000; // characters of file text in one tree request
const TREE_ENTRIES = 300; // and files: GitHub times out a request that makes too much at once
const GRAPHQL_BATCH = 100; // blobs asked for in one GraphQL request (a query costs one point of the hourly limit, whatever it holds)
export const BULK_AT = 100; // reads or writes above which an operation is long: it waits out the rate limit, reports progress, and can be stopped
const SHA1 = /^[0-9a-f]{40}$/;
const stopped = (what) => new Refusal('cancelled', `Stopped. ${what}`);
const fromBase64 = (b64) => Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0));
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
  constructor(net, { token = null, store = null, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.net = net;
    this.token = token;
    this.store = store; // localStorage-like: remembers which blobs a repository already has, so an interrupted upload resumes
    this.wait = wait;
    this.onWait = null; // (seconds) => void, told when a request is being retried after a rate limit
    this.patient = false; // a long upload: wait out any rate limit until GitHub says go, however long, instead of failing
    this.isCancelled = null;
    this.rate = null; // { remaining, reset } from the latest response
    this.ledgers = new Map();
    this.onProgress = null; // (what, done, total) => void, told how a long read or send is getting on
    this.texts = new Map(); // "repo@blob sha" -> the text of a file already read: a blob never changes, so it is never read twice
    this.noGraphql = false; // GraphQL answered like something this token cannot use: files are read one request each
  }

  headers(extra = {}) {
    const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  // GitHub throttles content creation (a secondary rate limit, answered 403 or 429). A video upload is
  // many blobs, so wait it out and retry the same request, as hls.webcli.app does, rather than fail
  // halfway through. Reads and other errors are not retried.
  // In patient mode (a long import) it waits for exactly as long as GitHub says, reads included, and stops short of the
  // limit instead of running into it.
  async api(method, path, body) {
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      if (this.patient) await this.pace();
      try {
        return await this.request(method, path, body);
      } catch (e) {
        const rateLimited = (e.status === 403 || e.status === 429) && /rate limit/i.test(e.message);
        if (this.patient) {
          const seconds = Math.min(Math.max(e.retrySeconds || 70, 5), 3700);
          if (!rateLimited || waited + seconds > 4 * 3600) throw e;
          this.rate = null; // this wait is the one that counts; do not wait again for the same limit
          waited += seconds;
          await this.sleep(seconds);
          continue;
        }
        const limited = method !== 'GET' && rateLimited;
        if (!limited || attempt >= 4) throw e;
        const seconds = 70 * (attempt + 1);
        if (this.onWait) this.onWait(seconds);
        await this.wait(seconds * 1000);
      }
    }
  }

  async sleep(seconds) {
    for (let left = Math.ceil(seconds); left > 0; ) {
      if (this.isCancelled && this.isCancelled()) throw new Refusal('cancelled', 'Stopped. Nothing is committed until every file is sent, so the branch is unchanged; what was already uploaded is remembered, and starting again carries on from there.');
      if (this.onWait) this.onWait(left);
      const tick = Math.min(5, left);
      await this.wait(tick * 1000);
      left -= tick;
    }
  }

  // Close to the hourly limit, wait for it to reset now rather than fail on the next request.
  async pace() {
    if (this.isCancelled && this.isCancelled()) throw new Refusal('cancelled', 'Stopped. Nothing is committed until every file is sent, so the branch is unchanged; what was already uploaded is remembered, and starting again carries on from there.');
    const r = this.rate;
    if (!r || r.remaining > 3) return;
    this.rate = null;
    const seconds = r.reset - Date.now() / 1000 + 2;
    if (seconds > 0) await this.sleep(Math.min(seconds, 3700));
  }

  async request(method, path, body) {
    const res = await this.net.request(`${API}${path}`, {
      method,
      headers: this.headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const header = (n) => (res.headers && res.headers.get ? res.headers.get(n) : null);
    const remaining = header('x-ratelimit-remaining');
    const reset = Number(header('x-ratelimit-reset'));
    if (remaining !== null && remaining !== undefined && reset) this.rate = { remaining: Number(remaining), reset };
    if (!res.ok) {
      let msg = res.text().slice(0, 200);
      try {
        msg = res.json().message || msg;
      } catch {
        /* keep raw text */
      }
      const err = new GitHubError(res.status, msg, permissionHint(res.status, method, path, msg));
      const after = Number(header('retry-after'));
      if (after > 0) err.retrySeconds = after + 1;
      else if (remaining === '0' && reset) err.retrySeconds = Math.max(0, Math.ceil(reset - Date.now() / 1000)) + 2;
      throw err;
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

  // The text of many files at once. items: [{ path, sha }] (the sha is the file's git blob id, from the tree). -> Map(path -> text),
  // a path with no readable text (gone, or binary) absent. A file already read this session is not read again. Past BULK_AT files
  // this waits out GitHub's rate limit instead of failing, reports progress (this.onProgress) and stops when this.isCancelled says;
  // with a token the files come a hundred to a request (GraphQL), without one from the public host, a few at a time.
  async readMany(repo, items, { ref, concurrency = 6 } = {}) {
    const out = new Map();
    const todo = [];
    for (const it of items) {
      const hit = it.sha ? this.texts.get(`${repo}@${it.sha}`) : undefined;
      if (hit !== undefined) out.set(it.path, hit);
      else todo.push(it);
    }
    let done = out.size;
    const say = () => this.onProgress && this.onProgress('Reading', done, items.length);
    if (!todo.length) return out;
    const wasPatient = this.patient;
    if (todo.length > BULK_AT) this.patient = true;
    const keep = (it, text) => {
      if (text === null || text === undefined) return;
      out.set(it.path, text);
      if (it.sha) this.texts.set(`${repo}@${it.sha}`, text);
    };
    try {
      say();
      let rest = todo;
      if (this.token && !this.noGraphql && todo.length > 20 && todo.every((i) => SHA1.test(i.sha || ''))) {
        rest = await this.graphqlTexts(repo, todo, (it, text) => {
          keep(it, text);
          done++;
        }, say);
      }
      let next = 0;
      const worker = async () => {
        while (next < rest.length) {
          if (this.isCancelled && this.isCancelled()) throw stopped('Nothing was changed.');
          const it = rest[next++];
          keep(it, await this.readOne(repo, it, ref));
          done++;
          if (done % 10 === 0 || done === items.length) say();
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, rest.length) }, worker));
      say();
    } finally {
      this.patient = wasPatient;
    }
    return out;
  }

  // A file just written is a file already read: the next plan will not ask for it.
  async remember(repo, text) {
    this.texts.set(`${repo}@${await gitBlobSha(new TextEncoder().encode(text))}`, text);
  }

  // One file by its blob id (through the API, which waits out limits when asked to) or, with no token, from the public host.
  async readOne(repo, it, ref) {
    if (!this.token || !it.sha || !SHA1.test(it.sha)) return this.readText(repo, it.path, ref);
    try {
      const blob = await this.api('GET', `/repos/${repo}/git/blobs/${it.sha}`);
      return new TextDecoder().decode(blob.encoding === 'base64' ? fromBase64(blob.content) : new TextEncoder().encode(blob.content));
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  // The files GraphQL could not give (binary, cut short, not found) come back to be read the other way. A request GraphQL refuses
  // outright ends its use for the session.
  async graphqlTexts(repo, items, got, say) {
    const [owner, name] = repo.split('/');
    const rest = [];
    for (let i = 0; i < items.length; i += GRAPHQL_BATCH) {
      if (this.isCancelled && this.isCancelled()) throw stopped('Nothing was changed.');
      const batch = items.slice(i, i + GRAPHQL_BATCH);
      const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${batch.map((it, k) => `b${k}: object(oid: "${it.sha}") { ... on Blob { text isTruncated } }`).join(' ')} } }`;
      let res;
      for (;;) {
        try {
          res = await this.api('POST', '/graphql', { query });
        } catch (e) {
          if (e.status === 401 || e.status === 404 || e.status === 403) {
            this.noGraphql = true;
            return [...rest, ...items.slice(i)];
          }
          throw e;
        }
        const limited = res && res.errors && res.errors.some((x) => x.type === 'RATE_LIMITED');
        if (!limited) break;
        if (!this.patient) throw new GitHubError(403, 'GraphQL rate limit exceeded');
        await this.sleep(60);
      }
      const repository = res && res.data && res.data.repository;
      if (!repository) {
        this.noGraphql = true;
        return [...rest, ...items.slice(i)];
      }
      batch.forEach((it, k) => {
        const o = repository[`b${k}`];
        if (o && typeof o.text === 'string' && !o.isTruncated) got(it, o.text);
        else rest.push(it);
      });
      say();
    }
    return rest;
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

  // Tag names of a repository ("clip/v3"), newest first is the caller's business. GitHub returns 30 at a time unless asked for more.
  async tags(repo) {
    const names = [];
    for (let page = 1; page <= 50; page++) {
      const refs = await this.api('GET', `/repos/${repo}/git/matching-refs/tags?per_page=100&page=${page}`);
      names.push(...refs.map((r) => r.ref.replace(/^refs\/tags\//, '')));
      if (refs.length < 100) break;
    }
    return names;
  }

  repoInfo(repo) {
    return this.api('GET', `/repos/${repo}`);
  }

  // The latest GitHub Pages build (status queued|building|built|errored, commit, error), for the deployment state.
  pagesBuild(repo) {
    return this.api('GET', `/repos/${repo}/pages/builds/latest`);
  }

  async headCommit(repo, branch) {
    const c = await this.api('GET', `/repos/${repo}/commits/${encodeURIComponent(branch)}`);
    return { sha: c.sha, treeSha: c.commit.tree.sha };
  }

  async tree(repo, treeSha) {
    const t = await this.api('GET', `/repos/${repo}/git/trees/${treeSha}?recursive=1`);
    if (t.truncated) return this.treeByFolders(repo, treeSha); // a very large repository: one folder at a time
    return new Map(t.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
  }

  async treeByFolders(repo, sha, prefix = '', out = new Map()) {
    const t = await this.api('GET', `/repos/${repo}/git/trees/${sha}`);
    if (t.truncated) throw new Error(`The folder ${prefix || '/'} of this repository is too large to list.`);
    const folders = [];
    for (const e of t.tree) {
      if (e.type === 'blob') out.set(prefix + e.path, e.sha);
      else if (e.type === 'tree') folders.push(e);
    }
    let next = 0;
    const worker = async () => {
      while (next < folders.length) {
        if (this.isCancelled && this.isCancelled()) throw stopped('Nothing was changed.');
        const f = folders[next++];
        await this.treeByFolders(repo, f.sha, `${prefix}${f.path}/`, out);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, folders.length) }, worker));
    return out;
  }

  // Latest commit sha touching `path`, or null when the file does not exist.
  async pathSha(repo, path, branch) {
    const list = await this.api('GET', `/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1${branch ? `&sha=${encodeURIComponent(branch)}` : ''}`);
    return list.length ? list[0].sha : null;
  }

  // The blobs a repository is known to have (by their git sha), kept for three days: GitHub drops blobs no commit refers to.
  ledger(repo) {
    if (!this.ledgers.has(repo)) {
      let data = {};
      try {
        data = JSON.parse((this.store && this.store.getItem(`blog.webcli.blobs:${repo}`)) || '{}');
      } catch {
        data = {};
      }
      const cutoff = Date.now() - 3 * 86400e3;
      for (const k of Object.keys(data)) if (!(data[k] > cutoff)) delete data[k];
      this.ledgers.set(repo, data);
    }
    return this.ledgers.get(repo);
  }

  saveLedger(repo) {
    try {
      if (this.store) this.store.setItem(`blog.webcli.blobs:${repo}`, JSON.stringify(this.ledger(repo)));
    } catch {
      /* storage full or unavailable: the upload still works, it just cannot be resumed */
    }
  }

  // files: [{ path, content: string | Uint8Array } | { path, delete: true }]
  // skipIfUnchanged: when the result is the tree the branch already has, make no commit (an import carried on after a stop).
  async commit(repo, opts) {
    try {
      return await this.commitOnce(repo, opts, true);
    } catch (e) {
      // a remembered blob that GitHub no longer has (a repository that was deleted and made again): forget them, send everything
      if (e.status === 422 && this.reused && !/fast forward/i.test(e.message)) {
        this.ledgers.set(repo, {});
        this.saveLedger(repo);
        return this.commitOnce(repo, opts, false);
      }
      throw e;
    }
  }

  // A tree request that GitHub times out ("too large to process") is made again as two halves, one built on the other.
  async postTree(repo, base, entries) {
    try {
      return await this.api('POST', `/repos/${repo}/git/trees`, { base_tree: base, tree: entries });
    } catch (e) {
      if (e.status !== 422 || !/timed out|too large/i.test(e.message) || entries.length < 2) throw e;
      const half = Math.ceil(entries.length / 2);
      const first = await this.postTree(repo, base, entries.slice(0, half));
      return this.postTree(repo, first.sha, entries.slice(half));
    }
  }

  async commitOnce(repo, { branch, parent, baseTree, files, message, newBranch = false, skipIfUnchanged = false, onProgress = () => {} }, useLedger) {
    this.reused = 0;
    const ledger = this.ledger(repo);
    let sinceSave = 0;
    // Small text goes into the tree request itself; binaries, and text past about 2 MB in all, become blobs of their own,
    // a few at a time, so a large import is neither one enormous request nor one request after another.
    // Text goes into the tree requests themselves, a few MB at a time in a chain of trees (each built on the last), so ten
    // thousand pages are a few dozen requests and not ten thousand blobs against an hourly limit of five thousand. Only
    // binaries, and a single text file too big for a request, become blobs of their own.
    const inline = files.map((f) => !f.delete && typeof f.content === 'string' && f.content.length <= TREE_CHUNK);
    const entries = new Array(files.length);
    let next = 0;
    let broken = false;
    const worker = async () => {
      try {
        while (next < files.length && !broken) {
          const i = next++;
          const f = files[i];
          onProgress(i, files.length); // as before: how many were started before this one
          if (f.delete) entries[i] = { path: f.path, mode: '100644', type: 'blob', sha: null };
          else if (inline[i]) entries[i] = { path: f.path, mode: '100644', type: 'blob', content: f.content };
          else {
            const bytes = typeof f.content === 'string' ? new TextEncoder().encode(f.content) : f.content;
            const known = await gitBlobSha(bytes);
            if (useLedger && ledger[known]) {
              this.reused++;
              entries[i] = { path: f.path, mode: '100644', type: 'blob', sha: known };
            } else {
              const blob = await this.api('POST', `/repos/${repo}/git/blobs`, typeof f.content === 'string' ? { content: f.content, encoding: 'utf-8' } : { content: toBase64(f.content), encoding: 'base64' });
              entries[i] = { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
              ledger[blob.sha] = Date.now();
              if (++sinceSave >= 25) {
                sinceSave = 0;
                this.saveLedger(repo);
              }
            }
          }
        }
      } catch (e) {
        broken = true; // the others finish the file they are on, and take no more
        throw e;
      }
    };
    // every worker is let finish what it is doing, so what was sent is all remembered before a failure is reported
    const results = await Promise.allSettled(Array.from({ length: Math.min(this.patient ? 3 : 4, files.length) }, worker));
    this.saveLedger(repo);
    const bad = results.find((r) => r.status === 'rejected');
    if (bad) throw bad.reason;
    const chunks = [[]];
    let size = 0;
    for (const e of entries) {
      const n = e.content === undefined ? 0 : e.content.length;
      if ((size + n > TREE_CHUNK || chunks[chunks.length - 1].length >= TREE_ENTRIES) && chunks[chunks.length - 1].length) {
        chunks.push([]);
        size = 0;
      }
      chunks[chunks.length - 1].push(e);
      size += n;
    }
    let tree = { sha: baseTree };
    let sent = 0;
    for (const [i, entriesOfChunk] of chunks.entries()) {
      if (i > 0 && this.isCancelled && this.isCancelled()) throw new Refusal('cancelled', 'Stopped. Nothing is committed until every file is sent, so the branch is unchanged; what was already uploaded is remembered, and starting again carries on from there.');
      if (this.onProgress && files.length > BULK_AT) this.onProgress('Sending', sent, files.length);
      tree = await this.postTree(repo, tree.sha, entriesOfChunk);
      sent += entriesOfChunk.length;
    }
    if (this.onProgress && files.length > BULK_AT) this.onProgress('Sending', files.length, files.length);
    if (skipIfUnchanged && tree.sha === baseTree) return { sha: parent, treeSha: tree.sha, url: `https://github.com/${repo}/commit/${parent}`, unchanged: true };
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

// An in-memory GitHub: just enough REST + raw hosting for the app core.
// Trees are Map<path, { bytes, sha }> with real git blob shas.
import { gitBlobSha } from '../app/github.js';

const enc = new TextEncoder();
const bytesOf = (c) => (typeof c === 'string' ? enc.encode(c) : c);

// tags: { repo: [tag names] }; aliases: { repo: { 'v1.0.0': 'main' } } makes a tag or sha resolve to a branch's content.
// pages: { repo: 'https://…/' } = Pages is on, built, and says so; 'building:https://…/' = on but not deployed yet;
// 'forbidden' = on, but the token may not read it.
// graphql: false = GraphQL is not available to this token (404); graphqlCutoff: a blob over this many bytes comes back cut short;
// treeLimit: a tree listing with more entries than this is "truncated", as GitHub does at 100,000.
export function fakeGitHub(repos, { tags = {}, aliases = {}, pages = {}, builds = {}, graphql = true, graphqlCutoff = Infinity, treeLimit = Infinity } = {}) {
  const state = {};
  let n = 0;
  const fakeSha = (label) => gitBlobSha(enc.encode(`${label}${++n}`));
  const entry = async (c) => {
    const bytes = bytesOf(c);
    return { bytes, sha: await gitBlobSha(bytes) };
  };

  async function init(name, files) {
    const tree = new Map();
    for (const [p, c] of Object.entries(files)) tree.set(p, await entry(c));
    const treeSha = await fakeSha('tree');
    const c0 = await fakeSha('commit');
    state[name] = { trees: { [treeSha]: tree }, commits: { [c0]: { tree: treeSha, msg: 'init' } }, branches: { main: c0 }, tagRefs: {}, blobs: {}, pulls: [], log: [] };
  }
  const ready = Promise.all(Object.entries(repos).map(([k, v]) => init(k, v)));

  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const text = (t, status = 200) => new Response(t, { status });
  const notFound = () => json({ message: 'Not Found' }, 404);
  const resolveRef = (S, ref) => (ref === 'HEAD' ? S.branches.main : S.branches[ref] || (S.commits[ref] ? ref : null));
  const treeAt = (S, ref) => S.trees[S.commits[resolveRef(S, ref)].tree];

  async function fetch(url, { method = 'GET', headers = {}, body } = {}) {
    await ready;
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (u.hostname === 'raw.githubusercontent.com') {
      const [o, r, ref0, ...path] = parts;
      const S = state[`${o}/${r}`];
      const ref = ((aliases[`${o}/${r}`] || {})[ref0]) || ref0;
      if (!S || headers.Authorization || !resolveRef(S, ref)) return notFound();
      const f = treeAt(S, ref).get(path.join('/'));
      return f ? new Response(f.bytes) : notFound();
    }
    if (u.hostname === 'cdn.jsdelivr.net') {
      // /gh/<owner>/<repo>@<ref>/<path>
      const [, o, rr, ...path] = parts;
      const [r, ref0] = String(rr).split('@');
      const S = state[`${o}/${r}`];
      const ref = ((aliases[`${o}/${r}`] || {})[ref0]) || ref0;
      if (!S || !resolveRef(S, ref)) return notFound();
      const f = treeAt(S, ref).get(path.join('/'));
      return f ? new Response(f.bytes) : notFound();
    }
    if (u.hostname !== 'api.github.com') return text('unexpected host ' + u.hostname, 500);
    if (parts[0] === 'user') return json({ login: 'tester' });
    if (parts[0] === 'graphql') {
      if (!graphql) return json({ message: 'Not Found' }, 404);
      const q = JSON.parse(body).query;
      const m = /repository\(owner: "([^"]+)", name: "([^"]+)"\)/.exec(q);
      const R = m && state[`${m[1]}/${m[2]}`];
      if (!R) return json({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] });
      const byId = new Map();
      for (const t of Object.values(R.trees)) for (const e of t.values()) byId.set(e.sha, e);
      for (const e of Object.values(R.blobs)) byId.set(e.sha, e);
      const repository = {};
      const asked = [...q.matchAll(/(b\d+): object\(oid: "([0-9a-f]{40})"\)/g)];
      for (const [, alias, oid] of asked) {
        const e = byId.get(oid);
        repository[alias] = !e ? null : e.bytes.includes(0) ? { text: null, isTruncated: false } : e.bytes.length > graphqlCutoff ? { text: new TextDecoder().decode(e.bytes.slice(0, graphqlCutoff)), isTruncated: true } : { text: new TextDecoder().decode(e.bytes), isTruncated: false };
      }
      R.log.push(`POST graphql ${asked.length}`);
      return json({ data: { repository } });
    }
    const [, o, r, ...rest] = parts;
    const S = state[`${o}/${r}`];
    if (!S) return notFound();
    S.log.push(`${method} ${rest.join('/')}`);
    const b = body ? JSON.parse(body) : null;

    if (!rest.length) return json({ default_branch: 'main', permissions: { push: true }, has_pages: `${o}/${r}` in pages });
    // builds: { 'owner/repo': () => the latest Pages build object, null (none yet) or 'forbidden' }
    if (rest[0] === 'pages' && rest[1] === 'builds' && rest[2] === 'latest') {
      const b = typeof builds[`${o}/${r}`] === 'function' ? builds[`${o}/${r}`](S) : builds[`${o}/${r}`];
      if (b === 'forbidden') return json({ message: 'Resource not accessible by personal access token' }, 403);
      return b ? json(b) : notFound();
    }
    if (rest[0] === 'pages') {
      const p = pages[`${o}/${r}`];
      if (!p) return notFound();
      return p === 'forbidden' ? json({ message: 'Resource not accessible by personal access token' }, 403) : json({ html_url: p.replace(/^building:/, ''), status: p.startsWith('building:') ? 'building' : 'built' });
    }
    if (rest[0] === 'commits' && rest.length === 2) {
      const sha = resolveRef(S, rest[1]);
      return sha ? json({ sha, commit: { tree: { sha: S.commits[sha].tree } } }) : notFound();
    }
    if (rest[0] === 'commits') return json(treeAt(S, 'main').has(u.searchParams.get('path')) ? [{ sha: S.branches.main }] : []);
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const refName = u.searchParams.get('ref') || 'main';
      const tree = treeAt(S, (aliases[`${o}/${r}`] || {})[refName] || refName);
      if (tree.has(path)) return new Response(tree.get(path).bytes);
      const names = [...new Set([...tree.keys()].filter((k) => k.startsWith(path + '/')).map((k) => k.slice(path.length + 1).split('/')[0]))];
      return names.length ? json(names.map((name) => ({ name }))) : notFound();
    }
    if (rest[0] === 'git') {
      const tagList = tags[`${o}/${r}`] || [];
      if (rest[1] === 'ref' && rest[2] === 'heads') return rest.slice(3).join('/') in S.branches ? json({ ref: `refs/heads/${rest.slice(3).join('/')}` }) : notFound();
      if (rest[1] === 'ref' && rest[2] === 'tags') {
        const name = rest.slice(3).join('/');
        // a configured tag points at its alias's branch (or main); a created one at the commit it was made at
        const sha = S.tagRefs[name] || (tagList.includes(name) ? S.branches[(aliases[`${o}/${r}`] || {})[name] || 'main'] : null);
        return sha ? json({ ref: `refs/tags/${name}`, object: { sha, type: 'commit' } }) : notFound();
      }
      if (rest[1] === 'matching-refs') {
        const all = [...new Set([...tagList, ...Object.keys(S.tagRefs)])].map((t) => ({ ref: `refs/tags/${t}` }));
        const per = Number(u.searchParams.get('per_page')) || 30; // as GitHub: 30 a page unless asked for more
        const page = Number(u.searchParams.get('page')) || 1;
        return json(all.slice((page - 1) * per, page * per));
      }
      if (rest[1] === 'commits' && method === 'GET') return S.commits[rest[2]] ? json({ sha: rest[2], tree: { sha: S.commits[rest[2]].tree } }) : notFound();
      if (rest[1] === 'blobs' && method === 'GET') {
        const e = [...Object.values(S.trees).flatMap((t) => [...t.values()]), ...Object.values(S.blobs)].find((x) => x.sha === rest[2]);
        return e ? json({ sha: e.sha, encoding: 'base64', content: btoa(String.fromCharCode(...e.bytes)) }) : notFound();
      }
      if (rest[1] === 'trees' && method === 'GET') {
        // a sha is a tree, or "dir:<tree>:<folder/>": a folder of one, which is how a listing one folder at a time is told apart here
        const [, whole, enc = ''] = /^dir:([0-9a-f]+):(.*)$/.exec(rest[2]) || [null, rest[2]];
        const folder = enc.replaceAll('|', '/');
        const t = S.trees[whole];
        if (!t) return notFound();
        if (u.searchParams.get('recursive')) {
          const all = [...t].map(([path, e]) => ({ path, type: 'blob', sha: e.sha }));
          return json(all.length > treeLimit ? { truncated: true, tree: all.slice(0, treeLimit) } : { truncated: false, tree: all });
        }
        const here = new Map();
        for (const [path, e] of t) {
          if (!path.startsWith(folder)) continue;
          const [first, ...more] = path.slice(folder.length).split('/');
          if (more.length) here.set(first, { path: first, type: 'tree', sha: `dir:${whole}:${`${folder}${first}/`.replaceAll('/', '|')}` });
          else here.set(first, { path: first, type: 'blob', sha: e.sha });
        }
        const list = [...here.values()];
        return json(list.length > treeLimit ? { truncated: true, tree: list.slice(0, treeLimit) } : { truncated: false, tree: list });
      }
      if (rest[1] === 'blobs') {
        const e = await entry(b.encoding === 'utf-8' ? b.content : Uint8Array.from(atob(b.content), (c) => c.charCodeAt(0)));
        S.blobs[e.sha] = e;
        return json({ sha: e.sha }, 201);
      }
      if (rest[1] === 'trees') {
        const next = new Map(S.trees[b.base_tree]);
        for (const t of b.tree) {
          if (t.sha === null) next.delete(t.path);
          else if (t.content !== undefined) next.set(t.path, await entry(t.content));
          else if (!S.blobs[t.sha]) return json({ message: `GitRPC::BadObjectState: tree.sha ${t.sha} does not exist` }, 422);
          else next.set(t.path, S.blobs[t.sha]);
        }
        // as git: a tree is named by what is in it, so the same files make the same tree
        const sha = await gitBlobSha(enc.encode(`tree\n${[...next].sort(([x], [y]) => (x < y ? -1 : 1)).map(([p, e]) => `${p}\0${e.sha}`).join('\n')}`));
        S.trees[sha] = next;
        return json({ sha }, 201);
      }
      if (rest[1] === 'commits') {
        const sha = await fakeSha('commit');
        S.commits[sha] = { tree: b.tree, msg: b.message, parents: b.parents };
        return json({ sha }, 201);
      }
      if (rest[1] === 'refs' && method === 'POST' && b.ref.startsWith('refs/tags/')) {
        const name = b.ref.replace('refs/tags/', '');
        if (S.tagRefs[name] || tagList.includes(name)) return json({ message: 'Reference already exists' }, 422);
        S.tagRefs[name] = b.sha;
        return json({}, 201);
      }
      if (rest[1] === 'refs' && method === 'POST') {
        S.branches[b.ref.replace('refs/heads/', '')] = b.sha;
        return json({}, 201);
      }
      if (rest[1] === 'refs' && method === 'PATCH') {
        const br = rest[3];
        if (S.commits[b.sha].parents[0] !== S.branches[br]) return json({ message: 'Update is not a fast forward' }, 422);
        S.branches[br] = b.sha;
        return json({});
      }
    }
    if (rest[0] === 'pulls') {
      S.pulls.push(b);
      return json({ number: S.pulls.length, html_url: `https://github.com/${o}/${r}/pull/${S.pulls.length}` }, 201);
    }
    return text(`unhandled ${method} ${rest.join('/')}`, 500);
  }

  const files = (repo, branch = 'main') => Object.fromEntries([...treeAt(state[repo], branch)].map(([p, e]) => [p, new TextDecoder().decode(e.bytes)]));
  return { fetch, state, ready, files };
}

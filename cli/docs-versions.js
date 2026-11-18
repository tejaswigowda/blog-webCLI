import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Refusal } from '../lib/errors.js';
import { resolveOrder } from '../lib/order.js';
import { versionBlog, versionFiles, versionRootFiles } from '../lib/docs-versions.js';
import { buildSite, validateBlog } from '../lib/blog.js';

const exec = promisify(execFile);

export async function buildVersions(dir, blog, loadTheme) {
  const git = async (...args) => (await exec('git', args, { cwd: dir, maxBuffer: 64 * 1024 * 1024 })).stdout;
  let prefix;
  try {
    prefix = await git('rev-parse', '--show-prefix');
  } catch {
    throw new Refusal('unpinned-ref', 'versioned docs need a local Git checkout');
  }
  prefix = prefix.trim();
  const readSnapshot = async (version) => {
    const ref = version.ref;
    const sha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(ref);
    const candidates = sha ? [ref] : [...(version.default ? [`refs/heads/${ref}`] : []), `refs/tags/${ref}`];
    let commit;
    for (const spec of candidates) {
      try {
        commit = (await git('rev-parse', '--verify', `${spec}^{commit}`)).trim();
        break;
      } catch { /* try the next permitted namespace */ }
    }
    if (!commit) throw new Refusal('unpinned-ref', `version "${version.path}": ${ref} is not a local ${version.default ? 'branch, ' : ''}tag or full commit SHA`);
    const names = (await git('ls-tree', '--full-tree', '-r', '-z', '--name-only', commit, '--', prefix || '.')).split('\0').filter(Boolean)
      .filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length));
    const read = async (name) => git('show', `${commit}:${prefix}${name}`);
    if (!names.includes('blog.json')) throw new Refusal('no-blog-json', `version "${version.path}": no blog.json at ${ref}`);
    const snapshotBlog = validateBlog(await read('blog.json'));
    const posts = [];
    for (const name of names.filter((name) => /^(?:posts|pages)\/[^/]+\.md$|^comments\/[^/]+\.json$/.test(name)).sort()) posts.push({ path: name, text: await read(name) });
    let lock = {};
    if (names.includes('assets.lock.json')) {
      try { lock = JSON.parse(await read('assets.lock.json')); } catch { throw new Refusal('bad-blog-json', `version "${version.path}": invalid assets.lock.json`); }
    }
    const order = resolveOrder(snapshotBlog);
    const orderList = order.by === 'manual' && names.includes(order.list) ? await read(order.list) : null;
    return { blog: snapshotBlog, posts, lock, orderList };
  };
  const files = {};
  const outputs = {};
  const errors = [], warnings = [];
  let defaultResult;
  for (const version of blog.versions) {
    const source = await readSnapshot(version);
    const renderedBlog = versionBlog({ ...source.blog, domain: blog.domain }, version);
    const packs = await loadTheme(renderedBlog);
    const result = buildSite({ ...source, blog: renderedBlog, ...packs, version });
    warnings.push(...result.warnings.map((w) => `${version.path}: ${w}`));
    errors.push(...result.errors);
    if (version.default) defaultResult = { ...result, sourceUpdates: {}, defaultSource: source };
    if (!result.errors.length) {
      outputs[version.path] = versionFiles(blog, version, result.files);
      Object.assign(files, outputs[version.path]);
    }
  }
  Object.assign(files, versionRootFiles(blog, outputs));
  return { ...defaultResult, files: errors.length ? {} : files, errors, warnings };
}

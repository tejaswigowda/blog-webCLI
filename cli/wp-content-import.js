// blog-webcli import wp <export.xml | https://site> [dir] --repo owner/name[/folder] [--domain https://…] [--uploads <wp-content/uploads copy>] [--no-drafts] [--no-library] [--no-comments]
// The same import as the wizard, but from Node: a site's pictures can be fetched whatever its CORS policy, so this is the way to
// bring every picture across. It writes plain files (blog.json, posts/, pages/, images/) and nothing else: no network write, no
// commit. Push the pictures, then `pin` and `build` (the pin is the commit the pictures are in, which exists only after the push).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Refusal } from '../lib/errors.js';
import { blogJsonText, defaultDomain, makeBlogJson } from '../lib/init.js';
import { parseRepoRef } from '../lib/reporef.js';
import { validateBlog } from '../lib/blog.js';
import { planWp } from '../lib/wp-content.js';
import { createNet, fmtBytes } from '../app/net.js';
import { fetchImages, readExport, readSite, todayIso, uploadsPath } from '../app/import.js';

const exists = (p) => fs.access(p).then(() => true, () => false);

function parseArgs(args) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-drafts' || a === '--no-library' || a === '--no-comments') flags[a.slice(5)] = false;
    else if (a === '--repo' || a === '--domain' || a === '--uploads') flags[a.slice(2)] = args[++i];
    else if (a.startsWith('--')) throw new Refusal('import-refused', `unknown option ${a}`);
    else pos.push(a);
  }
  return { flags, pos };
}

export async function importWordPress(args, { fetchImpl = (...a) => globalThis.fetch(...a), log = console.log } = {}) {
  const { flags, pos } = parseArgs(args);
  const [kind, source, dirArg] = pos;
  if (kind !== 'wp' || !source) throw new Refusal('import-refused', 'usage: blog-webcli import wp <export.xml | https://site> [dir] --repo owner/name[/folder] [--domain https://…] [--uploads dir] [--no-drafts] [--no-library] [--no-comments]');
  if (!flags.repo) throw new Refusal('import-refused', 'say where the blog will live with --repo owner/name (or owner/name/folder): its pictures are named relative to it');
  const place = parseRepoRef(flags.repo);
  const dir = dirArg || '.';
  if (await exists(path.join(dir, 'blog.json'))) throw new Refusal('import-refused', `${path.resolve(dir)} already has a blog.json; an import never replaces a blog`);

  const net = createNet(fetchImpl);
  const model = /^https?:\/\//i.test(source) ? await readSite(net, source) : await readExport(await fs.readFile(source, 'utf8'));
  const job = planWp(model, { today: todayIso(), includeDrafts: flags.drafts !== false, includeLibrary: flags.library !== false, includeComments: flags.comments !== false });
  log(`${model.title || source}: ${model.posts.length} posts, ${model.pages.length} pages, ${model.media.length} media files; ${job.images.length} pictures to fetch`);
  let last = 0;
  // a copy of the old site's wp-content/uploads is used first: no network, and no permission needed from the old site
  const local = flags.uploads
    ? async (url) => {
        const k = uploadsPath(url);
        if (!k || k.split('/').includes('..')) return null;
        return fs.readFile(path.join(flags.uploads, k)).then((b) => new Uint8Array(b), () => null);
      }
    : null;
  const { fetched, failed } = await fetchImages(net, job.images, {
    local,
    onProgress: (p) => {
      if (p.done === p.total || p.done - last >= 25) {
        last = p.done;
        log(`  pictures: ${p.done}/${p.total} (${fmtBytes(p.bytes)}${p.failed ? `, ${p.failed} failed` : ''})`);
      }
    },
  });
  const out = job.finish(fetched);

  const blogText = blogJsonText(makeBlogJson(flags.repo, { ...out.blog, domain: flags.domain || defaultDomain(flags.repo) }));
  validateBlog(blogText);
  // the images folder is beside the blog when the blog has a folder of its own, inside it when it does not
  const imagesDir = place.folder ? path.join(dir, '..', 'images') : path.join(dir, 'images');
  const write = async (file, content) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  };
  await write(path.join(dir, 'blog.json'), blogText);
  for (const f of out.files) await write(path.join(dir, f.path), f.text);
  for (const a of out.assets) await write(path.join(imagesDir, a.path), a.bytes);

  const s = out.summary;
  log(`wrote ${s.posts} posts, ${s.drafts} drafts, ${s.pages} pages, ${s.comments} comments, ${s.images} pictures and ${s.files} files (${fmtBytes(s.imageBytes)}) to ${path.resolve(dir)}`);
  if (s.imagesFailed) {
    log(`${s.imagesFailed} pictures and files could not be fetched and stay linked to the old site:`);
    for (const [url, why] of [...failed].slice(0, 10)) log(`  ${url}: ${why}`);
  }
  const byText = new Map();
  for (const n of out.notes) byText.set(n.text, (byText.get(n.text) || 0) + 1);
  for (const [text, n] of byText) log(`note: ${text}${n > 1 ? ` (${n} files)` : ''}`);
  if (Object.keys(s.skipped).length) log(`not imported: ${Object.entries(s.skipped).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  log(`next: commit and push the pictures (${path.relative('.', imagesDir) || 'images'}/) and blog.json first, then run  blog-webcli pin ${dir}  and  blog-webcli build ${dir}  (the pin is the commit the pictures are in)`);
  return 0;
}

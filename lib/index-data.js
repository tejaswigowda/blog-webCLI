// Reading index/posts.json back: one file, or for a big blog a manifest and the shards it lists (see indexData in lib/blog.js).
// The result is always the same shape, a version-2 index with `posts` in the recorded order, so nothing that reads the index
// has to know how it was written. Pure: the caller says how to fetch a file.

// read(path) -> Promise<string | null>. -> the index, or null when there is none. Throws when a listed shard is missing.
export async function readIndex(read) {
  const text = await read('index/posts.json');
  if (text === null || text === undefined) return null;
  const doc = JSON.parse(text);
  if (!Array.isArray(doc.shards)) return doc;
  const parts = await Promise.all(doc.shards.map(async (name) => {
    const t = await read(name);
    if (t === null || t === undefined) throw new Error(`${name} is listed by the index and is missing`);
    return JSON.parse(t).posts || [];
  }));
  const bySlug = new Map(parts.flat().map((e) => [e.slug, e]));
  const posts = (doc.sequence || []).map((s) => {
    if (!bySlug.has(s)) throw new Error(`the index names "${s}" and no shard has it`);
    return bySlug.get(s);
  });
  const { shards, ...rest } = doc;
  return { ...rest, posts };
}

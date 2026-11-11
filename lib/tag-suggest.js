// Suggesting a post's tags from the blog's existing ones, as the author types a comma-separated list. Pure.

// -> [{ tag, count }] most used first; a tag spelled two ways ("Video", "video") is one, under its commonest spelling
export function tagCounts(entries) {
  const byKey = new Map();
  for (const e of entries || []) {
    for (const t of e.tags || []) {
      const label = String(t).trim();
      if (!label) continue;
      const k = label.toLowerCase();
      const cur = byKey.get(k) || { count: 0, spellings: new Map() };
      cur.count++;
      cur.spellings.set(label, (cur.spellings.get(label) || 0) + 1);
      byKey.set(k, cur);
    }
  }
  return [...byKey.values()]
    .map((v) => ({ tag: [...v.spellings].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0], count: v.count }))
    .sort((a, b) => b.count - a.count || (a.tag.toLowerCase() < b.tag.toLowerCase() ? -1 : 1));
}

// value: the field as typed, "video, gi". The word being typed is the part after the last comma; tags already in the list are not offered again,
// and a tag that is exactly what has been typed is not offered (there is nothing to complete). Tags that start with the word come before ones that contain it.
export function suggestTags(entries, value, limit = 8) {
  const parts = String(value).split(',');
  const word = parts.pop().trim().toLowerCase();
  const used = new Set(parts.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const out = tagCounts(entries).filter(({ tag }) => {
    const k = tag.toLowerCase();
    return !used.has(k) && k !== word && (word === '' || k.includes(word));
  });
  const starts = out.filter(({ tag }) => tag.toLowerCase().startsWith(word));
  return [...starts, ...out.filter((x) => !starts.includes(x))].slice(0, limit);
}

// "video, gi" + "git" -> "video, git, "
export function completeTag(value, tag) {
  const i = String(value).lastIndexOf(',');
  return `${i < 0 ? '' : `${value.slice(0, i + 1).trimEnd()} `}${tag}, `;
}

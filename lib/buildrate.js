// GitHub Pages soft-limits builds to roughly ten an hour, and past that builds simply do not happen: no
// error, nothing. Every commit to the publishing branch is a build, so the editor counts its own in the
// trailing hour and speaks up before the limit, not after. Pure: storage and the clock are passed in.
export const WINDOW_MS = 60 * 60 * 1000;
export const SOFT_LIMIT = 10;
export const WARN_AT = 8; // the build this publish would be, from which the author is told

const key = (repo) => `blog.webcli.builds:${repo}`;

export function recentBuilds(storage, repo, now = Date.now()) {
  try {
    const list = JSON.parse(storage.getItem(key(repo)) || '[]');
    return Array.isArray(list) ? list.filter((t) => Number.isFinite(t) && now - t < WINDOW_MS) : [];
  } catch {
    return [];
  }
}

export function noteBuild(storage, repo, now = Date.now()) {
  try {
    storage.setItem(key(repo), JSON.stringify([...recentBuilds(storage, repo, now), now]));
  } catch {
    /* storage is blocked or full: the count is a courtesy */
  }
}

// count: builds already made in the last hour. The publish being planned would be build count + 1.
export function assessBuilds(count) {
  const upcoming = count + 1;
  const level = count >= SOFT_LIMIT ? 'limit' : upcoming >= WARN_AT ? 'warn' : 'ok';
  return { level, count, upcoming };
}

// readersSeeIt: the blog serves fresh content itself (lib/live.js), so what is committed is visible to
// readers whether or not a build runs.
export function describeBuilds(a, { readersSeeIt = false } = {}) {
  if (a.level === 'ok') return '';
  const meanwhile = readersSeeIt
    ? 'Readers still see what you publish: their pages check the repository itself. Link previews and search engines wait for a build.'
    : 'Until a build runs, readers will not see changes.';
  if (a.level === 'limit') return `${a.count} builds in the last hour: GitHub Pages has probably stopped building until the hour is up (it allows about ${SOFT_LIMIT}). ${meanwhile}`;
  return `This publish would be build ${a.upcoming} in the last hour. GitHub Pages builds at most about ${SOFT_LIMIT} an hour, and past that builds quietly do not happen. ${meanwhile}`;
}

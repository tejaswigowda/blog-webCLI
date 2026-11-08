// Scheduled publishing. A scheduled post is a draft with a time: `status: scheduled` and `publish_at: YYYY-MM-DDTHH:MM`.
// publish_at is a wall clock in blog.json's "timezone" (UTC with none) and is compared with *now*, so unlike `date` it is a real
// instant. It never becomes `date`, and it is removed when the post publishes.
import { Refusal } from './errors.js';
import { splitFile, joinFile, parseMeta, setMeta } from './frontmatter.js';

export const SCHEDULE_WARN_DAYS = 50; // GitHub disables scheduled workflows in a quiet public repository after 60 days

export function validateTimezone(b) {
  if (b.timezone === undefined) return;
  let ok = typeof b.timezone === 'string' && b.timezone.trim() !== '';
  if (ok) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: b.timezone });
    } catch {
      ok = false;
    }
  }
  if (!ok) throw new Refusal('bad-blog-json', 'timezone must be an IANA zone name like America/Phoenix (it is used only to read publish_at)');
}

export const zoneOf = (blog) => (blog && blog.timezone) || 'UTC';

// How far the zone's wall clock is ahead of UTC at an instant, in ms.
function offsetAt(ms, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(ms / 1000) * 1000;
}

// The instant (ms since the epoch) at which a wall clock "YYYY-MM-DDTHH:MM" shows in a zone. A repeated time resolves to its first occurrence.
export function instantOf(local, zone = 'UTC') {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Refusal('bad-frontmatter', `publish_at "${local}" must be YYYY-MM-DDTHH:MM`);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const guess = wall - offsetAt(wall, zone);
  return Math.min(guess, wall - offsetAt(guess, zone));
}

export const isDue = (meta, blog, now = Date.now()) => meta.status === 'scheduled' && instantOf(meta.publish_at, zoneOf(blog)) <= now;
export const daysUntil = (meta, blog, now = Date.now()) => (instantOf(meta.publish_at, zoneOf(blog)) - now) / 86400000;

// The scheduled posts among { path, text } files, with the ones whose time has come.
export function dueOf(files, blog, now = Date.now()) {
  const due = [];
  for (const f of files) {
    if (!/^posts\/[^/]+\.md$/.test(f.path)) continue;
    let meta;
    try {
      meta = parseMeta(splitFile(f.text.replace(/\r\n/g, '\n'), f.path).front, f.path);
    } catch {
      continue; // a malformed file is refused, with its reason, where the site is generated
    }
    if (meta.status === 'scheduled' && typeof meta.publish_at === 'string' && isDue(meta, blog, now)) due.push(f.path);
  }
  return due.sort();
}

// The file as it is once published: status flipped, publish_at gone, `date` untouched.
export function publishText(text, where) {
  const { front, body } = splitFile(text.replace(/\r\n/g, '\n'), where);
  return joinFile(setMeta(setMeta(front, 'status', 'published'), 'publish_at', null), body);
}

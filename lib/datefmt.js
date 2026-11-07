// How a post's date reads on a page: "November 5, 2026" rather than "2026-11-05". Formatting is by moment.js (vendored,
// MIT; see cli/build-live.js for the module it is given), and the same module is imported by the generator, the live
// renderer and the /blog/ reader, so a date reads the same wherever the page was made.
// A post's date is a calendar day the author wrote, so it is read as that day in UTC and formatted with a fixed locale:
// the clock, the reader's time zone and their language never change a generated page (CI regenerates it byte for byte).
// The machine-readable date stays ISO in the page (<time datetime>, the feed, the sitemap, JSON-LD); this is only the text.
import moment from '../vendor/moment/moment.esm.js';
import { Refusal } from './errors.js';

export const DEFAULT_DATE_FORMAT = 'MMMM D, YYYY';
const ISO_DAY = 'YYYY-MM-DD';

export const dateFormatOf = (blog) => (blog && typeof blog.dateFormat === 'string' && blog.dateFormat) || DEFAULT_DATE_FORMAT;

// A date that is not a calendar day is shown as written, never as "Invalid date".
export function formatDate(iso, format = DEFAULT_DATE_FORMAT) {
  const m = moment.utc(String(iso), ISO_DAY, true).locale('en');
  return m.isValid() ? m.format(format) : String(iso);
}

export const dateLabel = (blog, iso) => formatDate(iso, dateFormatOf(blog));

// blog.json "dateFormat": any moment.js format ("MMM D, YYYY", "dddd, MMMM Do YYYY", "D MMMM YYYY", "[Posted] LL").
export function validateDateFormat(f) {
  if (typeof f !== 'string' || !f.trim() || f.length > 40) throw new Refusal('bad-blog-json', 'dateFormat must be a moment.js format of up to 40 characters, like "MMMM D, YYYY"');
  if (!formatDate('2026-01-02', f).trim()) throw new Refusal('bad-blog-json', `dateFormat "${f}" does not make a date (try "MMMM D, YYYY")`);
}

export const DATE_FORMAT_EXAMPLES = ['MMMM D, YYYY', 'MMM D, YYYY', 'D MMMM YYYY', 'dddd, MMMM Do, YYYY', 'YYYY-MM-DD'];

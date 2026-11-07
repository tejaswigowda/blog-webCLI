// Dates a person can read. A post's date is a calendar day the author wrote (YYYY-MM-DD), so it is
// compared by day, never by the hour: "Today", "Yesterday", "3 days ago", then "Oct 12" or "Oct 12, 2025".
// Only the app shows these. Generated pages keep the ISO date, so a published page does not change
// with the clock and CI can still regenerate it byte for byte.
// moment.js is vendored (vendor/moment, MIT): the page's CSP allows scripts from this origin only.
let loading = null;

export function loadMoment() {
  if (window.moment) return Promise.resolve(window.moment);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/moment/moment.min.js';
      s.onload = () => resolve(window.moment);
      s.onerror = () => reject(new Error('Could not load vendor/moment/moment.min.js'));
      document.head.append(s);
    });
  }
  return loading;
}

const ISO_DAY = 'YYYY-MM-DD';
const RELATIVE_DAYS = 30; // beyond this a date reads better as a date than as "2 months ago"

// today in the reader's own time zone (not UTC, which is already tomorrow in the evening in the Americas)
export const today = () => (window.moment ? window.moment().format(ISO_DAY) : new Date().toISOString().slice(0, 10));
// the time of day in the same zone, to order a new post among the others of its day
export const nowTime = () => (window.moment ? window.moment().format('HH:mm') : new Date().toTimeString().slice(0, 5));

// { label, full, relative } for a YYYY-MM-DD string; anything else is returned as written
export function describeDate(iso, now = window.moment && window.moment()) {
  const m = window.moment ? window.moment(String(iso || '').slice(0, 10), ISO_DAY, true) : null;
  if (!m || !m.isValid()) return { label: String(iso || ''), full: String(iso || ''), relative: '' };
  const start = now.clone().startOf('day');
  const days = m.diff(start, 'days');
  const full = m.format('dddd, MMMM D, YYYY');
  let relative = '';
  if (days === 0) relative = 'Today';
  else if (days === -1) relative = 'Yesterday';
  else if (days === 1) relative = 'Tomorrow';
  else if (Math.abs(days) <= RELATIVE_DAYS) relative = m.from(start);
  const label = relative || m.format(m.year() === now.year() ? 'MMM D' : 'MMM D, YYYY');
  return { label, full, relative };
}

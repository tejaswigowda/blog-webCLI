// "Sign in with GitHub": the browser half of a GitHub App's web flow. The app is a GitHub App, so what it gets is a user-to-server token
// (ghu_…) that can act only on the repositories the user installed the app on, with only the permissions the app declares: the same
// reach as a fine-grained token, chosen on GitHub's own page and changeable there. The one thing a static page cannot do is exchange
// the returned code for a token (that needs the app's client secret, and GitHub's token endpoint sends no CORS headers), so a small
// exchange proxy (templates/oauth-worker) does only that. Pure: the caller supplies fetch, storage and the clock.
import { Refusal } from '../lib/errors.js';

export const AUTHORIZE = 'https://github.com/login/oauth/authorize';
export const OAUTH_PERMISSIONS = Object.freeze(['Contents: Read and write', 'Pull requests: Read and write', 'Pages: Read-only', 'Metadata: Read-only']);
const SKEW_MS = 5 * 60 * 1000; // refresh a token that has less than this left

export const oauthConfigured = (c) => !!(c && /^[A-Za-z0-9._-]{8,}$/.test(c.clientId || '') && /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(c.proxy || ''));

// where GitHub sends the user back to: this page, with no query and no hash (the hash is kept aside and restored)
export const redirectUri = (loc) => `${loc.origin}${loc.pathname}`;

export function newState(crypto = globalThis.crypto) {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function authorizeUrl({ clientId, redirect, state }) {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, state });
  return `${AUTHORIZE}?${q}`;
}

// The installation page: where the user picks which repositories the app may touch.
export const installUrl = (app) => `https://github.com/apps/${encodeURIComponent(app)}/installations/new`;

// -> { code, state } | { installed: true } | { error } | null, from location.search
export function readCallback(search) {
  const q = new URLSearchParams(search);
  if (q.get('error')) return { error: q.get('error_description') || q.get('error') };
  if (q.get('code')) return { code: q.get('code'), state: q.get('state') || '' };
  if (q.get('installation_id')) return { installed: true };
  return null;
}

async function post(fetchFn, proxy, route, body) {
  let res;
  try {
    res = await fetchFn(`${proxy.replace(/\/$/, '')}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error(`The sign-in service could not be reached (${e.message || e}).`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* handled below */
  }
  if (!res.ok || !data || data.error) throw new Error((data && (data.error_description || data.error)) || `The sign-in service answered ${res.status}.`);
  return data;
}

// GitHub's answer -> what is kept. A token with no expiry (the app was set up without expiring tokens) has no `expiresAt`.
export function recordOf(data, now = Date.now()) {
  const token = data.access_token;
  if (typeof token !== 'string' || !/^ghu_/.test(token)) throw new Refusal('classic-token', 'the sign-in service returned something that is not a GitHub App user token (ghu_…). Check the exchange proxy is set up with a GitHub App, not an OAuth App.');
  return { token, refresh: data.refresh_token || null, expiresAt: data.expires_in ? now + data.expires_in * 1000 : null, refreshExpiresAt: data.refresh_token_expires_in ? now + data.refresh_token_expires_in * 1000 : null };
}

export const exchangeCode = async (fetchFn, { proxy, code, redirect }, now) => recordOf(await post(fetchFn, proxy, 'token', { code, redirect_uri: redirect }), now);
export const refreshRecord = async (fetchFn, { proxy, refresh }, now) => recordOf(await post(fetchFn, proxy, 'refresh', { refresh_token: refresh }), now);
export const revokeToken = (fetchFn, { proxy, token }) => post(fetchFn, proxy, 'revoke', { access_token: token }).catch(() => null);

export const needsRefresh = (rec, now = Date.now()) => !!(rec && rec.refresh && rec.expiresAt && rec.expiresAt - now < SKEW_MS);
export const canRefresh = (rec, now = Date.now()) => !!(rec && rec.refresh && (!rec.refreshExpiresAt || rec.refreshExpiresAt > now));

// "Sign in with GitHub": a GitHub App's user token through a tiny exchange proxy. The pure pieces (app/oauth.js), the proxy
// (templates/oauth-worker/worker.js) with GitHub faked, and the wiring in the editor. The token form stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authorizeUrl, canRefresh, exchangeCode, installUrl, needsRefresh, newState, oauthConfigured, readCallback, recordOf, redirectUri, refreshRecord, revokeToken } from '../app/oauth.js';
import { handle } from '../templates/oauth-worker/worker.js';
import { assertToken } from '../app/github.js';
import { config } from '../app/config.js';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const CFG = { clientId: 'Iv1.abcdef123456', proxy: 'https://auth.example.workers.dev', app: 'blog-webcli' };
const ENV = { CLIENT_ID: 'Iv1.abcdef123456', CLIENT_SECRET: 's3cret', ALLOWED_ORIGINS: 'https://blog.webcli.app, http://localhost:5504' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

test('config: off until a client id and an https proxy are set; the shipped config is off', () => {
  assert.equal(oauthConfigured(CFG), true);
  for (const bad of [null, {}, { ...CFG, clientId: '' }, { ...CFG, proxy: '' }, { ...CFG, proxy: 'http://insecure.test' }, { ...CFG, clientId: 'short' }]) assert.equal(oauthConfigured(bad), false, JSON.stringify(bad));
  assert.equal(oauthConfigured(config.oauth), false, 'a fork turns it on by filling app/config.js in');
});

test('the authorize link carries the client, this page (no hash) and an unguessable state; the callback is read, not trusted', () => {
  const a = newState();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, newState());
  assert.equal(redirectUri({ origin: 'https://blog.webcli.app', pathname: '/', hash: '#repo=a/b' }), 'https://blog.webcli.app/');
  const u = new URL(authorizeUrl({ clientId: CFG.clientId, redirect: 'https://blog.webcli.app/', state: a }));
  assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), CFG.clientId);
  assert.equal(u.searchParams.get('redirect_uri'), 'https://blog.webcli.app/');
  assert.equal(u.searchParams.get('state'), a);
  assert.equal(installUrl('blog webcli'), 'https://github.com/apps/blog%20webcli/installations/new');
  assert.deepEqual(readCallback('?code=abc&state=xyz'), { code: 'abc', state: 'xyz' });
  assert.deepEqual(readCallback('?installation_id=5&setup_action=update'), { installed: true });
  assert.deepEqual(readCallback('?error=access_denied&error_description=No'), { error: 'No' });
  assert.equal(readCallback(''), null);
});

test('only a GitHub App user token (ghu_) is kept; expiry and refresh are tracked; a classic token is still refused', () => {
  const now = 1_000_000;
  const rec = recordOf({ access_token: 'ghu_x', refresh_token: 'ghr_y', expires_in: 28800, refresh_token_expires_in: 15811200 }, now);
  assert.deepEqual(rec, { token: 'ghu_x', refresh: 'ghr_y', expiresAt: now + 28_800_000, refreshExpiresAt: now + 15_811_200_000 });
  assert.equal(recordOf({ access_token: 'ghu_x' }, now).expiresAt, null, 'an app set up without expiry');
  for (const bad of ['gho_oauthapptoken', 'ghp_classic', 'github_pat_x', undefined]) assert.throws(() => recordOf({ access_token: bad }), (e) => e.code === 'classic-token');
  assert.equal(needsRefresh(rec, now), false);
  assert.equal(needsRefresh(rec, now + 28_800_000 - 60_000), true, 'under five minutes left');
  assert.equal(needsRefresh({ ...rec, refresh: null }, now + 28_800_000), false, 'nothing to refresh with');
  assert.equal(canRefresh(rec, now), true);
  assert.equal(canRefresh(rec, now + 15_811_200_001), false);
  assert.doesNotThrow(() => assertToken('ghu_abc'));
  assert.throws(() => assertToken('ghp_abc'), (e) => e.code === 'classic-token');
  assert.doesNotThrow(() => assertToken('github_pat_abc'), 'the expert method is unchanged');
});

test('the page talks only to the proxy: it sends a code, never a secret, and reports the proxy\'s refusal', async () => {
  const calls = [];
  const proxy = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith('/token')) return json({ access_token: 'ghu_new', refresh_token: 'ghr_new', expires_in: 28800 });
    if (url.endsWith('/refresh')) return json({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' }, 502);
    return json({});
  };
  const rec = await exchangeCode(proxy, { proxy: CFG.proxy, code: 'c0de', redirect: 'https://blog.webcli.app/' }, 0);
  assert.equal(rec.token, 'ghu_new');
  assert.deepEqual(calls[0], { url: 'https://auth.example.workers.dev/token', body: { code: 'c0de', redirect_uri: 'https://blog.webcli.app/' } });
  await assert.rejects(refreshRecord(proxy, { proxy: CFG.proxy, refresh: 'old' }, 0), /refresh token passed is incorrect/);
  await assert.rejects(exchangeCode(async () => { throw new Error('offline'); }, { proxy: CFG.proxy, code: 'x', redirect: 'r' }), /could not be reached/);
  assert.equal(await revokeToken(async () => { throw new Error('offline'); }, { proxy: CFG.proxy, token: 'ghu_x' }), null, 'signing out never fails because the proxy is down');
});

const call = (route, body, { origin = 'https://blog.webcli.app', method = 'POST', github } = {}) =>
  handle(new Request(`https://auth.example.workers.dev${route}`, { method, headers: { origin, 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined }), ENV, github || (async () => json({})));

test('proxy: the secret stays in the proxy; only listed origins are served; the code goes to GitHub with the client id and secret', async () => {
  const seen = [];
  const github = async (url, init) => { seen.push({ url: String(url), init }); return json({ access_token: 'ghu_ok', token_type: 'bearer' }); };
  const ok = await call('/token', { code: 'c0de', redirect_uri: 'https://blog.webcli.app/' }, { github });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://blog.webcli.app');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal((await ok.json()).access_token, 'ghu_ok');
  assert.equal(seen[0].url, 'https://github.com/login/oauth/access_token');
  const sent = new URLSearchParams(seen[0].init.body);
  assert.equal(sent.get('client_id'), ENV.CLIENT_ID);
  assert.equal(sent.get('client_secret'), 's3cret');
  assert.equal(sent.get('code'), 'c0de');
  assert.ok(!JSON.stringify(await (await call('/token', { code: 'c', redirect_uri: 'https://blog.webcli.app/' }, { github })).json()).includes('s3cret'), 'the secret is never echoed');
  const refreshed = [];
  await call('/refresh', { refresh_token: 'ghr_1' }, { github: async (u, i) => (refreshed.push(new URLSearchParams(i.body)), json({ access_token: 'ghu_2' })) });
  assert.equal(refreshed[0].get('grant_type'), 'refresh_token');
  assert.equal(refreshed[0].get('refresh_token'), 'ghr_1');
  const revoked = [];
  const r = await call('/revoke', { access_token: 'ghu_1' }, { github: async (u, i) => (revoked.push({ u: String(u), method: i.method }), new Response(null, { status: 204 })) });
  assert.equal(r.status, 200);
  assert.deepEqual(revoked, [{ u: `https://api.github.com/applications/${ENV.CLIENT_ID}/token`, method: 'DELETE' }]);
});

test('proxy: refuses other origins, other methods, other routes, malformed bodies, and a code returned to another site', async () => {
  const never = async () => { throw new Error('GitHub must not be called'); };
  assert.equal((await call('/token', { code: 'c', redirect_uri: 'https://blog.webcli.app/' }, { origin: 'https://evil.test', github: never })).status, 403);
  assert.equal((await call('/token', { code: 'c', redirect_uri: 'https://blog.webcli.app/' }, { origin: '', github: never })).status, 403);
  assert.equal((await call('/token', { code: 'c', redirect_uri: 'https://evil.test/' }, { github: never })).status, 400, 'a code bound for another site is not exchanged');
  assert.equal((await call('/token', { redirect_uri: 'https://blog.webcli.app/' }, { github: never })).status, 400);
  assert.equal((await call('/refresh', {}, { github: never })).status, 400);
  assert.equal((await call('/nope', {}, { github: never })).status, 404);
  assert.equal((await call('/token', null, { method: 'GET', github: never })).status, 405);
  const pre = await call('/token', null, { method: 'OPTIONS', github: never });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://blog.webcli.app');
  assert.equal((await handle(new Request('https://x.test/token', { method: 'POST', headers: { origin: 'https://blog.webcli.app' }, body: 'not json' }), ENV, never)).status, 400);
});

test('editor: the token form stays (under "Use a token instead"), the button is shown only when configured, and sign-out revokes', async () => {
  const app = await fs.readFile(path.join(root, 'app/app.js'), 'utf8');
  assert.match(app, /fine-grained personal access token/, 'the expert method is still there');
  assert.match(app, /Use a token instead/);
  assert.match(app, /Sign in with GitHub/);
  assert.match(app, /const oauthOn = oauthConfigured\(config\.oauth\)/);
  assert.match(app, /revokeToken\(oauthFetch/);
  assert.match(app, /pending\.state !== cb\.state/, 'a callback this tab did not start is ignored');
  const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /connect-src 'self' https:/, 'the proxy is an https address the CSP already allows');
  assert.ok(!/client_secret|CLIENT_SECRET/.test(app + (await fs.readFile(path.join(root, 'app/oauth.js'), 'utf8'))), 'no secret in anything the browser loads');
});

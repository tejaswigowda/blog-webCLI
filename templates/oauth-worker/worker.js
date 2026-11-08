// The exchange proxy for "Sign in with GitHub" (Cloudflare Worker; the handler is plain fetch-API code and runs anywhere).
// It holds the GitHub App's client secret and does exactly three things for the editor page, and nothing else:
//   POST /token    { code, redirect_uri }  -> GitHub's token answer
//   POST /refresh  { refresh_token }       -> GitHub's token answer
//   POST /revoke   { access_token }        -> {} (the token stops working at once)
// It stores nothing, logs nothing and never sees a repository. Only the origins in ALLOWED_ORIGINS may call it.
// Secrets/vars: CLIENT_ID, CLIENT_SECRET (secret), ALLOWED_ORIGINS (comma separated, e.g. https://blog.webcli.app).
const GITHUB = 'https://github.com';

const cors = (origin) => ({ 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600', vary: 'origin' });
const reply = (body, status, origin) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(origin ? cors(origin) : {}) } });

export async function handle(request, env, fetchFn = fetch) {
  const origin = request.headers.get('origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return reply({ error: 'origin_not_allowed' }, 403, null);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, origin);
  const route = new URL(request.url).pathname.replace(/\/+$/, '');
  let body;
  try {
    body = await request.json();
  } catch {
    return reply({ error: 'bad_request' }, 400, origin);
  }
  const text = (v) => (typeof v === 'string' && v.length > 0 && v.length < 600 ? v : null);
  const form = (params) => fetchFn(`${GITHUB}/login/oauth/access_token`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, ...params }) });

  if (route === '/token') {
    const code = text(body.code);
    const redirect = text(body.redirect_uri);
    // the page GitHub sends the user back to must be one of the allowed origins, so a stolen code cannot be exchanged for another site
    if (!code || !redirect || !allowed.includes(new URL(redirect, 'https://invalid.invalid').origin)) return reply({ error: 'bad_request' }, 400, origin);
    const res = await form({ code, redirect_uri: redirect });
    return reply(await res.json(), res.ok ? 200 : 502, origin);
  }
  if (route === '/refresh') {
    const refresh = text(body.refresh_token);
    if (!refresh) return reply({ error: 'bad_request' }, 400, origin);
    const res = await form({ grant_type: 'refresh_token', refresh_token: refresh });
    return reply(await res.json(), res.ok ? 200 : 502, origin);
  }
  if (route === '/revoke') {
    const token = text(body.access_token);
    if (!token) return reply({ error: 'bad_request' }, 400, origin);
    const res = await fetchFn(`https://api.github.com/applications/${encodeURIComponent(env.CLIENT_ID)}/token`, {
      method: 'DELETE',
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'blog-webcli-oauth', authorization: `Basic ${btoa(`${env.CLIENT_ID}:${env.CLIENT_SECRET}`)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: token }),
    });
    return reply(res.status === 204 || res.status === 404 ? {} : { error: 'revoke_failed' }, res.status === 204 || res.status === 404 ? 200 : 502, origin);
  }
  return reply({ error: 'not_found' }, 404, origin);
}

export default { fetch: (request, env) => handle(request, env) };

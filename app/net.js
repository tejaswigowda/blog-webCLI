// Every byte this app moves goes through here, so the egress ledger is not a promise
// but a count. `uploaded` increases only for non-GET requests; `read` covers listing
// and rendering (responses of every request).
const enc = new TextEncoder();

export function bodyLength(body) {
  if (body == null) return 0;
  if (typeof body === 'string') return enc.encode(body).length;
  return body.byteLength ?? body.size ?? 0;
}

export function createNet(fetchImpl = (...a) => globalThis.fetch(...a)) {
  const ledger = { read: { bytes: 0, requests: 0 }, uploaded: { bytes: 0, requests: 0 }, log: [] };
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(ledger));

  async function request(url, { method = 'GET', headers = {}, body } = {}) {
    const up = method === 'GET' || method === 'HEAD' ? 0 : bodyLength(body);
    if (up) {
      ledger.uploaded.bytes += up;
      ledger.uploaded.requests += 1;
    }
    // GitHub serves branch heads with max-age=60: a cached head makes the next commit a non-fast-forward.
    const res = await fetchImpl(url, { method, headers, body, cache: 'no-store' });
    const bytes = new Uint8Array(await res.arrayBuffer());
    ledger.read.bytes += bytes.length;
    ledger.read.requests += 1;
    ledger.log.push({ method, url: String(url).replace(/\?.*$/, ''), up, down: bytes.length, status: res.status });
    if (ledger.log.length > 500) ledger.log.shift();
    emit();
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      bytes,
      text: () => new TextDecoder().decode(bytes),
      json: () => JSON.parse(new TextDecoder().decode(bytes)),
    };
  }

  // Another site's file (a WordPress image or its REST API): read-only, never given a token, a cookie or a referrer, and
  // refused unless it is an https address (or this machine, for testing). Counted in the ledger like every other read.
  async function fetchRemote(url, { max = Infinity } = {}) {
    let u;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`"${url}" is not a web address`);
    }
    const loopback = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
    if (u.protocol !== 'https:' && !loopback) throw new Error('only https addresses can be read');
    const res = await fetchImpl(u.href, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow' });
    const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) throw new Error(`it is ${fmtBytes(declared)}, more than the ${fmtBytes(max)} allowed`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    ledger.read.bytes += bytes.length;
    ledger.read.requests += 1;
    ledger.log.push({ method: 'GET', url: `${u.origin}${u.pathname}`, up: 0, down: bytes.length, status: res.status });
    if (ledger.log.length > 500) ledger.log.shift();
    emit();
    if (bytes.length > max) throw new Error(`it is ${fmtBytes(bytes.length)}, more than the ${fmtBytes(max)} allowed`);
    return { status: res.status, ok: res.ok, headers: res.headers, bytes, text: () => new TextDecoder().decode(bytes), json: () => JSON.parse(new TextDecoder().decode(bytes)) };
  }

  return { request, fetchRemote, ledger, subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)) };
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

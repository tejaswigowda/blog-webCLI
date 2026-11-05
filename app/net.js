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

  return { request, ledger, subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)) };
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

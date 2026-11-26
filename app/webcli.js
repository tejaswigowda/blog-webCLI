export function parseRunParams(search, hash) {
  const query = new URLSearchParams(search);
  const fragment = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const get = key => fragment.has(key) ? fragment.get(key) : query.get(key);
  if (!fragment.has('run') && !query.has('run')) return null;
  if (get('run') !== 'render') throw new Error(`Unknown run=${get('run')}.`);
  const src = get('src');
  const markdown = get('markdown');
  if (!src && markdown === null) throw new Error('run=render requires src or markdown.');
  const format = get('format') ?? 'HTML';
  if (format !== 'HTML') throw new Error('run=render only supports format=HTML.');
  const download = get('download');
  if (download !== null && download !== '1') throw new Error('download must be 1 when specified.');
  return { run: 'render', src, markdown, format, download: download === '1' };
}

export async function fetchInput(src, base, fetchImpl = fetch) {
  const url = new URL(src, base);
  if (!['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) {
    throw new Error('src must be an HTTP(S), data, or blob URL.');
  }
  const response = await fetchImpl(url.href, { method: 'GET', credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`Input GET failed: ${response.status} ${response.statusText}`.trim());
  const bytes = await response.arrayBuffer();
  const name = ['http:', 'https:'].includes(url.protocol)
    ? decodeURIComponent(url.pathname.split('/').pop() || '') : '';
  return { name: name || 'input.md', bytes };
}

export function makeHtmlArtifact(html, name = 'render.html') {
  const bytes = new TextEncoder().encode(html);
  const artifact = { mime: 'text/html', name, size: bytes.byteLength };
  let dataUrl;
  Object.defineProperty(artifact, 'dataUrl', {
    enumerable: true,
    get() {
      if (!dataUrl) {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        dataUrl = `data:text/html;base64,${btoa(binary)}`;
      }
      return dataUrl;
    },
  });
  return artifact;
}

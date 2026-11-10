// The pixel size of a PNG, JPEG, GIF or WebP, read from its first bytes, and where assets.lock.json keeps it. An <img> that
// carries width and height lets the browser reserve its box before the file arrives, which is what keeps the page from shifting.
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

export function imageSize(b) {
  if (!b || b.length < 24) return null;
  let w = 0;
  let h = 0;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    w = u32(b, 16);
    h = u32(b, 20);
  } else if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    w = b[6] | (b[7] << 8);
    h = b[8] | (b[9] << 8);
  } else if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        h = (b[i + 5] << 8) | b[i + 6];
        w = (b[i + 7] << 8) | b[i + 8];
        break;
      }
      i += 2 + len;
    }
  } else if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const t = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (t === 'VP8 ') {
      w = (b[26] | (b[27] << 8)) & 0x3fff;
      h = (b[28] | (b[29] << 8)) & 0x3fff;
    } else if (t === 'VP8L') {
      const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      w = (v & 0x3fff) + 1;
      h = ((v >>> 14) & 0x3fff) + 1;
    } else if (t === 'VP8X') {
      w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
      h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
    }
  }
  return w > 0 && h > 0 && w <= 65535 && h <= 65535 ? { width: w, height: h } : null;
}

export const sizeKey = (key, path) => `${key}/${path}#size`;
export const sizeValue = ({ width, height }) => `${width}x${height}`;

// -> { width, height } for an asset ref's lock entries, or null when the lock does not know it
export function sizeIn(lock, lockKeyOfRef) {
  const v = lock && lock[`${lockKeyOfRef}#size`];
  const m = typeof v === 'string' ? /^(\d{1,5})x(\d{1,5})$/.exec(v) : null;
  return m && +m[1] > 0 && +m[2] > 0 ? { width: +m[1], height: +m[2] } : null;
}

// the lock entries to add for an uploaded file: {} when its size cannot be read
export function sizeEntry(key, path, bytes) {
  const s = imageSize(bytes);
  return s ? { [sizeKey(key, path)]: sizeValue(s) } : {};
}

// A minimal zip reader (stored and deflate entries), enough to unpack a wordpress.org theme.
// It refuses path traversal and zip bombs: the archive comes from the network.
import zlib from 'node:zlib';

const MAX_ENTRIES = 5000;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 60 * 1024 * 1024;

export function readZip(bytes) {
  const buf = Buffer.from(bytes);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error(`the archive has ${count} entries; the limit is ${MAX_ENTRIES}`);
  const files = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (name.startsWith('/') || name.split('/').some((s) => s === '..') || name.includes('\\')) throw new Error(`the archive contains an unsafe path: ${name}`);
    if (usize > MAX_FILE) throw new Error(`${name} is ${usize} bytes; the limit is ${MAX_FILE}`);
    total += usize;
    if (total > MAX_TOTAL) throw new Error('the archive is too large when unpacked');
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('corrupt zip entry');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_FILE });
    else throw new Error(`${name} uses compression method ${method}, which is not supported`);
    if (data.length !== usize) throw new Error(`${name} does not match its recorded size`);
    files.set(name, new Uint8Array(data));
  }
  return files;
}

// For tests: a stored (uncompressed) zip.
export function writeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const crc = (b) => zlib.crc32(b) >>> 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc(data), 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nm.length, 26);
    parts.push(lh, nm, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc(data), 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nm);
    offset += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}

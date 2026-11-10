/**
 * A minimal ZIP writer: stored entries, no compression.
 *
 * A CBZ is a ZIP of images, and this app only ever needs to *make* one — for a chapter exported into
 * another app's download folder. Stored (method 0) entries are valid ZIP and valid CBZ; the file is
 * bigger than a deflated one, and every reader Mihon uses opens it. Compression would mean shipping a
 * deflate encoder for a saving that the phone's own storage policy does not ask for.
 *
 * Sizes are known before anything is written, so no data descriptors and no seeking are needed: build
 * the bytes in one pass and hand back a single array.
 */

/** CRC-32 (IEEE 802.3), the one ZIP requires. Table built once per call site. */
let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      table[index] = value >>> 0;
    }
    crcTable = table;
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] as number);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

function dosDateTime(when: Date): { time: number; date: number } {
  const time = ((when.getHours() & 0x1f) << 11) | ((when.getMinutes() & 0x3f) << 5) | ((when.getSeconds() / 2) & 0x1f);
  const date = (((when.getFullYear() - 1980) & 0x7f) << 9) | (((when.getMonth() + 1) & 0x0f) << 5) | (when.getDate() & 0x1f);
  return { time, date };
}

const encoder = new TextEncoder();

/**
 * Build a ZIP from named entries.
 *
 * Names are stored as UTF-8 with the language-encoding flag (bit 11) set, so a chapter whose pages
 * are named with non-ASCII characters keeps them. Entry order is the caller's — for a CBZ that is
 * page order, which is how a reader that ignores names still reads the chapter correctly.
 */
export function writeZip(entries: ReadonlyArray<ZipEntry>, when: Date = new Date()): Uint8Array {
  const { time, date } = dosDateTime(when);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);
    const size = entry.bytes.length;

    const local = new Uint8Array(30 + name.length + size);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true); // version needed: 2.0
    localView.setUint16(6, 0x0800, true); // UTF-8 names
    localView.setUint16(8, 0, true); // stored
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, size, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(entry.bytes, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint16(30, 0, true); // extra
    centralView.setUint16(32, 0, true); // comment
    centralView.setUint16(34, 0, true); // disk
    centralView.setUint16(36, 0, true); // internal attrs
    centralView.setUint32(38, 0, true); // external attrs
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

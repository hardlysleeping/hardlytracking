/**
 * Reading one page out of a ZIP without unpacking the rest.
 *
 * `unzipSync` on a 400-page CBZ allocates every scan at once — the reader then holds a whole book in
 * memory to draw page one. So this reads the central directory (which is a small index at the end of
 * the file), remembers where each entry's bytes live, and inflates exactly one entry when asked.
 *
 * Only the two storage methods a comic archive uses are handled: stored (0) and deflate (8). A ZIP64
 * archive (over 4 GB, or over 65 535 entries) is refused by name rather than misread, because a wrong
 * offset is a silent page of garbage.
 */
import { inflateSync } from "fflate";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export interface ZipEntry {
  name: string;
  /** Byte offset of the local file header. */
  headerOffset: number;
  compression: number;
  compressedSize: number;
}

export interface Zip {
  names: string[];
  /** One entry's bytes, decompressed. */
  read(name: string): Uint8Array;
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/** The end-of-central-directory record, found by scanning back from the tail. */
function findEnd(bytes: Uint8Array): number {
  const stop = Math.max(0, bytes.length - 66_000); // 64 KiB comment + 22 bytes of record
  for (let at = bytes.length - 22; at >= stop; at -= 1) {
    if (u32(bytes, at) === EOCD) return at;
  }
  throw new Error("this file is not a zip archive");
}

export function openZip(bytes: Uint8Array): Zip {
  const end = findEnd(bytes);
  const count = u16(bytes, end + 10);
  const directoryOffset = u32(bytes, end + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw new Error("this archive is ZIP64 — too large to open here");
  }

  const entries = new Map<string, ZipEntry>();
  let at = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (u32(bytes, at) !== CENTRAL) throw new Error("this zip's index is damaged");
    const compression = u16(bytes, at + 10);
    const compressedSize = u32(bytes, at + 20);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const headerOffset = u32(bytes, at + 42);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, { name, headerOffset, compression, compressedSize });
    at += 46 + nameLength + extraLength + commentLength;
  }

  return {
    names: [...entries.keys()],
    read(name: string): Uint8Array {
      const entry = entries.get(name);
      if (entry === undefined) throw new Error(`no such entry: ${name}`);
      const local = entry.headerOffset;
      if (u32(bytes, local) !== LOCAL) throw new Error(`entry ${name} has no local header`);
      const nameLength = u16(bytes, local + 26);
      const extraLength = u16(bytes, local + 28);
      const start = local + 30 + nameLength + extraLength;
      const raw = bytes.subarray(start, start + entry.compressedSize);
      if (entry.compression === 0) return raw;
      if (entry.compression === 8) return inflateSync(raw);
      throw new Error(`entry ${name} uses an unsupported compression method (${entry.compression})`);
    },
  };
}

/**
 * Enough of the ZIP format to unpack one archive, with no dependency and no external tool.
 *
 * `prepare-runtime.mjs` downloads a ~134 MB release zip from M-Extension-Server on three different
 * operating systems. Shelling out would mean `unzip` on Linux and macOS and `Expand-Archive` on
 * Windows, and the Windows one is PowerShell with its own path handling — three code paths, two of
 * which only run in CI. Node's `zlib` already inflates raw deflate, which is all a zip entry is, so
 * the reader is ~100 lines and identical everywhere.
 *
 * Deliberately not supported, and refused rather than half-done: encryption (the only reason a
 * release zip would have it is a mistake), ZIP64 (the archives are 134 MB, not 4 GB), and
 * multi-disk. An archive that needs any of them throws with the reason.
 */
import { inflateRawSync } from "node:zlib";

const SIGNATURE_EOCD = 0x06054b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_LOCAL = 0x04034b50;

/** Where the central directory starts, found by scanning back from the end. */
function centralDirectoryOffset(buffer) {
  // The end-of-central-directory record is at most 22 + 65535 bytes from the end (the comment is
  // the only variable part).
  const floor = Math.max(0, buffer.length - (22 + 0xffff));
  for (let at = buffer.length - 22; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) !== SIGNATURE_EOCD) continue;
    const entries = buffer.readUInt16LE(at + 10);
    const offset = buffer.readUInt32LE(at + 16);
    const commentLength = buffer.readUInt16LE(at + 20);
    if (at + 22 + commentLength !== buffer.length) continue;
    return { entries, offset };
  }
  throw new Error("not a zip archive: no end-of-central-directory record");
}

/**
 * Every entry in the archive: name, method, sizes, and where its bytes are.
 *
 * A directory entry (name ending in `/`) is reported with `size: 0`; the caller creates it.
 */
export function listZip(buffer) {
  const { entries, offset } = centralDirectoryOffset(buffer);
  const out = [];
  let at = offset;
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(at) !== SIGNATURE_CENTRAL) {
      throw new Error(`corrupt zip: entry ${index} does not start with a central header`);
    }
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");

    if (flags & 0x1) throw new Error(`${name} is encrypted; this reader does not do passwords`);
    if (compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`${name} needs ZIP64, which this reader does not support`);
    }

    out.push({ name, method, compressed, size, localOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** One entry's bytes, inflated if it was deflated. */
export function readZipEntry(buffer, entry) {
  const at = entry.localOffset;
  if (buffer.readUInt32LE(at) !== SIGNATURE_LOCAL) {
    throw new Error(`corrupt zip: ${entry.name} has no local header`);
  }
  const nameLength = buffer.readUInt16LE(at + 26);
  const extraLength = buffer.readUInt16LE(at + 28);
  const start = at + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressed);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`${entry.name} uses compression method ${entry.method}, which is not deflate`);
}

/**
 * Unpack into `targetDir`, keeping only what `filter` accepts.
 *
 * `strip` removes leading path segments: the M-Extension-Server bundle ships `jre/jre/bin/java`, and
 * the app wants `jre/bin/java`. Refuses absolute paths and `..`, because an archive is data from the
 * internet and a name like `../../.ssh/authorized_keys` must never be followed.
 */
export function extractZip(buffer, targetDir, { filter = () => true, strip = 0, writeFile, mkdir } = {}) {
  const written = [];
  for (const entry of listZip(buffer)) {
    const segments = entry.name.split("/").filter((part) => part.length > 0);
    if (segments.some((part) => part === ".." || part === ".") || entry.name.startsWith("/")) {
      throw new Error(`refusing an unsafe path in the archive: ${entry.name}`);
    }
    const relative = segments.slice(strip).join("/");
    if (relative.length === 0) continue;
    if (!filter(relative, entry)) continue;
    const target = `${targetDir}/${relative}`;
    if (entry.name.endsWith("/")) {
      mkdir(target);
      continue;
    }
    writeFile(target, readZipEntry(buffer, entry));
    written.push({ path: relative, size: entry.size });
  }
  return written;
}

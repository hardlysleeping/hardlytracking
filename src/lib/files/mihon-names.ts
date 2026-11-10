/**
 * Mihon's directory names, reproduced exactly — so a chapter we write is one Mihon recognises.
 *
 * These rules are not invented here: they are `DiskUtil.buildValidFilename` and the `ChapterDirNameParts`
 * class in `mihonapp/mihon` (`core/common/.../util/storage/DiskUtil.kt` and
 * `app/.../data/download/DownloadProvider.kt`). The layout is
 * `<downloads>/<source>/<manga title>/<chapter>.cbz`, and Mihon decides whether a chapter is
 * downloaded by matching the *names on disk* against these same rules — so a name that differs by one
 * character is a file Mihon never sees.
 *
 * Three of Mihon's own settings change the answer, and the caller passes what the app is configured
 * with: `disallowNonAscii` (non-ASCII becomes hex), `chapterNameHash` (a `_<md5(url)[0..6]>` suffix),
 * and the scanlator, which is prefixed `"<scanlator>_"`.
 */

/** Mihon's `MAX_FILE_NAME_BYTES`: a FAT filesystem limit, checked in bytes, not characters. */
export const MAX_FILE_NAME_BYTES = 240;

/** Bytes a chapter's name gives up: 7 for the hash suffix and underscore, 4 for `.cbz`. */
export const CHAPTER_NAME_BUDGET = MAX_FILE_NAME_BYTES - 11;

/** Mihon's `isValidFatFilenameChar`, inverted: control characters and the FAT-forbidden set. */
function isValidFatFilenameChar(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  if (code <= 0x1f) return false;
  return !'"*/:<>?\\|\u007f'.includes(character);
}

/**
 * Truncate to a byte count without splitting a character.
 *
 * `TextEncoder` gives the bytes; walking back to a code-point boundary keeps a truncated name valid
 * UTF-16, which is what Mihon's own `truncateToLength` does with a decoder.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return text;
  let cut = maxBytes;
  // UTF-8 continuation bytes are 0b10xxxxxx; step back off one.
  while (cut > 0 && ((encoded[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  return new TextDecoder().decode(encoded.subarray(0, cut));
}

/**
 * `DiskUtil.buildValidFilename`: trim dots and spaces at the edges, hex-encode non-ASCII when asked,
 * replace every invalid character with `_`, and fit inside `maxBytes`.
 *
 * An empty result becomes `(invalid)` rather than an empty folder name, exactly as Mihon does.
 */
export function buildValidFilename(original: string, maxBytes: number = MAX_FILE_NAME_BYTES, disallowNonAscii = false): string {
  const name = original.replace(/^[. ]+|[. ]+$/g, "");
  if (name === "") return "(invalid)";
  let text = "";
  for (const character of name) {
    if (disallowNonAscii && (character.codePointAt(0) ?? 0) >= 0x80) {
      for (const byte of new TextEncoder().encode(character)) text += byte.toString(16).padStart(2, "0");
    } else if (isValidFatFilenameChar(character)) {
      text += character;
    } else {
      text += "_";
    }
  }
  return truncateToBytes(text, maxBytes);
}

/** md5, first six hex characters — Mihon's `ChapterDirNameParts.hashSuffix`. */
export function md5Hex(text: string): string {
  // A compact md5 (RFC 1321). Small, dependency-free, and only ever used for a 6-character suffix.
  const bytes = new TextEncoder().encode(text);
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const k = new Uint32Array(64);
  for (let index = 0; index < 64; index += 1) k[index] = Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32);
  const length = bytes.length;
  const withPadding = new Uint8Array((((length + 8) >> 6) + 1) * 64);
  withPadding.set(bytes);
  withPadding[length] = 0x80;
  const bitLength = length * 8;
  const view = new DataView(withPadding.buffer);
  view.setUint32(withPadding.length - 8, bitLength >>> 0, true);
  view.setUint32(withPadding.length - 4, Math.floor(bitLength / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const words = new Uint32Array(16);

  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      const sum = (a + f + (k[index] as number) + (words[g] as number)) | 0;
      const shift = s[index] as number;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const digest = new Uint8Array(16);
  const out = new DataView(digest.buffer);
  out.setUint32(0, a0 >>> 0, true);
  out.setUint32(4, b0 >>> 0, true);
  out.setUint32(8, c0 >>> 0, true);
  out.setUint32(12, d0 >>> 0, true);
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface ChapterNameInput {
  /** The chapter's name, as Mihon's own DB would hold it. */
  name: string;
  /** Scanlator, when known: Mihon prefixes it as `<scanlator>_<name>`. */
  scanlator?: string | null;
  /** The chapter's URL — only used when `hash` is on. */
  url?: string | null;
  disallowNonAscii?: boolean;
  /** Mihon's `enableChapterNameHash` setting. Off by default there, off here. */
  hash?: boolean;
}

/**
 * The folder (or `.cbz`) name Mihon looks for. `getChapterDirName` / `getValidChapterDirNames`.
 *
 * The scanlator and the name are sanitised *together*, which is what makes `"A_B" + "C"` differ from
 * `"A" + "_B_C"`; the 11-byte budget is Mihon's, because it always reserves room for `.cbz`.
 */
export function mihonChapterDirName(input: ChapterNameInput): string {
  const name = input.name.trim() === "" ? "Chapter" : input.name;
  const scanlator = (input.scanlator ?? "").trim();
  const combined = scanlator === "" ? name : `${scanlator}_${name}`;
  const base = buildValidFilename(combined, CHAPTER_NAME_BUDGET, input.disallowNonAscii === true);
  if (input.hash !== true) return base;
  const suffix = `_${md5Hex(input.url ?? "").slice(0, 6)}`;
  return `${base}${suffix}`;
}

/** The manga folder: `getMangaDirName`. */
export function mihonMangaDirName(title: string, disallowNonAscii = false): string {
  return buildValidFilename(title, MAX_FILE_NAME_BYTES, disallowNonAscii);
}

/** The source folder above it: `getSourceDirName` — the source's own name, not an id. */
export function mihonSourceDirName(sourceName: string, disallowNonAscii = false): string {
  return buildValidFilename(sourceName, MAX_FILE_NAME_BYTES, disallowNonAscii);
}

/** Every name Mihon accepts a chapter under, newest first — folder, then `.cbz`, then legacy forms. */
export function mihonChapterDirNames(input: ChapterNameInput): string[] {
  const base = mihonChapterDirName(input);
  return [base, `${base}.cbz`];
}

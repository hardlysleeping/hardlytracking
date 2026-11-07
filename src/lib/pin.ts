/**
 * The screen curtain's PIN, stored the only way a secret may be stored: as a salted hash.
 *
 * A PIN here is not encryption and not an account credential — it keeps hidden shelves off the
 * screen from somebody glancing at it. But it still travels in exports and in the HardlySync
 * document (the owner asked for one PIN across devices), so nothing in the stored value may be the
 * PIN itself, and nothing here may ever log or return one.
 *
 * Stored form: `sha256:<saltHex>:<hashHex>` — 16 random salt bytes, 32 hash bytes, lowercase hex.
 * Parsing is deliberately defensive: a value this build does not recognise (a foreign row, a
 * truncated copy, a value from a newer format) reads as "no PIN", never as a screen that refuses
 * every attempt and can never be opened again.
 */

/** 4–8 digits: enough to be a deliberate code, short enough to type on a phone. */
export const PIN_MIN = 4;
export const PIN_MAX = 8;

const PIN_PATTERN = new RegExp(`^[0-9]{${PIN_MIN},${PIN_MAX}}$`);
const SCHEME = "sha256";
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const SALT_HEX = SALT_BYTES * 2;
const HASH_HEX = HASH_BYTES * 2;
/** Domain separation, so this digest is not interchangeable with any other SHA-256 of the PIN. */
const DOMAIN = "hardlytracking/pin/v1:";

export interface PinRecord {
  salt: Uint8Array;
  hash: Uint8Array;
}

export function pinValid(pin: unknown): pin is string {
  return typeof pin === "string" && PIN_PATTERN.test(pin);
}

function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Strict hex: an odd length or a non-hex character is a corrupt record, not a hash. */
function bytesOf(text: string): Uint8Array | null {
  if (text.length === 0 || text.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

async function digest(salt: Uint8Array, pin: string): Promise<Uint8Array> {
  const secret = new TextEncoder().encode(DOMAIN + pin);
  const input = new Uint8Array(salt.length + secret.length);
  input.set(salt);
  input.set(secret, salt.length);
  // `buffer` is an ArrayBuffer for a freshly allocated Uint8Array; the cast keeps the newer
  // ArrayBufferLike typing happy without copying the bytes again.
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input.buffer as ArrayBuffer));
}

export async function makePinRecord(pin: string): Promise<string> {
  if (!pinValid(pin)) throw new RangeError(`A PIN is ${PIN_MIN} to ${PIN_MAX} digits`);
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await digest(salt, pin);
  return `${SCHEME}:${hexOf(salt)}:${hexOf(hash)}`;
}

export function parsePinRecord(value: unknown): PinRecord | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(":");
  if (parts.length !== 3) return null;
  const [scheme, saltHex, hashHex] = parts;
  if (scheme !== SCHEME || saltHex.length !== SALT_HEX || hashHex.length !== HASH_HEX) return null;
  const salt = bytesOf(saltHex);
  const hash = bytesOf(hashHex);
  return salt === null || hash === null ? null : { salt, hash };
}

export function hasPin(value: unknown): boolean {
  return parsePinRecord(value) !== null;
}

/**
 * The value to store, or `""` for "no PIN".
 *
 * A recognised record is canonicalised (lowercase hex) and anything else is dropped, so a corrupt
 * row from a bad restore becomes an app that asks for a PIN instead of one that cannot be opened.
 */
export function pinRecordOf(value: unknown): string {
  const parsed = parsePinRecord(value);
  return parsed === null ? "" : `${SCHEME}:${hexOf(parsed.salt)}:${hexOf(parsed.hash)}`;
}

/** Compare every byte, without an early return that would leak how much of the hash matched. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function verifyPin(record: unknown, pin: string): Promise<boolean> {
  const parsed = parsePinRecord(record);
  if (parsed === null || !pinValid(pin)) return false;
  return sameBytes(await digest(parsed.salt, pin), parsed.hash);
}

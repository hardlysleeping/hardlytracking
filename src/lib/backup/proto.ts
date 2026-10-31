/**
 * The protobuf wire format, hand-rolled.
 *
 * A Mihon backup (`.tachibk`) and a Keiyoushi `index.pb` are both protobuf, and the app has to read
 * and write them on a phone with no dependency for it. Only the four wire types either format uses
 * are implemented: varint, 64-bit, length-delimited and 32-bit.
 *
 * **Varints come back as `BigInt`, always.** A Mihon source id is a 19-digit Long
 * (`2499283573021220255`), which is past `Number.MAX_SAFE_INTEGER`; reading it as a number rounds it
 * and the resulting id no longer names the source a library row or a backup mapping expects. Every
 * varint therefore stays exact until a caller explicitly converts it, and the conversions are named
 * so the lossy one is impossible to use by accident.
 */

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_BYTES = 2;
export const WIRE_FIXED32 = 5;

export type WireValue = bigint | Uint8Array | number;

export interface ProtoField {
  no: number;
  wire: number;
  value: WireValue;
}

export class ProtoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtoError";
  }
}

function readVarint(buf: Uint8Array, at: number): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let i = at;
  for (;;) {
    if (i >= buf.length) throw new ProtoError("truncated varint");
    const byte = buf[i];
    i += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, next: i };
    shift += 7n;
    if (shift > 63n) throw new ProtoError("varint longer than 64 bits");
  }
}

/** Every field of a message, in order. Unknown field numbers are returned, not dropped. */
export function readFields(buf: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i);
    i = tag.next;
    const no = Number(tag.value >> 3n);
    const wire = Number(tag.value & 0x7n);
    if (no === 0) throw new ProtoError("invalid field number 0");
    switch (wire) {
      case WIRE_VARINT: {
        const v = readVarint(buf, i);
        out.push({ no, wire, value: v.value });
        i = v.next;
        break;
      }
      case WIRE_FIXED64: {
        if (i + 8 > buf.length) throw new ProtoError("truncated fixed64");
        out.push({ no, wire, value: buf.slice(i, i + 8) });
        i += 8;
        break;
      }
      case WIRE_BYTES: {
        const len = readVarint(buf, i);
        const start = len.next;
        const end = start + Number(len.value);
        if (end > buf.length) throw new ProtoError("truncated length-delimited field");
        out.push({ no, wire, value: buf.slice(start, end) });
        i = end;
        break;
      }
      case WIRE_FIXED32: {
        if (i + 4 > buf.length) throw new ProtoError("truncated fixed32");
        out.push({ no, wire, value: buf.slice(i, i + 4) });
        i += 4;
        break;
      }
      default:
        throw new ProtoError(`unsupported wire type ${wire}`);
    }
  }
  return out;
}

/** A varint as a number — only for values known to be small (flags, counts, ratings). */
export function varintToNumber(value: WireValue): number {
  if (typeof value !== "bigint") throw new ProtoError("not a varint");
  return Number(value);
}

/**
 * A varint as an exact decimal string — the only correct way to read a source id, a manga id or
 * anything else declared as an int64 that names something.
 */
export function varintToString(value: WireValue): string {
  if (typeof value !== "bigint") throw new ProtoError("not a varint");
  return value.toString();
}

/** The text of a length-delimited field. */
export function bytesToString(value: WireValue): string {
  if (!(value instanceof Uint8Array)) throw new ProtoError("not a length-delimited field");
  return new TextDecoder().decode(value);
}

/** A 32-bit float field (Mihon's `chapterNumber`, tracker scores). */
export function fixed32ToFloat(value: WireValue): number {
  if (!(value instanceof Uint8Array) || value.length !== 4) throw new ProtoError("not a fixed32");
  return new DataView(value.buffer, value.byteOffset, 4).getFloat32(0, true);
}

/** A 64-bit float field. */
export function fixed64ToFloat(value: WireValue): number {
  if (!(value instanceof Uint8Array) || value.length !== 8) throw new ProtoError("not a fixed64");
  return new DataView(value.buffer, value.byteOffset, 8).getFloat64(0, true);
}

// ---------------------------------------------------------------------------------------------------
// Writing. Same four wire types; used by the export side.
// ---------------------------------------------------------------------------------------------------

export function writeVarint(value: number | bigint): Uint8Array {
  let v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  if (v < 0n) v += 1n << 64n; // two's complement, the way int64 is encoded
  const bytes: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return new Uint8Array(bytes);
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function tag(no: number, wire: number): Uint8Array {
  return writeVarint((BigInt(no) << 3n) | BigInt(wire));
}

export function fieldVarint(no: number, value: number | bigint): Uint8Array {
  return concat([tag(no, WIRE_VARINT), writeVarint(value)]);
}

export function fieldBool(no: number, value: boolean): Uint8Array {
  return fieldVarint(no, value ? 1 : 0);
}

export function fieldBytes(no: number, value: Uint8Array): Uint8Array {
  return concat([tag(no, WIRE_BYTES), writeVarint(value.length), value]);
}

export function fieldString(no: number, value: string): Uint8Array {
  return fieldBytes(no, new TextEncoder().encode(value));
}

export function fieldFloat(no: number, value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, true);
  return concat([tag(no, WIRE_FIXED32), bytes]);
}

/** A message field: the encoded body of a nested message, with its length prefix. */
export function fieldMessage(no: number, body: Uint8Array): Uint8Array {
  return fieldBytes(no, body);
}

/** Fields grouped by number, for the repeated-field case. */
export function group(fields: ProtoField[]): Map<number, ProtoField[]> {
  const out = new Map<number, ProtoField[]>();
  for (const field of fields) {
    const list = out.get(field.no);
    if (list === undefined) out.set(field.no, [field]);
    else list.push(field);
  }
  return out;
}

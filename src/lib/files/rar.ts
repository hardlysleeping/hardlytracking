/**
 * Reading one page out of a RAR (`.cbr`).
 *
 * RAR is not a format this app can read the way `zip.ts` reads a zip. The entries are coded with
 * RAR's own Huffman/PPM schemes, the format has had two incompatible versions (RAR 1.5 and RAR 5),
 * and the only reference decoder is a large C++ program. So the decoder here *is* unrar, compiled to
 * WebAssembly: `node-unrar-js` wraps RARLAB's own source, which is the same code every comic reader
 * shipping CBR support uses. It is imported lazily, for the same reason pdf.js is — an app that
 * never opens a `.cbr` must not download the wasm.
 *
 * Two facts about that library shape everything below, and neither is guesswork:
 *
 * 1. **The wasm has one decoder instance and its file callbacks read `Module.extractor`** — the
 *    extractor created *last*. Two extractors alive at once therefore read each other's archives.
 *    So exactly one is ever alive: a list or a page builds one, uses it, and drops it. Every call is
 *    funnelled through `oneAtATime`, because the reader can ask for page 1 while a cover is being
 *    made for a second book.
 * 2. **Every extraction starts at the archive's first entry.** For the non-solid archives comic
 *    tools write, that is a walk of headers plus one entry's decompression — cheap. A solid archive
 *    (made with `rar -s`, rare for a comic) costs the pages before it as well: still correct, just
 *    slower, and said here rather than hidden by unpacking the whole file up front the way a naive
 *    `unrar x` would.
 *
 * Names are normalised to `/` because a RAR made on Windows — which is most of them — stores
 * backslashes, while every other path in this app is a URL-shaped string.
 */

export interface Rar {
  /** Every entry, normalised to `/`, in the archive's own order (a RAR has no directory index). */
  names: string[];
  /** One entry's bytes, decompressed. */
  read(name: string): Promise<Uint8Array>;
}

export interface RarOptions {
  /**
   * Where the wasm decoder comes from.
   *
   * In the app it is the file Vite emitted (`?url`), fetched once. A test passes the same bytes
   * straight off disk, so the test exercises the decoder the app ships rather than a stand-in.
   */
  wasm?: () => Promise<ArrayBuffer>;
}

/** One decoder instance, one caller: see (1) in the header. */
let chain: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

let decoder: Promise<ArrayBuffer> | undefined;

/** The decoder, fetched once and kept: it is 600 KB and a wallet of CBRs should pay for it once. */
function packagedWasm(): Promise<ArrayBuffer> {
  decoder ??= (async () => {
    const { default: url } = await import("node-unrar-js/esm/js/unrar.wasm?url");
    const response = await fetch(url);
    if (!response.ok) throw new Error("the RAR decoder is missing from this build");
    return await response.arrayBuffer();
  })();
  return decoder;
}

async function decoderFor(load: () => Promise<ArrayBuffer>, archive: ArrayBuffer) {
  const { createExtractorFromData } = await import("node-unrar-js");
  return await createExtractorFromData({ data: archive, wasmBinary: await load() });
}

/** unrar's error strings, said the way a reader would say them. */
function plainReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/password/i.test(message)) return "this archive needs a password";
  if (/not RAR archive|Unknown archive format|File read error/i.test(message)) return "this file is not a RAR archive";
  if (/damaged|bad data/i.test(message)) return "this RAR archive is damaged";
  return message;
}

/** `Rar!` + the format byte: 0x00 is RAR 1.5/4, 0x01 is RAR 5. Either is a CBR. */
function looksLikeRar(bytes: Uint8Array): boolean {
  const signature = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07];
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

/** The archive's own bytes, without copying when the view is already the whole buffer. */
function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return whole ? (bytes.buffer as ArrayBuffer) : bytes.slice().buffer;
}

export async function openRar(bytes: Uint8Array, options: RarOptions = {}): Promise<Rar> {
  // Said here rather than through unrar: a plain `.zip` renamed to `.cbr` is the common mistake, and
  // "this file is not a RAR archive" answers it better than a read error from inside the decoder.
  if (!looksLikeRar(bytes)) throw new Error("this file is not a RAR archive");
  const load = options.wasm ?? packagedWasm;
  const archive = ownedBuffer(bytes);

  const byName = new Map<string, string>();
  const names = await oneAtATime(async () => {
    const extractor = await decoderFor(load, archive);
    const list: string[] = [];
    // `fileHeaders` is a generator that keeps the archive open until it is drained, so it is
    // drained here and nowhere else.
    for (const header of extractor.getFileList().fileHeaders) {
      const name = header.name.replace(/\\/g, "/");
      byName.set(header.flags.directory ? `${name.replace(/\/$/, "")}/` : name, header.name);
      list.push(header.flags.directory ? `${name.replace(/\/$/, "")}/` : name);
    }
    if (list.length === 0) throw new Error("this RAR archive is empty");
    return list;
  }).catch((error: unknown) => {
    throw new Error(plainReason(error));
  });

  return {
    names,
    async read(name: string): Promise<Uint8Array> {
      const entry = byName.get(name);
      if (entry === undefined) throw new Error(`no such entry: ${name}`);
      return await oneAtATime(async () => {
        const extractor = await decoderFor(load, archive);
        // The generator decompresses as it is walked, so the first matching file is the answer.
        for (const file of extractor.extract({ files: [entry] }).files) {
          // A skipped entry is never yielded, so anything here with bytes is the page.
          const extracted = file.extraction;
          if (extracted !== undefined) return extracted;
        }
        throw new Error(`${name} could not be read out of this archive`);
      }).catch((error: unknown) => {
        throw new Error(plainReason(error));
      });
    },
  };
}

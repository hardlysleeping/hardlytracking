/**
 * A folder as a sync transport.
 *
 * The same transport serves three real cases: a Tauri desktop build writing into the
 * user's iCloud/Drive/Dropbox folder, the tests, and a headless script. It therefore
 * uses only `node:fs/promises` and `node:path` — no app state, no HTTP, no Tauri API —
 * so it can run anywhere Node runs and cannot drag a UI dependency into a sync path.
 *
 * Two behaviours matter more than they look:
 *
 * 1. **The write is atomic.** A cloud client (or a second device) can read the file at
 *    any moment; writing in place would let it read a half-written document, which
 *    parses as a corrupt library. A temp file in the same directory plus `rename` is
 *    atomic within a filesystem, and a rename is also the moment the file appears.
 * 2. **A missing file is `null`, not an error.** First sync on a fresh device is the
 *    normal case, not a failure, and it is not the same thing as an empty library.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { SyncTransportError } from "../transport";
import type { SyncTransport } from "../transport";

/** The name every provider and every device agrees on. */
export const DEFAULT_SYNC_FILE = "hardlytracking-sync.json";

export interface FolderTransportOptions {
  /** Directory that holds the document; created on first write if it is missing. */
  dir: string;
  /** Override only for a legacy or user-chosen name; the default is the contract. */
  file?: string;
}

export function folderTransport(options: FolderTransportOptions): SyncTransport {
  const file = options.file ?? DEFAULT_SYNC_FILE;
  const path = join(options.dir, file);
  const name = `folder:${path}`;

  return {
    name,

    async read(): Promise<string | null> {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        // A store that holds nothing yet is a state, not a fault.
        if (isMissing(error)) return null;
        throw new SyncTransportError(name, `could not read ${path}: ${describe(error)}`, error);
      }
    },

    async write(text: string): Promise<void> {
      const directory = dirname(path);
      try {
        // `recursive` makes this a no-op for an existing directory, and covers a
        // caller that points `file` at a subdirectory.
        await mkdir(directory, { recursive: true });
      } catch (error) {
        throw new SyncTransportError(name, `could not create ${directory}: ${describe(error)}`, error);
      }

      // Unique per attempt, in the target directory, so `rename` stays on one
      // filesystem and a crashed write leaves a name no reader will ever look for.
      // `basename` because `file` may carry a relative path of its own.
      const temp = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, text, "utf8");
        await rename(temp, path);
      } catch (error) {
        // Best effort: a leftover temp file must never be the reason the next write
        // fails too, and the original document is still intact.
        await unlink(temp).catch(() => undefined);
        throw new SyncTransportError(name, `could not write ${path}: ${describe(error)}`, error);
      }
    },
  };
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

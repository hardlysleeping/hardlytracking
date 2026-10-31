/**
 * One import door for every backup format the app can read.
 *
 * The screen does not ask "which app made this file" — it reads the bytes and answers:
 *
 * - **HardlyTracking's own document** (JSON, `meta.format` matches) — parsed by `parseSync`, so the
 *   version rules and the "refuse rather than downgrade" behaviour are the same as a sync file.
 * - **A Mihon/Tachiyomi/Komikku `.tachibk`** — protobuf, gzipped or bare, read by `readTachibk` and
 *   mapped into the same document by `toDocument`.
 * - **Anything else** — refused with a sentence that names what it *looks* like. An Aidoku backup is
 *   recognised as one and refused by name, because "unrecognised file" for a file we know perfectly
 *   well is a worse answer than "Aidoku backups are not read yet".
 *
 * Everything below the detection is the existing path: the document goes through the same
 * `summarizeImport` (what it holds, which sources are missing, which repositories it needs) and the
 * same `applyDocument` (add, never delete). A `.tachibk` therefore arrives at the confirm step
 * already described in the reader's words, and nothing is written before that confirm.
 */

import { SYNC_FORMAT, parseSync } from "../sync/document";
import type { SyncDocument } from "../sync/document";
import { ProtoError } from "./proto";
import { readTachibk, toDocument } from "./mihon";

export type BackupKind = "hardlytracking" | "mihon";

export interface ReadBackup {
  kind: BackupKind;
  /** What the screen calls the file, in the reader's words. */
  label: string;
  doc: SyncDocument;
  /** Notes worth showing next to the confirm: what was dropped on purpose, what the file carried. */
  warnings: string[];
}

export interface ReadOptions {
  /** Device id stamped on rows that arrive without one (a Mihon backup carries none). */
  device: string;
  at?: number;
}

function isJson(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    // Skip whitespace and a UTF-8 BOM.
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0xef || byte === 0xbb || byte === 0xbf) continue;
    return byte === 0x7b; // `{`
  }
  return false;
}

/** The keys an Aidoku backup carries; used only to name the refusal, never to parse it. */
function looksAidoku(value: Record<string, unknown>): boolean {
  const keys = ["library", "manga", "chapters", "sourceLists", "readingSessions"];
  return keys.filter((key) => key in value).length >= 2;
}

export async function readBackupFile(bytes: Uint8Array, options: ReadOptions): Promise<ReadBackup> {
  if (bytes.length === 0) throw new Error("that file is empty");

  if (isJson(bytes)) {
    const text = new TextDecoder().decode(bytes);
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new Error("that file starts like JSON but does not parse; it may be truncated");
    }
    const object = (raw ?? {}) as Record<string, unknown>;
    const meta = (object.meta ?? {}) as Record<string, unknown>;
    if (meta.format === SYNC_FORMAT) {
      return {
        kind: "hardlytracking",
        label: "HardlyTracking backup",
        doc: parseSync(text),
        warnings: [],
      };
    }
    if (looksAidoku(object)) {
      throw new Error("this is an Aidoku backup; Aidoku backups are not read yet — only HardlyTracking's own file and Mihon .tachibk backups are");
    }
    throw new Error("that JSON file is not a backup this app made, and it is not a Mihon backup either");
  }

  // Everything else is treated as a `.tachibk`: protobuf, gzipped or not.
  try {
    const backup = await readTachibk(bytes);
    const warnings: string[] = [];
    if (backup.preferenceKeys.length > 0) {
      warnings.push(`${backup.preferenceKeys.length} Mihon settings in the file were ignored — another app's preferences are not this app's settings.`);
    }
    const unmapped = backup.mangas.filter((manga) => manga.url === "").length;
    if (unmapped > 0) warnings.push(`${unmapped} entries had no address and were skipped.`);
    return {
      kind: "mihon",
      label: backup.gzipped ? "Mihon backup (.tachibk, gzipped)" : "Mihon backup (.tachibk)",
      doc: toDocument(backup, { device: options.device, ...(options.at !== undefined ? { at: options.at } : {}) }),
      warnings,
    };
  } catch (error) {
    if (error instanceof ProtoError) {
      throw new Error(`that is not a readable Mihon backup — ${error.message}`);
    }
    throw error;
  }
}

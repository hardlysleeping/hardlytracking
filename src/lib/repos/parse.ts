/**
 * One door: bytes in, a `RepoIndex` out.
 *
 * `detectRepoIndex` decides the ecosystem from the shape; this dispatches to that ecosystem's
 * parser. Suwatte has no parser yet — its list shape is read from the app's own Swift
 * (`RunnerList{listName, runners[]}`) but has not been verified against a live list file, and a
 * parser written from an unverified shape is worse than none: it would half-install runners.
 * `detectRepoIndex` already answers `"suwatte"` for that shape so the UI can say "not supported
 * yet" instead of "not a repository".
 */

import { detectRepoIndex } from "./index";
import type { RepoIndex, RepoKind } from "./index";
import { parseAidokuRepo } from "./aidoku";
import { parseMihonRepo } from "./mihon";
import { parsePaperbackRepo } from "./paperback";
import { parsePortableRepo } from "../extensions/portable";

export class RepoFormatError extends Error {
  readonly kind: RepoKind | null;
  constructor(message: string, kind: RepoKind | null) {
    super(message);
    this.name = "RepoFormatError";
    this.kind = kind;
  }
}

export function parseRepoIndex(kind: RepoKind, raw: unknown, base: string): RepoIndex {
  switch (kind) {
    case "mihon":
      return parseMihonRepo(raw, base);
    case "aidoku":
      return parseAidokuRepo(raw, base);
    case "paperback":
      return parsePaperbackRepo(raw, base);
    case "portable":
      return parsePortableRepo(raw, base);
    case "suwatte":
      throw new RepoFormatError("Suwatte runner lists are not read yet", "suwatte");
  }
}

/** Detect and parse in one step. Throws `RepoFormatError` naming what it saw. */
export function readRepoIndex(raw: unknown, base: string): RepoIndex {
  const kind = detectRepoIndex(raw);
  if (kind === null) {
    throw new RepoFormatError("this is not a repository index any of the four ecosystems publish", null);
  }
  // A string that detected is a JSON document; the parsers work on the parsed shape.
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return parseRepoIndex(kind, value, base);
}

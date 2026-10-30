/**
 * The sync document — the one format every cloud provider carries.
 *
 * Card S1. The rules that decide this file:
 *
 * 1. **One format, many transports.** iCloud, Drive, Dropbox, OneDrive, WebDAV and a
 *    plain folder all carry exactly this document. A provider that needed its own
 *    schema would be a second source of truth; there is only ever this one.
 * 2. **Deterministic bytes.** `serialize(parse(x)) === x` for any document this module
 *    wrote. That is what makes a sync file diffable, comparable across devices and
 *    provable in a test — and it is why keys are sorted and every collection has a
 *    declared sort key.
 * 3. **Refuse, never downgrade.** A newer `version` is an error with a readable reason.
 *    Silently dropping fields a future device wrote is how a sync feature eats data.
 * 4. **Nothing here is a page, an image, an APK or a cookie.** Those stay on the device
 *    by design: the document is the portable *state*, not the content.
 */
import type { ProviderKind } from "../../api/source";

export const SYNC_FORMAT = "hardlytracking.sync";
/**
 * 2 adds `sessions` — the reading log.
 * 3 adds `chapters`, `positions` and `repos` — the lists an imported library needs to be
 *   *readable* and re-installable, not just listed.
 *
 * Bumped rather than optional because a v1 document has no session list, and "missing list" is
 * refused here on purpose: an absent list is not an empty one. The exception is a list a *later*
 * version introduced: `COLLECTION_SINCE` records exactly which version added which list, so a
 * v2 document is read with three empty lists instead of being refused — we know what v2 meant,
 * so nothing is guessed and nothing is dropped.
 */
export const SYNC_VERSION = 3;

/** One row of the library, as it travels. `addedAt` is local bookkeeping and stays home. */
export interface SyncSeries {
  id: string;
  provider: ProviderKind;
  title: string;
  cover?: string;
  author?: string;
  description?: string;
  status?: string;
  /** Category membership travels with the series; categories themselves travel separately. */
  categoryIds: string[];
  at: number;
  device: string;
}

export interface SyncCategory {
  id: string;
  name: string;
  order: number;
  /** The eye's mark and the pin's mark — the owner's two features, synced as state. */
  hidden: boolean;
  pinned: boolean;
  at: number;
  device: string;
}

/**
 * One chapter of a series, as it travels.
 *
 * `read` is deliberately absent: a read mark is a `readState` row, and carrying a second copy of
 * it inside the chapter would give the same fact two writers. `pageCount` and `number` are here
 * because they are what a chapter list draws; the pages themselves stay on the device.
 */
export interface SyncChapter {
  id: string;
  seriesId: string;
  name: string;
  number: number;
  pageCount: number;
  uploadedAt?: number;
  at: number;
  device: string;
}

/** Where the reader was in a series — one row per series, so Continue Reading survives a restore. */
export interface SyncPosition {
  seriesId: string;
  chapterId: string;
  page: number;
  at: number;
  device: string;
}

/**
 * An extension repository this device has added.
 *
 * A URL, its index and a label — never the index itself and never an APK. That is enough for an
 * import screen to offer "add these repositories" instead of silently importing series that no
 * installed extension can open.
 */
export interface SyncRepo {
  url: string;
  indexUrl: string;
  name: string;
  at: number;
  device: string;
}

/** Where the reader was in a chapter. `page` is 0-based, `total` is the page count. */
export interface SyncProgress {
  chapterId: string;
  seriesId: string;
  page: number;
  total: number;
  at: number;
  device: string;
}

/** Read/unread is its own row so it can be stamped separately from position. */
export interface SyncReadState {
  chapterId: string;
  read: boolean;
  at: number;
  device: string;
}

export interface SyncHistory {
  seriesId: string;
  chapterId: string;
  at: number;
  device: string;
}

/**
 * A reading session, as it travels.
 *
 * Small metadata, never content: which chapter, from which page to which, for how long, finished or
 * not. It is the difference between History that says "you read this" and History that says how.
 */
export interface SyncSession {
  id: string;
  seriesId: string;
  sourceId: string;
  chapterId: string;
  startedAt: number;
  endedAt?: number;
  startPage: number;
  endPage: number;
  pagesRead: number;
  durationSeconds?: number;
  completedChapter: boolean;
  /** The merge stamp: when this session finished, or when it started if it never did. */
  at: number;
  device: string;
}

export interface SyncBookmark {
  seriesId: string;
  chapterId: string;
  at: number;
  device: string;
}

/**
 * How a library row reconnects to an extension on another device.
 *
 * `sourceId` is the real Mihon source id (a 19-digit Long kept as a string) and
 * `packageId` the APK's package. Neither is ever re-derived or translated — that is
 * what lets a backup or a sync land on the same source after a reinstall.
 */
export interface SyncSourceMapping {
  seriesId: string;
  provider: ProviderKind;
  sourceId: string;
  packageId?: string;
  at: number;
  device: string;
}

/**
 * An installed extension, described rather than shipped.
 *
 * APKs are never uploaded. Another device reads this row, finds the repository it
 * already has (or asks for it), downloads the APK itself and verifies it.
 */
export interface SyncExtension {
  packageId: string;
  repoUrl: string;
  versionName: string;
  versionCode: number;
  enabled: boolean;
  /** Real Mihon source ids this package exposes, so mappings survive a reinstall. */
  sourceIds: string[];
  /** The extension's own preferences, already serialised by the extension itself. */
  preferences: Record<string, string>;
  at: number;
  device: string;
}

/** App and reader preferences: one row per key, value kept as JSON. */
export interface SyncPreference {
  key: string;
  value: unknown;
  at: number;
  device: string;
}

export interface SyncTrackerMapping {
  seriesId: string;
  service: string;
  remoteId: string;
  at: number;
  device: string;
}

/**
 * A deletion, kept as a fact.
 *
 * Without these, a merge resurrects whatever the other device still has. The tombstone
 * is the only way "gone" can win against "present".
 */
export interface SyncTombstone {
  kind: TombstoneKind;
  id: string;
  at: number;
  device: string;
}

export type TombstoneKind = "series" | "category" | "history" | "session" | "bookmark" | "extension";

export interface SyncMeta {
  format: string;
  version: number;
  /** Which device wrote this revision. A device id is local, not an account id. */
  device: string;
  /** When this revision was produced, ISO-8601 UTC. */
  updatedAt: string;
  /** Bumped by whoever writes; the merge in S2 uses it only as a tiebreaker hint. */
  revision: number;
}

export interface SyncDocument {
  meta: SyncMeta;
  series: SyncSeries[];
  chapters: SyncChapter[];
  categories: SyncCategory[];
  progress: SyncProgress[];
  readState: SyncReadState[];
  positions: SyncPosition[];
  history: SyncHistory[];
  sessions: SyncSession[];
  bookmarks: SyncBookmark[];
  sourceMappings: SyncSourceMapping[];
  extensions: SyncExtension[];
  preferences: SyncPreference[];
  trackers: SyncTrackerMapping[];
  repos: SyncRepo[];
  tombstones: SyncTombstone[];
}

/** Every collection, so validation and canonical ordering cannot drift apart. */
export const COLLECTIONS = [
  "series",
  "chapters",
  "categories",
  "progress",
  "readState",
  "positions",
  "history",
  "sessions",
  "bookmarks",
  "sourceMappings",
  "extensions",
  "preferences",
  "trackers",
  "repos",
  "tombstones",
] as const;

export type Collection = (typeof COLLECTIONS)[number];

/**
 * The version that introduced each collection.
 *
 * A list added in v3 is absent from a v2 file *by definition*, so reading it as empty is not a
 * guess — it is what that version meant. A list that has always existed is still refused when it
 * is missing, because there an absent list really could be a truncated file.
 */
const COLLECTION_SINCE: Partial<Record<Collection, number>> = {
  chapters: 3,
  positions: 3,
  repos: 3,
};

export type SyncErrorReason =
  | "not-json"
  | "not-an-object"
  | "wrong-format"
  | "newer-version"
  | "missing-collection"
  | "bad-entry";

export class SyncFormatError extends Error {
  readonly reason: SyncErrorReason;

  constructor(reason: SyncErrorReason, message: string) {
    super(message);
    this.name = "SyncFormatError";
    this.reason = reason;
  }
}

/** The sort key of each collection: identity first, then the stamp as a tiebreak. */
function keyOf(collection: Collection, row: Record<string, unknown>): string {
  const text = (field: string): string => (typeof row[field] === "string" ? (row[field] as string) : "");
  switch (collection) {
    case "series":
      return text("id");
    case "chapters":
      return text("id");
    case "categories":
      return text("id");
    case "progress":
      return text("chapterId");
    case "readState":
      return text("chapterId");
    case "positions":
      return text("seriesId");
    case "sessions":
      return text("id");
    case "history":
    case "bookmarks":
      return `${text("seriesId")}\u0000${text("chapterId")}`;
    case "sourceMappings":
      return text("seriesId");
    case "extensions":
      return text("packageId");
    case "preferences":
      return text("key");
    case "trackers":
      return `${text("service")}\u0000${text("seriesId")}`;
    case "repos":
      return text("url");
    case "tombstones":
      return `${text("kind")}\u0000${text("id")}`;
  }
}

/** JSON with object keys sorted, so equal documents have equal bytes. */
export function canonicalJson(value: unknown, indent = 2): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
  return out;
}

/**
 * Sort a collection by its key, and collapse duplicates by keeping the newest stamp.
 *
 * Duplicates happen for real: two devices can each carry a row for the same chapter
 * before they meet. Keeping the newest `at` (device id as a deterministic tiebreak) is
 * the only choice that does not depend on which file was read first.
 */
function canonicalRows<T>(collection: Collection, rows: T[]): T[] {
  const newest = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(collection, row as Record<string, unknown>);
    const current = newest.get(key);
    if (current === undefined || newer(row, current)) newest.set(key, row);
  }
  return [...newest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
}

function newer(a: unknown, b: unknown): boolean {
  const left = a as { at?: number; device?: string };
  const right = b as { at?: number; device?: string };
  const atA = typeof left.at === "number" ? left.at : 0;
  const atB = typeof right.at === "number" ? right.at : 0;
  if (atA !== atB) return atA > atB;
  return (left.device ?? "") > (right.device ?? "");
}

/** A document with every collection present and empty — the starting point, not a null. */
export function emptyDocument(device: string, at: number = Date.now()): SyncDocument {
  return {
    meta: {
      format: SYNC_FORMAT,
      version: SYNC_VERSION,
      device,
      updatedAt: new Date(at).toISOString(),
      revision: 1,
    },
    series: [],
    chapters: [],
    categories: [],
    progress: [],
    readState: [],
    positions: [],
    history: [],
    sessions: [],
    bookmarks: [],
    sourceMappings: [],
    extensions: [],
    preferences: [],
    trackers: [],
    repos: [],
    tombstones: [],
  };
}

/**
 * Validate and normalise a parsed document.
 *
 * Two different jobs, deliberately in one place: a document that is structurally wrong
 * is refused (an empty library looks exactly like a deleted one), and a document that is
 * merely untidy — unsorted, duplicated, missing optional fields — is normalised so the
 * bytes that come out are stable.
 */
export function validateSyncDocument(raw: unknown): SyncDocument {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SyncFormatError("not-an-object", "sync document must be a JSON object");
  }
  const source = raw as Record<string, unknown>;
  const meta = source.meta;
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    throw new SyncFormatError("not-an-object", "sync document has no meta block");
  }
  const m = meta as Record<string, unknown>;
  if (m.format !== SYNC_FORMAT) {
    throw new SyncFormatError(
      "wrong-format",
      `not a HardlyTracking sync document (format ${JSON.stringify(m.format ?? null)})`,
    );
  }
  const version = m.version;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    throw new SyncFormatError("wrong-format", "sync document has no numeric version");
  }
  if (version > SYNC_VERSION) {
    throw new SyncFormatError(
      "newer-version",
      `sync document is version ${version}; this build understands ${SYNC_VERSION} — refusing rather than dropping fields it cannot keep`,
    );
  }

  const doc = emptyDocument(typeof m.device === "string" && m.device !== "" ? m.device : "unknown");
  doc.meta = {
    format: SYNC_FORMAT,
    version,
    device: typeof m.device === "string" ? m.device : "unknown",
    updatedAt: typeof m.updatedAt === "string" ? m.updatedAt : new Date(0).toISOString(),
    revision: typeof m.revision === "number" && Number.isFinite(m.revision) ? m.revision : 1,
  };

  for (const collection of COLLECTIONS) {
    const rows = source[collection];
    if (!Array.isArray(rows)) {
      // A list this document's own version did not have: empty is the only honest reading.
      if (version < (COLLECTION_SINCE[collection] ?? 0)) continue;
      throw new SyncFormatError(
        "missing-collection",
        `sync document is missing the "${collection}" list — a missing list is not an empty one`,
      );
    }
    const parsed = rows.map((row, index) => normaliseRow(collection, row, index));
    (doc as unknown as Record<string, unknown>)[collection] = canonicalRows(collection, parsed);
  }
  return doc;
}

function normaliseRow(collection: Collection, raw: unknown, index: number): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SyncFormatError("bad-entry", `${collection}[${index}] is not an object`);
  }
  const row = raw as Record<string, unknown>;
  const at = typeof row.at === "number" && Number.isFinite(row.at) ? row.at : 0;
  const device = typeof row.device === "string" ? row.device : "unknown";
  const stamp = { at, device };
  const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  const need = (field: string): string => {
    const value = str(row[field]);
    if (value === undefined || value === "") {
      throw new SyncFormatError("bad-entry", `${collection}[${index}] has no ${field}`);
    }
    return value;
  };
  const num = (field: string, fallback = 0): number =>
    typeof row[field] === "number" && Number.isFinite(row[field]) ? (row[field] as number) : fallback;
  const bool = (field: string): boolean => row[field] === true;
  const strings = (field: string): string[] =>
    Array.isArray(row[field]) ? (row[field] as unknown[]).filter((v): v is string => typeof v === "string") : [];
  const stringsMap = (field: string): Record<string, string> => {
    const value = row[field];
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    return out;
  };
  const maybe = (field: string): Record<string, string> => {
    const value = str(row[field]);
    return value === undefined ? {} : { [field]: value };
  };

  switch (collection) {
    case "series":
      return {
        id: need("id"),
        provider: (str(row.provider) ?? "local") as ProviderKind,
        title: need("title"),
        ...maybe("cover"),
        ...maybe("author"),
        ...maybe("description"),
        ...maybe("status"),
        categoryIds: strings("categoryIds"),
        ...stamp,
      };
    case "categories":
      return {
        id: need("id"),
        name: need("name"),
        order: num("order"),
        hidden: bool("hidden"),
        pinned: bool("pinned"),
        ...stamp,
      };
    case "chapters": {
      const uploadedAt = typeof row.uploadedAt === "number" && Number.isFinite(row.uploadedAt) ? row.uploadedAt : undefined;
      return {
        id: need("id"),
        seriesId: need("seriesId"),
        name: str(row.name) ?? "",
        number: num("number"),
        pageCount: num("pageCount"),
        ...(uploadedAt === undefined ? {} : { uploadedAt }),
        ...stamp,
      };
    }
    case "positions":
      return { seriesId: need("seriesId"), chapterId: need("chapterId"), page: num("page"), ...stamp };
    case "progress":
      return {
        chapterId: need("chapterId"),
        seriesId: need("seriesId"),
        page: num("page"),
        total: num("total"),
        ...stamp,
      };
    case "readState":
      return { chapterId: need("chapterId"), read: bool("read"), ...stamp };
    case "history":
      return { seriesId: need("seriesId"), chapterId: need("chapterId"), ...stamp };
    case "sessions": {
      const endedAt = typeof row.endedAt === "number" && Number.isFinite(row.endedAt) ? row.endedAt : undefined;
      const durationSeconds =
        typeof row.durationSeconds === "number" && Number.isFinite(row.durationSeconds)
          ? Math.max(row.durationSeconds, 0)
          : undefined;
      return {
        id: need("id"),
        seriesId: need("seriesId"),
        sourceId: str(row.sourceId) ?? "",
        chapterId: need("chapterId"),
        startedAt: num("startedAt"),
        ...(endedAt === undefined ? {} : { endedAt }),
        startPage: num("startPage"),
        endPage: num("endPage"),
        pagesRead: num("pagesRead", Math.abs(num("endPage") - num("startPage")) + 1),
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
        completedChapter: bool("completedChapter"),
        ...stamp,
      };
    }
    case "bookmarks":
      return { seriesId: need("seriesId"), chapterId: need("chapterId"), ...stamp };
    case "sourceMappings":
      return {
        seriesId: need("seriesId"),
        provider: (str(row.provider) ?? "mihon") as ProviderKind,
        sourceId: need("sourceId"),
        ...maybe("packageId"),
        ...stamp,
      };
    case "extensions":
      return {
        packageId: need("packageId"),
        repoUrl: need("repoUrl"),
        versionName: str(row.versionName) ?? "",
        versionCode: num("versionCode"),
        enabled: row.enabled !== false,
        sourceIds: strings("sourceIds"),
        preferences: stringsMap("preferences"),
        ...stamp,
      };
    case "preferences":
      return { key: need("key"), value: row.value, ...stamp };
    case "trackers":
      return {
        seriesId: need("seriesId"),
        service: need("service"),
        remoteId: need("remoteId"),
        ...stamp,
      };
    case "repos":
      return {
        url: need("url"),
        indexUrl: str(row.indexUrl) ?? "",
        name: str(row.name) ?? "",
        ...stamp,
      };
    case "tombstones": {
      const kind = str(row.kind);
      if (
        kind !== "series" &&
        kind !== "category" &&
        kind !== "history" &&
        kind !== "session" &&
        kind !== "bookmark" &&
        kind !== "extension"
      ) {
        throw new SyncFormatError("bad-entry", `tombstones[${index}] has no known kind`);
      }
      return { kind, id: need("id"), ...stamp };
    }
  }
}

/** The bytes that go to the cloud: canonical, sorted, newline-terminated. */
export function serializeSync(doc: SyncDocument): string {
  const normalised = validateSyncDocument(JSON.parse(JSON.stringify(doc)));
  // The bytes carry every collection this build knows, so they declare this build's version. A v2
  // header over v3 lists would be a claim a v2 reader would act on and get wrong.
  normalised.meta.version = SYNC_VERSION;
  return `${canonicalJson(normalised)}\n`;
}

/** Parse bytes from the cloud. Throws `SyncFormatError` with a reason worth showing. */
export function parseSync(text: string): SyncDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new SyncFormatError("not-json", `sync document is not JSON: ${(error as Error).message}`);
  }
  return validateSyncDocument(raw);
}

/** A cheap check for a UI: is this file ours at all? */
export function looksLikeSyncDocument(text: string): boolean {
  try {
    parseSync(text);
    return true;
  } catch {
    return false;
  }
}

/** Merge helper shared by S2: the stamp a row must carry to be newer than `other`. */
export function isNewer(a: { at: number; device: string }, b: { at: number; device: string }): boolean {
  if (a.at !== b.at) return a.at > b.at;
  return a.device > b.device;
}

/**
 * Merging two sync documents — the rule that makes a change log safe.
 *
 * Card S2. A merge is the one operation that can lose a reader's place, so the rules
 * are stated once, here, and every collection follows them:
 *
 * 1. **Union by identity.** A row is identified by its own key (series id, chapter id,
 *    the series+chapter pair, package id, preference key, …). For the same key the
 *    newest stamp wins; `isNewer` breaks an equal `at` by device id, so both devices
 *    pick the same winner without asking who read the file first.
 * 2. **Tombstones suppress, and only what is older.** A deletion removes a row of its
 *    kind whose stamp is *not newer* than the tombstone. A row written after the
 *    deletion survives — a re-add must beat a delete — and the tombstone stays in the
 *    output either way, because it is a fact with a stamp of its own.
 * 3. **Position and read mark are separate rows.** They share a chapter id but nothing
 *    else, so they are merged in their own collections and can never overwrite each
 *    other.
 * 4. **Absence is not deletion.** A category (or series, or extension) that one
 *    document carries and the other has never heard of survives. Only a tombstone can
 *    remove something, which is why the merge never intersects.
 * 5. **Pure.** Inputs are read, never written, and the output is already in canonical
 *    order, so `serializeSync(merge(a, b))` is the bytes a device writes.
 *
 * What a merge deliberately does *not* do: it never cascades a series tombstone into
 * that series' progress or history rows, and it never unions a series' category list.
 * Both would invent state the reader did not write.
 */
import type { Collection, SyncDocument, SyncMeta, SyncTombstone, TombstoneKind } from "./document";
import { COLLECTIONS, SYNC_FORMAT, SYNC_VERSION, canonicalJson, emptyDocument, isNewer } from "./document";

type Stamp = { at: number; device: string };

/** Rows are read field by field here, so the merge does not need every row interface. */
type Row = Record<string, unknown>;

/** The document without its meta block — what a merge actually combines. */
type Collections = Omit<SyncDocument, "meta">;

export interface MergeOptions {
  /** The device that writes the result. Defaults to the left document's device. */
  device?: string;
  /** The clock for `meta.updatedAt`, in ms. Defaults to now; tests pass a fixed value. */
  now?: number;
}

interface ResolvedOptions {
  device: string;
  now: number;
}

/**
 * Which tombstone kind removes rows of a collection.
 *
 * Progress, read state, preferences and tracker mappings have no tombstone kind: a
 * position is superseded by a newer position and a preference by a newer value, so
 * there is nothing for a deletion to win against.
 */
const TOMBSTONE_KIND: Partial<Record<Collection, TombstoneKind>> = {
  series: "series",
  categories: "category",
  history: "history",
  sessions: "session",
  bookmarks: "bookmark",
  extensions: "extension",
};

/**
 * The identity key of a row, matching the sort key `document.ts` uses.
 *
 * Repeated rather than imported because that module keeps its key private, and the two
 * must agree: a merge that ordered rows differently from the writer would produce
 * documents whose bytes change on every round trip.
 */
export function identityOf(collection: Collection, row: Row): string {
  const text = (field: string): string => (typeof row[field] === "string" ? (row[field] as string) : "");
  switch (collection) {
    case "series":
      return text("id");
    case "categories":
      return text("id");
    case "progress":
      return text("chapterId");
    case "readState":
      return text("chapterId");
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
    case "tombstones":
      return `${text("kind")}\u0000${text("id")}`;
  }
}

function stampOf(row: Row): Stamp {
  const at = typeof row.at === "number" && Number.isFinite(row.at) ? row.at : 0;
  const device = typeof row.device === "string" ? row.device : "";
  return { at, device };
}

/**
 * A row is copied out of the input, one level deep, so a caller that edits the merged
 * document cannot reach back into either source document.
 */
function cloneRow<T>(row: T): T {
  const source = row as unknown as Row;
  const copy: Row = { ...source };
  for (const key of Object.keys(copy)) {
    const value = copy[key];
    if (Array.isArray(value)) copy[key] = [...value];
    else if (value !== null && typeof value === "object") copy[key] = { ...(value as Row) };
  }
  return copy as unknown as T;
}

/**
 * Does `row` displace `current`, given they share an identity?
 *
 * The third branch only fires when two writers claim the same millisecond *and* the same
 * device id — a broken writer rather than a race. Bytes decide there, so the result
 * still does not depend on which document was passed first.
 */
function displaces(row: Row, current: Row): boolean {
  const left = stampOf(row);
  const right = stampOf(current);
  if (isNewer(left, right)) return true;
  if (isNewer(right, left)) return false;
  return canonicalJson(row) > canonicalJson(current);
}

/** One row per identity key: the newest stamp wins. */
function newestByKey<T>(collection: Collection, rows: readonly T[]): Map<string, T> {
  const newest = new Map<string, T>();
  for (const row of rows) {
    const key = identityOf(collection, row as unknown as Row);
    const current = newest.get(key);
    if (current === undefined || displaces(row as unknown as Row, current as unknown as Row)) {
      newest.set(key, cloneRow(row));
    }
  }
  return newest;
}

/** Canonical order, so the merged document is the bytes a device would write. */
function sortedByKey<T>(collection: Collection, rows: readonly T[]): T[] {
  return rows
    .map((row) => ({ key: identityOf(collection, row as unknown as Row), row }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ row }) => row);
}

/**
 * Is this row killed by one of these tombstones?
 *
 * History and bookmark rows are identified by a pair, but whoever deletes one knows the
 * chapter it belongs to, so a tombstone id may name either the pair or the chapter. The
 * wider match is safe for the other kinds because their rows carry no `chapterId`.
 */
function coveredBy(tombstones: readonly SyncTombstone[], collection: Collection, row: Row): boolean {
  const key = identityOf(collection, row);
  const chapterId = typeof row.chapterId === "string" ? row.chapterId : "";
  const rowStamp = stampOf(row);
  for (const tombstone of tombstones) {
    const names = tombstone.id === key || (chapterId !== "" && tombstone.id === chapterId);
    if (names && !isNewer(rowStamp, stampOf(tombstone as unknown as Row))) return true;
  }
  return false;
}

/** The union of two documents' collections, with tombstones applied. */
function mergeCollections(a: Collections, b: Collections): Collections {
  // Tombstones merge like any other row: one per (kind, id), newest stamp wins.
  const tombstones = sortedByKey(
    "tombstones",
    [...newestByKey("tombstones", [...a.tombstones, ...b.tombstones]).values()],
  );

  const merged = {} as Collections;
  const target = merged as unknown as Record<string, unknown>;

  for (const collection of COLLECTIONS) {
    if (collection === "tombstones") {
      target[collection] = tombstones;
      continue;
    }
    const left = a[collection] as unknown as readonly unknown[];
    const right = b[collection] as unknown as readonly unknown[];
    const union = [...newestByKey(collection, [...left, ...right]).values()];
    const kind = TOMBSTONE_KIND[collection];
    const ofKind = kind === undefined ? [] : tombstones.filter((tombstone) => tombstone.kind === kind);
    const survivors =
      ofKind.length === 0 ? union : union.filter((row) => !coveredBy(ofKind, collection, row as Row));
    target[collection] = sortedByKey(collection, survivors);
  }

  return merged;
}

function revisionOf(doc: SyncDocument): number {
  const revision = doc.meta.revision;
  return typeof revision === "number" && Number.isFinite(revision) ? revision : 1;
}

function resolveOptions(options: MergeOptions, fallbackDevice: string): ResolvedOptions {
  const device = options.device ?? fallbackDevice;
  return {
    device: device === "" ? "unknown" : device,
    now: options.now ?? Date.now(),
  };
}

function withMeta(collections: Collections, revision: number, options: ResolvedOptions): SyncDocument {
  const meta: SyncMeta = {
    format: SYNC_FORMAT,
    version: SYNC_VERSION,
    device: options.device,
    updatedAt: new Date(options.now).toISOString(),
    revision,
  };
  return { meta, ...collections };
}

/**
 * Merge two documents into one. Neither input is modified.
 *
 * `revision` is one above the higher input revision: a merge of three documents is
 * still a single new revision, which is also why the fold in `mergeMany` is associative
 * down to the meta block.
 */
export function mergeSyncDocuments(a: SyncDocument, b: SyncDocument, options: MergeOptions = {}): SyncDocument {
  const resolved = resolveOptions(options, a.meta.device);
  const revision = Math.max(revisionOf(a), revisionOf(b)) + 1;
  return withMeta(mergeCollections(a, b), revision, resolved);
}

/**
 * Merge any number of documents, folding left to right.
 *
 * One document in is that document normalised, with no revision bump — folding a single
 * element must not invent a write. `mergeMany([a, b])` is exactly `mergeSyncDocuments(a,
 * b)`, so a caller that has two documents never needs to know this function exists.
 */
export function mergeMany(docs: readonly SyncDocument[], options: MergeOptions = {}): SyncDocument {
  const first = docs[0];
  if (first === undefined) {
    const resolved = resolveOptions(options, "unknown");
    return emptyDocument(resolved.device, resolved.now);
  }
  const resolved = resolveOptions(options, first.meta.device);
  let merged = withMeta(mergeCollections(first, first), revisionOf(first), resolved);
  for (let index = 1; index < docs.length; index += 1) {
    const next = docs[index];
    if (next === undefined) continue;
    merged = mergeSyncDocuments(merged, next, { device: resolved.device, now: resolved.now });
  }
  return merged;
}

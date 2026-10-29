/**
 * Turning this device's library into a sync document.
 *
 * The document is a *portable backup*: everything the app owns and nothing it does not.
 * Read marks live as `read:<chapterId>` prefs and positions in their own store, so both
 * have to be lifted out by name — that naming is the only coupling between the store and
 * this file, and it is written down once, here.
 */
import type { LibraryStore } from "../db/store";
import type { SyncDocument, SyncProgress, SyncReadState } from "./document";
import { emptyDocument } from "./document";

const READ_PREFIX = "read:";

/** Preferences that are view state, not user state: they travel, but as their own rows. */
const isReadKey = (key: string): boolean => key.startsWith(READ_PREFIX);

export interface BuildOptions {
  device: string;
  at?: number;
}

export async function documentFromStore(store: LibraryStore, options: BuildOptions): Promise<SyncDocument> {
  const at = options.at ?? Date.now();
  const doc = emptyDocument(options.device, at);
  const stamp = { at, device: options.device };

  const [series, categories, progress, prefs, sessions, tombstones] = await Promise.all([
    store.listSeries(),
    store.listCategories(),
    store.listProgress(),
    store.listPrefs(),
    store.listSessions(Number.POSITIVE_INFINITY),
    store.listTombstones(),
  ]);

  doc.series = series.map((row) => ({
    id: row.id,
    provider: row.provider,
    title: row.title,
    ...(row.cover === undefined ? {} : { cover: row.cover }),
    ...(row.author === undefined ? {} : { author: row.author }),
    ...(row.description === undefined ? {} : { description: row.description }),
    ...(row.status === undefined ? {} : { status: row.status }),
    categoryIds: row.categoryIds ?? [],
    ...stamp,
  }));

  doc.categories = categories.map((row) => ({
    id: row.id,
    name: row.name,
    order: row.order,
    hidden: row.hidden,
    pinned: row.pinned,
    ...stamp,
  }));

  // A position row knows its chapter but not its series; the chapter rows do. When the
  // chapter is not on this device (never opened here) the series stays empty rather than
  // being invented — the merge can fill it from another device's document.
  const seriesOf = new Map<string, string>();
  for (const row of series) {
    const chapters = await store.listChapters(row.id);
    for (const chapter of chapters) seriesOf.set(chapter.id, row.id);
  }

  doc.progress = progress.map<SyncProgress>((row) => ({
    chapterId: row.chapterId,
    seriesId: seriesOf.get(row.chapterId) ?? "",
    page: row.page,
    total: row.total,
    at: row.at,
    device: options.device,
  }));

  // The reading log travels because it is small metadata, not comic files: without it, History and
  // Stats would be a second device's guess at what happened here.
  doc.sessions = sessions.map((row) => ({
    id: row.id,
    seriesId: row.seriesId,
    sourceId: row.sourceId,
    chapterId: row.chapterId,
    startedAt: row.startedAt,
    ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }),
    startPage: row.startPage,
    endPage: row.endPage,
    pagesRead: row.pagesRead,
    ...(row.durationSeconds === undefined ? {} : { durationSeconds: row.durationSeconds }),
    completedChapter: row.completedChapter,
    at: row.endedAt ?? row.startedAt,
    device: options.device,
  }));

  // A cleared history has to travel as a deletion, or the other device's copy would be merged
  // straight back in. The tombstone is the only fact that can win against a row.
  doc.tombstones = tombstones.map((row) => ({ kind: row.kind, id: row.id, ...stamp }));

  doc.readState = prefs
    .filter((row) => isReadKey(row.key))
    .map<SyncReadState>((row) => ({
      chapterId: row.key.slice(READ_PREFIX.length),
      read: row.value === true,
      ...stamp,
    }));

  // Everything else in prefs is user state (reader mode, theme, the two category views).
  doc.preferences = prefs
    .filter((row) => !isReadKey(row.key))
    .map((row) => ({ key: row.key, value: row.value, ...stamp }));

  return doc;
}

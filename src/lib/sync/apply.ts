/**
 * Writing a document back into this device's library.
 *
 * Used by manual import — the free, always-available path — and by sync when it lands. It writes
 * rows and nothing else: no deletion, no rows removed because the file does not carry them, because
 * an import is "bring this in", not "make this device match that one". A row that already exists is
 * overwritten by the document, which is the behaviour a restore from your own backup should have.
 *
 * Three things it writes that are easy to forget and expensive to omit:
 *
 * - **chapters**, so an imported series opens to a chapter list instead of an empty page;
 * - **positions**, the one row Continue Reading reads, stamped with the time the document carries;
 * - **tombstones**, as facts and not as deletions. Recording "this was deleted at T" is what stops
 *   a later sync from resurrecting it; it never removes a local row, and a local row newer than the
 *   tombstone still wins in the merge.
 *
 * Read marks are prefs named `read:<chapterId>`, the same naming `documentFromStore` lifts out;
 * that pair of names is the only coupling, and both sides say so.
 */
import type { LibraryStore } from "../db/store";
import type { SyncDocument } from "./document";

export interface ApplySummary {
  series: number;
  chapters: number;
  categories: number;
  progress: number;
  positions: number;
  prefs: number;
  read: number;
  history: number;
  sessions: number;
  mappings: number;
  repos: number;
  tombstones: number;
}

export async function applyDocument(store: LibraryStore, doc: SyncDocument): Promise<ApplySummary> {
  const summary: ApplySummary = {
    series: 0,
    chapters: 0,
    categories: 0,
    progress: 0,
    positions: 0,
    prefs: 0,
    read: 0,
    history: 0,
    sessions: 0,
    mappings: 0,
    repos: 0,
    tombstones: 0,
  };

  for (const category of doc.categories) {
    await store.putCategory({
      id: category.id,
      name: category.name,
      order: category.order,
      hidden: category.hidden,
      pinned: category.pinned,
    });
    summary.categories += 1;
  }

  for (const row of doc.series) {
    await store.addSeries({
      id: row.id,
      provider: row.provider,
      title: row.title,
      ...(row.cover === undefined ? {} : { cover: row.cover }),
      ...(row.author === undefined ? {} : { author: row.author }),
      ...(row.description === undefined ? {} : { description: row.description }),
      ...(row.status === undefined ? {} : { status: row.status }),
      categoryIds: row.categoryIds,
    });
    summary.series += 1;
  }

  // Chapters arrive grouped by series because that is how the store writes them. `read: false` is
  // not a lost mark: the mark is a `read:` pref, restored by the readState loop below.
  const bySeries = new Map<string, Array<{ id: string; seriesId: string; name: string; number: number; pageCount: number; read: boolean; uploadedAt?: number }>>();
  for (const row of doc.chapters) {
    const list = bySeries.get(row.seriesId) ?? [];
    list.push({
      id: row.id,
      seriesId: row.seriesId,
      name: row.name,
      number: row.number,
      pageCount: row.pageCount,
      read: false,
      ...(row.uploadedAt === undefined ? {} : { uploadedAt: row.uploadedAt }),
    });
    bySeries.set(row.seriesId, list);
  }
  for (const [seriesId, chapters] of bySeries) {
    await store.putChapters(seriesId, chapters);
    summary.chapters += chapters.length;
  }

  for (const row of doc.progress) {
    await store.setProgress(row.chapterId, row.page, row.total, row.at);
    summary.progress += 1;
  }

  for (const row of doc.positions) {
    await store.setPosition(row.seriesId, row.chapterId, row.page, row.at);
    summary.positions += 1;
  }

  // Settings travel as rows. They are written before the read marks, so a file that carries a
  // `read:` key in `preferences` cannot overwrite the `readState` row that is the real answer.
  for (const row of doc.preferences) {
    await store.setPref(row.key, row.value);
    summary.prefs += 1;
  }

  for (const row of doc.readState) {
    await store.setRead(row.chapterId, row.read);
    summary.read += 1;
  }

  for (const row of doc.history) {
    await store.recordHistory(row.seriesId, row.chapterId, row.at);
    summary.history += 1;
  }

  for (const row of doc.sessions) {
    await store.putSession({
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
    });
    summary.sessions += 1;
  }

  for (const row of doc.sourceMappings) {
    await store.putMapping({
      seriesId: row.seriesId,
      provider: row.provider,
      sourceId: row.sourceId,
      ...(row.packageId === undefined ? {} : { packageId: row.packageId }),
      at: row.at,
    });
    summary.mappings += 1;
  }

  // Repositories are rows, not indexes: the URL is the user's own paste and the index is fetched
  // when it is needed. Writing one here never installs anything.
  for (const row of doc.repos) {
    await store.putRepo({ url: row.url, indexUrl: row.indexUrl, name: row.name, at: row.at });
    summary.repos += 1;
  }

  for (const row of doc.tombstones) {
    await store.recordTombstone(row.kind, row.id, row.at);
    summary.tombstones += 1;
  }

  return summary;
}

/**
 * Writing a document back into this device's library.
 *
 * Used by manual import — the free, always-available path — and by sync when it lands. It writes
 * rows and nothing else: no deletion, no tombstones applied, because an import is "bring this in",
 * not "make this device match that one". A row that already exists is overwritten by the document,
 * which is the behaviour a restore from your own backup should have.
 *
 * Read marks are prefs named `read:<chapterId>`, the same naming `documentFromStore` lifts out;
 * that pair of names is the only coupling, and both sides say so.
 */
import type { LibraryStore } from "../db/store";
import type { SyncDocument } from "./document";

export interface ApplySummary {
  series: number;
  categories: number;
  progress: number;
  read: number;
  history: number;
  mappings: number;
}

export async function applyDocument(store: LibraryStore, doc: SyncDocument): Promise<ApplySummary> {
  const summary: ApplySummary = { series: 0, categories: 0, progress: 0, read: 0, history: 0, mappings: 0 };

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

  for (const row of doc.progress) {
    await store.setProgress(row.chapterId, row.page, row.total);
    summary.progress += 1;
  }

  for (const row of doc.readState) {
    await store.setRead(row.chapterId, row.read);
    summary.read += 1;
  }

  for (const row of doc.history) {
    await store.recordHistory(row.seriesId, row.chapterId, row.at);
    summary.history += 1;
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

  return summary;
}

/**
 * The app's own library: what you added, where you were, what you prefer.
 *
 * Deliberately not the runtime's database. Suwayomi keeps its own library and read
 * state; this store keeps *our* rows so the app opens instantly, works offline and
 * can remember a position the server has no field for. Who wins on progress is
 * decided per provider (`SourceProvider.ownsProgress`), never here.
 */
import type { Chapter, Page, Series } from "../../api/source";
import type { PrefField } from "../extensions/prefs";
import type { InstalledExtension } from "../../api/dalvik";
import type { TrackerAccountRow, TrackerRow } from "../trackers/types";
import { normaliseCategories, type Category } from "../categories";
import { normaliseSourceMarks, type SourceMark } from "../marks";
import type { AlternateMapping } from "../migrate";
import type { LibraryFilter } from "../library/filter";
import type { Database } from "./open";

export interface ProgressRow {
  chapterId: string;
  page: number;
  total: number;
  at: number;
  /** True once the last page has been reached; a later partial read does not clear it. */
  completed?: boolean;
}

/**
 * One sitting in the reader. Progress says where you are; this says how you got there.
 *
 * The fields are the data model, not a convenience: `sourceId` is what lets stats say "time on
 * MangaDex", `pagesRead` is what survives a backward re-read honestly, and `durationSeconds` is
 * stored in seconds because that is the unit every later report wants.
 */
export interface SessionRow {
  id: string;
  /** manga_id: the series this chapter belongs to. */
  seriesId: string;
  /** source_id: the extension's own source id, when the mapping is known. */
  sourceId: string;
  chapterId: string;
  startedAt: number;
  /** Absent while the session is open, so an interrupted read is still visible as unfinished. */
  endedAt?: number;
  startPage: number;
  endPage: number;
  pagesRead: number;
  durationSeconds?: number;
  completedChapter: boolean;
}

/**
 * A title we have seen but not saved.
 *
 * History, Updates and the Continue strip are about series that may never be in the library, and a
 * raw id in a list is not a title. This row is the smallest thing that makes them readable: the name
 * and the cover, kept the first time the app saw the series anywhere.
 */
export interface KnownSeriesRow {
  id: string;
  title: string;
  cover?: string;
  at: number;
}

/** A deletion, kept as a fact so another device cannot resurrect the row. */
export interface TombstoneRow {
  key: string;
  kind: "session" | "history" | "series" | "category" | "bookmark" | "extension";
  id: string;
  at: number;
}

/** What a collection looked like when it was left: the state a tablet must not rebuild. */
export interface ViewStateRow {
  key: string;
  collectionId: string;
  sort?: string;
  view?: string;
  coverSize?: number;
  onlyUnread?: boolean;
  onlySource?: string | null;
  /** The whole filter as one value; older rows only carry the two fields above. */
  filter?: LibraryFilter;
  query?: string;
  scroll?: number;
  selectedSeriesId?: string | null;
  at: number;
}

export interface HistoryRow {
  chapterId: string;
  seriesId: string;
  at: number;
}

export interface PositionRow {
  seriesId: string;
  chapterId: string;
  page: number;
  at: number;
}

export interface RepoRow {
  url: string;
  indexUrl: string;
  name: string;
  at: number;
  /**
   * The repository the app ships with.
   *
   * Pinned rows are seeded on every boot and cannot be removed, because what they list is the app's
   * own provider code: a repository that can be deleted is a source that disappears when the switch
   * beside it still says "on". Its extensions stay removable — only the list is unmovable.
   */
  pinned?: boolean;
}

/** Where a download stands. `downloading` is written when a run starts, so a kill is visible. */
export type DownloadState = "downloading" | "done" | "partial" | "failed";

export interface DownloadRow {
  chapterId: string;
  seriesId: string;
  chapterName: string;
  /** Pages actually stored on this device — not the count the source promised. */
  pages: number;
  bytes: number;
  at: number;
  /** Pages the source said the chapter has. Absent on rows written before it was recorded. */
  total?: number;
  /** Chapter number, so a downloads list can be read in chapter order. */
  number?: number;
  /** Absent on rows written before T15, which were only ever written complete. */
  state?: DownloadState;
  /** Why the last run stopped early, when it stopped early. */
  error?: string;
}

/**
 * One stored page, as the index knows it.
 *
 * `bytes` is the size of the image, recorded when it was written, so a reconcile can total a
 * chapter's weight without opening a single page. `blob` is only present on rows written before the
 * bytes moved to their own store.
 */
export interface DownloadPageMeta {
  id: string;
  chapterId: string;
  index: number;
  bytes?: number;
  blob?: Blob;
}

export interface SourceMappingRow {
  seriesId: string;
  provider: string;
  sourceId: string;
  packageId?: string;
  at: number;
  /**
   * The series id inside the active provider's own id space, when it differs from ours.
   *
   * A title that has been migrated keeps its library id (`seriesId`) and reads from another
   * source's series: `remoteSeriesId` is that source's id. Absent on rows written before
   * migrations existed, where the two were the same string.
   */
  remoteSeriesId?: string;
  /**
   * Sources this title used to live on, oldest first.
   *
   * A migration is a remap, not a one-way door: the previous home stays recorded so the same
   * operation can be run back. `lib/migrate.ts` owns the shape.
   */
  alternates?: AlternateMapping[];
}

interface ChapterRow extends Chapter {
  /** The row's own key. `seriesId` (inherited) is what `byOwner` indexes on. */
  id: string;
}

interface PagesRow {
  chapterId: string;
  urls: string[];
  /** Parallel to `urls`; `null` where a page needs no headers. */
  headers?: Array<Record<string, string> | null>;
}

/**
 * A comic file the user picked — the bytes they already own, kept whole.
 *
 * `pageCount` is read once at import so a chapter row can say how long a book is without opening
 * the archive again. Nothing here is decoded: pages are produced on demand by `lib/files`.
 */
export interface BookRow extends BookMetadata {
  /**
   * The file itself, when this app copied it into the library.
   *
   * Absent for a row that points at a file another app owns (`location`): those bytes stay where
   * Mihon put them and are read on demand, which is the whole point of indexing a download folder
   * rather than importing it. It is absent too in the `books` store itself: the bytes live in
   * `bookFiles`, and `getBook` puts them back.
   */
  blob?: Blob;
}

/** A book as the shelf knows it: everything but the file. */
export interface BookMetadata {
  seriesId: string;
  chapterId: string;
  /** The file's own name, shown when a title is ambiguous. */
  name: string;
  kind: "cbz" | "cbr" | "pdf";
  pageCount: number;
  bytes: number;
  /** Where the pages really live, when they are not ours. */
  location?: BookLocation;
  addedAt: number;
}

/**
 * A book kept somewhere else, readable only through the shell.
 *
 * `kind` names the owner so a future reader — a second app whose layout we index — adds a case
 * instead of another optional field. The path is a document handle, never a filesystem path.
 */
export interface BookLocation {
  kind: "mihondl";
  path: string;
  format: "folder" | "file";
  /** `cbz`/`cbr`/`zip`/`pdf` for a file, empty for a folder of pages. */
  ext: string;
}

export class LibraryStore {
  private readonly db: Database;

  /** The engine itself, for the few things that are storage rather than library (the image cache). */
  readonly database: Database;

  constructor(db: Database) {
    this.db = db;
    this.database = db;
  }

  async addSeries(series: Series): Promise<void> {
    await this.db.put("series", { ...series, addedAt: Date.now() });
  }

  async removeSeries(seriesId: string): Promise<void> {
    await this.db.remove("series", seriesId);
  }

  async listSeries(): Promise<Series[]> {
    const rows = await this.db.all<Series & { addedAt?: number }>("series");
    return rows.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0)).map(({ addedAt: _ignored, ...series }) => series);
  }

  async getSeries(seriesId: string): Promise<Series | undefined> {
    return this.db.get<Series>("series", seriesId);
  }

  /**
   * Give a row a cover without disturbing it.
   *
   * `addSeries` is an upsert, but it also stamps `addedAt`, which is the shelf's order — a book that
   * gained its cover on its first read must not jump to the front of the library for it. A row that
   * is not in the library is left alone: a cover is not a reason to save a title the user skipped.
   */
  async setSeriesCover(seriesId: string, cover: string): Promise<boolean> {
    const row = await this.db.get<Series & { addedAt?: number }>("series", seriesId);
    if (row === undefined) return false;
    await this.db.put("series", { ...row, cover });
    return true;
  }

  async putChapters(seriesId: string, chapters: Chapter[]): Promise<void> {
    for (const chapter of chapters) await this.db.put("chapters", { ...chapter, seriesId } as unknown as Record<string, unknown>);
  }

  async listChapters(seriesId: string): Promise<Chapter[]> {
    // One series, not the whole store: `byOwner` is an index in both engines, so opening a title
    // costs that title rather than every chapter on the device.
    const rows = await this.db.byOwner<ChapterRow>("chapters", seriesId);
    return rows.sort((a, b) => b.number - a.number).map(({ ...chapter }) => chapter);
  }

  /**
   * One chapter row by id.
   *
   * A URL can hand a screen a chapter without its series (`#read/…` from a stale link), and the
   * chapter row is what knows which series owns it — one lookup instead of a full pass.
   */
  async getChapter(chapterId: string): Promise<Chapter | undefined> {
    const row = await this.db.get<ChapterRow>("chapters", chapterId);
    return row === undefined ? undefined : { ...row };
  }

  /**
   * Every mirrored chapter, in one read.
   *
   * The library needs unread counts for every row on the shelf; asking per series would be one
   * IndexedDB round-trip per title, so it is one pass here and the caller groups it.
   */
  async listAllChapters(): Promise<Chapter[]> {
    return this.db.all<ChapterRow>("chapters");
  }

  async putPages(chapterId: string, pages: Page[]): Promise<void> {
    const row: PagesRow = {
      chapterId,
      urls: pages.map((p) => p.url),
      headers: pages.map((p) => p.headers ?? null),
    };
    await this.db.put("pages", row as unknown as Record<string, unknown>);
  }

  async getPages(chapterId: string): Promise<Page[]> {
    const row = await this.db.get<PagesRow>("pages", chapterId);
    return (row?.urls ?? []).map((url, index) => {
      const headers = row?.headers?.[index] ?? undefined;
      return { index, url, ...(headers === null || headers === undefined ? {} : { headers }) };
    });
  }

  /** Every position row, for export and sync (the document carries the whole set). */
  async listProgress(): Promise<ProgressRow[]> {
    return this.db.all<ProgressRow>("progress");
  }

  /** Every preference row, so export can carry the whole set without guessing keys. */
  async listPrefs(): Promise<Array<{ key: string; value: unknown }>> {
    return this.db.all<{ key: string; value: unknown }>("prefs");
  }

  async getProgress(chapterId: string): Promise<ProgressRow | undefined> {
    return this.db.get<ProgressRow>("progress", chapterId);
  }

  /**
   * Write a position. `at` is passed when a row arrives from a backup: the document knows when the
   * reader was there, and stamping it "now" would make every restored position look freshly read.
   */
  async setProgress(chapterId: string, page: number, total: number, at = Date.now()): Promise<void> {
    const previous = await this.getProgress(chapterId);
    const completed = previous?.completed === true || (total > 0 && page >= total - 1);
    const row: ProgressRow = { chapterId, page, total, at, completed };
    await this.db.put("progress", row as unknown as Record<string, unknown>);
  }

  /**
   * Called after a chapter is marked read, so a tracker can push it.
   *
   * Set by `trackers/sync.ts` and by nothing else. Fire-and-forget by contract: the read is already
   * saved when this runs, so it is never awaited and a throw here can never fail the write.
   */
  onReadMark?: (chapter: { id: string; seriesId: string; number: number }) => void;

  /** Local read marks. The providers that own these are `local` and `dalvik`. */
  /**
   * Mark a chapter read or unread.
   *
   * `push: false` is for a *pull*: reconciling a server's own read state must not look like a read
   * that just happened here, or every sync would fire the tracker queue with chapters the user read
   * somewhere else. The mark is written; nothing is announced.
   */
  async setRead(chapterId: string, read: boolean, options: { push?: boolean } = {}): Promise<void> {
    await this.setPref(`read:${chapterId}`, read);
    if (!read || options.push === false || this.onReadMark === undefined) return;
    // Unreading never pushes: a list is a high-water mark, and "I unread chapter 3" is not a fact
    // any tracker can express. The number comes from our own chapter row, because the caller only
    // knows an id.
    const chapter = await this.db.get<Chapter>("chapters", chapterId);
    if (chapter === undefined) return;
    try {
      this.onReadMark({ id: chapter.id, seriesId: chapter.seriesId, number: chapter.number });
    } catch {
      // A tracker is a mirror. The chapter is read; a broken mirror is a retry, not a lost read.
    }
  }

  async isRead(chapterId: string): Promise<boolean> {
    return (await this.getPref<boolean>(`read:${chapterId}`)) === true;
  }

  async getPref<T>(key: string): Promise<T | undefined> {
    const row = await this.db.get<{ key: string; value: T }>("prefs", key);
    return row?.value;
  }

  async setPref<T>(key: string, value: T): Promise<void> {
    await this.db.put("prefs", { key, value });
  }

  /**
   * Forget one preference row.
   *
   * A read mark that has moved to another chapter id is not a mark any more — leaving the old
   * `read:<old id>` row behind would carry a dead fact into every export and could mark a chapter
   * that later happens to reuse that id.
   */
  async removePref(key: string): Promise<void> {
    await this.db.remove("prefs", key);
  }

  // ---- extensions: the APKs this device installed --------------------------
  //
  // The runtime keeps the extension in memory and hands back an id (the sha256 of the
  // APK bytes); it keeps no list of its own and no install route. So the record of what
  // was installed is ours: `extensionId` is the key every later `/dalvik` call names,
  // `packageId` is what the user installed, and `sources` is what that APK exposes —
  // which is why sources can appear on the next launch without resending megabytes.

  async listExtensions(): Promise<InstalledExtension[]> {
    return this.db.all<InstalledExtension>("extensions");
  }

  // ---- titles we have seen but not saved -------------------------------------

  async putKnownSeries(row: KnownSeriesRow): Promise<void> {
    const existing = await this.db.get<KnownSeriesRow>("knownSeries", row.id);
    // Keep the first name, refresh the cover: a source that renames a title should not rewrite
    // history, but a better cover is worth taking.
    // `a ?? b === c ? x : y` binds as `(a ?? (b === c)) ? x : y`, so the old line kept a cover only
    // when the new row had none — every freshly seen title was stored without one, which is why a
    // title read from History but never saved had no thumbnail. The cover is the new one, or the
    // remembered one.
    const cover = row.cover ?? existing?.cover;
    const merged: KnownSeriesRow = {
      id: row.id,
      title: existing?.title ?? row.title,
      ...(cover === undefined || cover === "" ? {} : { cover }),
      at: row.at,
    };
    await this.db.put("knownSeries", merged as unknown as Record<string, unknown>);
  }

  async getKnownSeries(id: string): Promise<KnownSeriesRow | undefined> {
    return this.db.get<KnownSeriesRow>("knownSeries", id);
  }

  async listKnownSeries(): Promise<KnownSeriesRow[]> {
    return this.db.all<KnownSeriesRow>("knownSeries");
  }

  async getExtension(extensionId: string): Promise<InstalledExtension | undefined> {
    return this.db.get<InstalledExtension>("extensions", extensionId);
  }

  async putExtension(extension: InstalledExtension): Promise<void> {
    await this.db.put("extensions", { ...extension } as unknown as Record<string, unknown>);
  }

  async removeExtension(extensionId: string): Promise<void> {
    await this.db.remove("extensions", extensionId);
  }

  // ---- trackers: the user's own list on someone else's service ---------------
  //
  // One row per (series, service). The remote id is the bind; `pending` is the retry queue, kept on
  // the row so a failed push survives a reload. Accounts are a separate store because they are the
  // only rows in this database that hold a secret, and the backup code excludes that store by name.

  async listTrackers(): Promise<TrackerRow[]> {
    return this.db.all<TrackerRow>("trackers");
  }

  async listTrackersForSeries(seriesId: string): Promise<TrackerRow[]> {
    return (await this.db.all<TrackerRow>("trackers")).filter((row) => row.seriesId === seriesId);
  }

  async getTracker(id: string): Promise<TrackerRow | undefined> {
    return this.db.get<TrackerRow>("trackers", id);
  }

  async putTracker(row: TrackerRow): Promise<void> {
    await this.db.put("trackers", { ...row } as unknown as Record<string, unknown>);
  }

  async removeTracker(id: string): Promise<void> {
    await this.db.remove("trackers", id);
  }

  async listTrackerAccounts(): Promise<TrackerAccountRow[]> {
    return this.db.all<TrackerAccountRow>("trackerAccounts");
  }

  async getTrackerAccount(service: string): Promise<TrackerAccountRow | undefined> {
    return this.db.get<TrackerAccountRow>("trackerAccounts", service);
  }

  async putTrackerAccount(row: TrackerAccountRow): Promise<void> {
    await this.db.put("trackerAccounts", { ...row } as unknown as Record<string, unknown>);
  }

  async removeTrackerAccount(service: string): Promise<void> {
    await this.db.remove("trackerAccounts", service);
  }

  // ---- history, position, source mappings -----------------------------------
  //
  // Three answers the library could not give before: what I opened and when, where I was in
  // a series (so "continue" is one row, not a scan), and which source a series came from
  // (so a backup import or a reinstall can find it again).

  async recordHistory(seriesId: string, chapterId: string, at = Date.now()): Promise<void> {
    await this.db.put("history", { chapterId, seriesId, at } as unknown as Record<string, unknown>);
  }

  /** Newest first, one row per chapter — reopening a chapter moves it up, never duplicates. */
  async listHistory(limit = 50): Promise<HistoryRow[]> {
    const rows = await this.db.all<HistoryRow>("history");
    return rows.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  /**
   * How many entries the log holds.
   *
   * The list is capped (a History page draws what it asks for), so a header that counts the rows it
   * was given stops at the cap and reads as a total. This is the number that makes "the newest 200
   * of N" sayable.
   */
  async countHistory(): Promise<number> {
    return (await this.db.all<HistoryRow>("history")).length;
  }

  /** Where the reader was in a series. One row per series, so it is a lookup, not a scan. */
  async setPosition(seriesId: string, chapterId: string, page: number, at = Date.now()): Promise<void> {
    await this.db.put("position", { seriesId, chapterId, page, at } as unknown as Record<string, unknown>);
  }

  async getPosition(seriesId: string): Promise<PositionRow | undefined> {
    return this.db.get<PositionRow>("position", seriesId);
  }

  /**
   * Forget where the reader was in a series.
   *
   * Only a migration uses this, and only when the chapter the row names did not come across: a
   * bookmark into a chapter the title no longer has would offer Continue at a dead end.
   */
  async removePosition(seriesId: string): Promise<void> {
    await this.db.remove("position", seriesId);
  }

  async listPositions(): Promise<PositionRow[]> {
    const rows = await this.db.all<PositionRow>("position");
    return rows.sort((a, b) => b.at - a.at);
  }

  /**
   * The source a series came from, in the terms a backup or a reinstall needs: the provider,
   * the extension's own source id and, when known, the APK's package id.
   */
  async putMapping(mapping: SourceMappingRow): Promise<void> {
    await this.db.put("mappings", { ...mapping } as unknown as Record<string, unknown>);
  }

  async getMapping(seriesId: string): Promise<SourceMappingRow | undefined> {
    return this.db.get<SourceMappingRow>("mappings", seriesId);
  }

  async listMappings(): Promise<SourceMappingRow[]> {
    return this.db.all<SourceMappingRow>("mappings");
  }

  // ---- migrating a title between sources -----------------------------------
  //
  // A migration rewrites what belongs to one chapter id (a read mark, a position, a history row, a
  // download) onto another, and replaces the title's chapter list. These are the primitives for
  // that; the rules that decide *which* chapter maps to which are in `lib/migrate.ts`, and the
  // sequence is in `state/library.svelte.ts#migrate`. Keeping them primitive is what lets the
  // migration be one pass with no second interpretation of the same rules.

  /** Write a progress row verbatim, including `completed` and `at` from where it came. */
  async putProgress(row: ProgressRow): Promise<void> {
    await this.db.put("progress", { ...row } as unknown as Record<string, unknown>);
  }

  async removeProgress(chapterId: string): Promise<void> {
    await this.db.remove("progress", chapterId);
  }

  /** Remove one history row. Not a deletion the user made, so it writes no tombstone. */
  async removeHistory(chapterId: string): Promise<void> {
    await this.db.remove("history", chapterId);
  }

  async removeChapter(chapterId: string): Promise<void> {
    await this.db.remove("chapters", chapterId);
  }

  /** Patch the stored series row without restamping `addedAt` — a migration is not a re-add. */
  async updateSeries(seriesId: string, patch: Partial<Series>): Promise<void> {
    const row = await this.db.get<Record<string, unknown>>("series", seriesId);
    if (row === undefined) return;
    await this.db.put("series", { ...row, ...patch, id: seriesId });
  }

  /**
   * Move a downloaded chapter's pages onto another chapter id.
   *
   * The bytes are the same images; only the id the reader asks under changed. A page row is keyed
   * `${chapterId}#${index}`, so each one is rewritten — the blob is passed through, never copied
   * through a decode.
   */
  async rekeyDownload(fromChapterId: string, toChapterId: string): Promise<void> {
    if (fromChapterId === toChapterId) return;
    const row = await this.db.get<DownloadRow>("downloads", fromChapterId);
    if (row === undefined) return;
    await this.db.put("downloads", { ...row, chapterId: toChapterId } as unknown as Record<string, unknown>);
    // Only this chapter's keys are read: the old shape walked every page on the device to find the
    // ones that belonged to it.
    for (const page of await this.downloadPageMeta(fromChapterId)) {
      const id = `${toChapterId}#${page.index}`;
      await this.db.put("downloadPages", { ...page, id, chapterId: toChapterId });
      const bytes = await this.db.get<{ id: string; blob: Blob }>("downloadPageData", page.id);
      if (bytes !== undefined) {
        await this.db.put("downloadPageData", { id, blob: bytes.blob });
        await this.db.remove("downloadPageData", page.id);
      }
      await this.db.remove("downloadPages", page.id);
    }
    await this.db.remove("downloads", fromChapterId);
  }

  // ---- extension repositories ----------------------------------------------
  //
  // A repository is remembered by the URL the user pasted, not by its index URL: that is
  // what they can recognise and remove later, and the index name is only a label.

  async listRepos(): Promise<RepoRow[]> {
    const rows = await this.db.all<RepoRow>("repos");
    return rows.sort((a, b) => a.at - b.at);
  }

  async putRepo(row: RepoRow): Promise<void> {
    await this.db.put("repos", { ...row } as unknown as Record<string, unknown>);
  }

  async removeRepo(url: string): Promise<void> {
    const row = await this.db.get<RepoRow>("repos", url);
    if (row?.pinned === true) {
      throw new Error(`${row.name} is the app's own repository and cannot be removed`);
    }
    await this.db.remove("repos", url);
  }

  // ---- downloads: pages that live on this device ---------------------------
  //
  // Two stores: one row per downloaded chapter (what the Downloads screen lists) and one row
  // per page (the blob itself). They are separate because deleting a chapter has to remove its
  // pages, and because a half-finished download must never look like a finished one.

  async listDownloads(): Promise<DownloadRow[]> {
    const rows = await this.db.all<DownloadRow>("downloads");
    return rows.sort((a, b) => b.at - a.at);
  }

  async putDownload(row: DownloadRow): Promise<void> {
    await this.db.put("downloads", { ...row } as unknown as Record<string, unknown>);
  }

  async removeDownload(chapterId: string): Promise<void> {
    await this.db.remove("downloads", chapterId);
    for (const page of await this.downloadPageMeta(chapterId)) {
      await this.db.remove("downloadPages", page.id);
      await this.db.remove("downloadPageData", page.id);
    }
  }

  /**
   * One chapter's page rows, without their image bytes.
   *
   * This is what a reconcile and a "how many pages are really here" check needs: index, chapter and
   * size. It reads one chapter's keys, not the whole download folder.
   */
  async downloadPageMeta(chapterId: string): Promise<DownloadPageMeta[]> {
    return this.db.prefix<DownloadPageMeta>("downloadPages", `${chapterId}#`);
  }

  /** Every page row on the device, metadata only — the launch reconcile's read (#STAB-09). */
  async allDownloadPageMeta(): Promise<DownloadPageMeta[]> {
    return this.db.all<DownloadPageMeta>("downloadPages");
  }

  /**
   * One chapter's pages, with the bytes.
   *
   * The reader's path. The metadata rows say which indexes exist, so a chapter whose fourth page
   * failed still reports four pages rather than three, and each blob is fetched by its own key.
   */
  async listDownloadPages(chapterId: string): Promise<Array<{ index: number; blob: Blob }>> {
    const rows = await this.downloadPageMeta(chapterId);
    const pages = await Promise.all(
      rows.map(async (row) => {
        if (row.blob !== undefined) return { index: row.index, blob: row.blob }; // row from before the split
        const bytes = await this.db.get<{ id: string; blob: Blob }>("downloadPageData", row.id);
        return bytes === undefined ? null : { index: row.index, blob: bytes.blob };
      }),
    );
    return pages.filter((page): page is { index: number; blob: Blob } => page !== null);
  }

  /**
   * Every stored page row, with its bytes.
   *
   * Nothing on a hot path uses this any more — the reconcile reads `allDownloadPageMeta` and the
   * reader asks per chapter — but a caller that genuinely wants every image still can.
   */
  async allDownloadPages(): Promise<Array<{ id: string; chapterId: string; index: number; blob: Blob }>> {
    const rows = await this.db.all<DownloadPageMeta & { blob?: Blob }>("downloadPages");
    const pages = await Promise.all(
      rows.map(async (row) => {
        if (row.blob !== undefined) return { id: row.id, chapterId: row.chapterId, index: row.index, blob: row.blob };
        const bytes = await this.db.get<{ id: string; blob: Blob }>("downloadPageData", row.id);
        return bytes === undefined
          ? null
          : { id: row.id, chapterId: row.chapterId, index: row.index, blob: bytes.blob };
      }),
    );
    return pages.filter((page): page is { id: string; chapterId: string; index: number; blob: Blob } => page !== null);
  }

  /** Store one page: the bytes in their own row, the description in the index. */
  async putDownloadPage(row: { id: string; chapterId: string; index: number; blob: Blob }): Promise<void> {
    await this.db.put("downloadPages", {
      id: row.id,
      chapterId: row.chapterId,
      index: row.index,
      bytes: row.blob.size,
    });
    await this.db.put("downloadPageData", { id: row.id, blob: row.blob });
  }

  // ---- categories: hidden + pinned -----------------------------------------
  //
  // In HardlyReader these two marks live in a FreshRSS extension that writes
  // `feed.priority`. Here the library is ours, so they are rows in our own
  // database: nothing is written to the Mihon runtime, and there is no "Strict"
  // mode to reconcile because there is no second authority.

  // ---- reading sessions, view state, extension preferences, sync bookkeeping ----
  //
  // Sessions are history with a clock: they answer "how long, and how much", which a single
  // progress row cannot. View state is per collection, because the point of a tablet library is
  // that Reading opens where you left Reading. Extension preferences belong to the extension that
  // asked for them, never to the app's own settings bag. Sync metadata is local bookkeeping —
  // when this device last mirrored, and under which device id.

  /** Open a session and return its id. Closed by `endSession`, or left open if the app dies. */
  async beginSession(
    input: { seriesId: string; sourceId?: string; chapterId: string; startPage: number },
    at = Date.now(),
  ): Promise<string> {
    const id = `${input.chapterId}@${at}`;
    const row: SessionRow = {
      id,
      seriesId: input.seriesId,
      sourceId: input.sourceId ?? "",
      chapterId: input.chapterId,
      startedAt: at,
      startPage: input.startPage,
      endPage: input.startPage,
      pagesRead: 1,
      completedChapter: false,
    };
    await this.db.put("sessions", row as unknown as Record<string, unknown>);
    return id;
  }

  /**
   * Close a session: end page, wall-clock end, pages read and the time spent.
   *
   * `durationSeconds` is measured from the start, which is only honest because a session is closed
   * when the reader goes away or goes idle — background time inside a session is at most the grace
   * period, not the whole night.
   */
  async endSession(
    id: string,
    end: { endPage: number; completed?: boolean; at?: number },
  ): Promise<void> {
    const row = await this.db.get<SessionRow>("sessions", id);
    if (row === undefined || row.endedAt !== undefined) return;
    const at = end.at ?? Date.now();
    const closed: SessionRow = {
      ...row,
      endPage: end.endPage,
      pagesRead: Math.abs(end.endPage - row.startPage) + 1,
      endedAt: at,
      durationSeconds: Math.max(Math.round((at - row.startedAt) / 1000), 0),
      completedChapter: end.completed === true,
    };
    await this.db.put("sessions", closed as unknown as Record<string, unknown>);
  }

  /** A session that arrived from a backup or another device, written as it travelled. */
  async putSession(row: SessionRow): Promise<void> {
    await this.db.put("sessions", { ...row } as unknown as Record<string, unknown>);
  }

  async clearSession(id: string): Promise<void> {
    await this.db.remove("sessions", id);
  }

  async listSessions(limit = 200): Promise<SessionRow[]> {
    const rows = await this.db.all<SessionRow>("sessions");
    return rows.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }

  /** The last session for a chapter, so a quick return can continue it instead of adding a row. */
  async lastSessionFor(chapterId: string): Promise<SessionRow | undefined> {
    const rows = (await this.listSessions(Number.POSITIVE_INFINITY)).filter((row) => row.chapterId === chapterId);
    return rows[0];
  }

  async sessionsFor(seriesId: string): Promise<SessionRow[]> {
    return (await this.listSessions(Number.POSITIVE_INFINITY)).filter((row) => row.seriesId === seriesId);
  }

  /** The remembered view of one collection. Keyed `collectionId`; `all` for the unfiltered library. */
  async getViewState(collectionId: string): Promise<ViewStateRow | undefined> {
    return this.db.get<ViewStateRow>("viewState", collectionId);
  }

  async setViewState(state: Omit<ViewStateRow, "key" | "at">): Promise<void> {
    const row: ViewStateRow = { ...state, key: state.collectionId, at: Date.now() };
    await this.db.put("viewState", row as unknown as Record<string, unknown>);
  }

  /** Preferences an extension asked to keep — scoped by extension id, so two cannot collide. */
  async getExtensionPref<T>(extensionId: string, key: string): Promise<T | undefined> {
    const row = await this.db.get<{ key: string; value: T }>("extensionPrefs", `${extensionId}:${key}`);
    return row?.value;
  }

  async setExtensionPref<T>(extensionId: string, key: string, value: T): Promise<void> {
    await this.db.put("extensionPrefs", { key: `${extensionId}:${key}`, value });
  }

  /**
   * A source's settings screen, as the user left it.
   *
   * Stored as fields (key, kind, value) rather than as bare values: a call has to be able to turn
   * them back into the runtime's typed wire shape, and `"false"` is not `false` to an extension.
   */
  async getSourcePrefs(sourceId: string): Promise<PrefField[] | undefined> {
    return this.getExtensionPref<PrefField[]>("prefs", sourceId);
  }

  async setSourcePrefs(sourceId: string, fields: PrefField[]): Promise<void> {
    await this.setExtensionPref("prefs", sourceId, fields);
  }

  /**
   * A comic file the user picked, kept whole.
   *
   * The bytes are stored, not the pages: a 300 MB CBZ must not become 300 MB of decoded images in
   * this database, and the reader only ever needs one page at a time. `pageCount` is read once at
   * import so the chapter row can say how long the book is without opening it again.
   */
  async putBook(book: BookRow): Promise<void> {
    // The file and its description are two rows on purpose: listing a shelf asks "what is here and
    // how big is it", and the answer must not carry 300 MB of CBZ through the IPC bridge to say so.
    // The bytes live in `bookFiles`, keyed by the same series id, and are read only when a page of
    // that book is actually requested.
    const { blob, ...metadata } = book;
    await this.db.put("books", metadata as unknown as Record<string, unknown>);
    if (blob !== undefined) {
      await this.db.put("bookFiles", { seriesId: book.seriesId, blob });
    } else {
      // A row that points at a file another app owns has no bytes of ours to keep.
      await this.db.remove("bookFiles", book.seriesId);
    }
  }

  async getBook(seriesId: string): Promise<BookRow | undefined> {
    const row = await this.db.get<BookRow>("books", seriesId);
    if (row === undefined) return undefined;
    // Rows written before the split carry their own `blob`; newer ones keep it in `bookFiles`.
    if (row.blob !== undefined) return row;
    const bytes = await this.db.get<{ seriesId: string; blob: Blob }>("bookFiles", seriesId);
    return bytes === undefined ? row : { ...row, blob: bytes.blob };
  }

  /**
   * What is on the shelf, without the comic files.
   *
   * This is the call for statistics, import checks and "do I already have this title": it never
   * reads a byte of a CBZ. `getBook` is the call that needs the file.
   */
  async listBookMetadata(): Promise<BookMetadata[]> {
    const rows = await this.db.all<BookRow & { blob?: Blob }>("books");
    // A row from before the split still has its file inline; drop it here rather than pretend the
    // read was free, and let the next write move it.
    return rows.map(({ blob: _blob, ...row }) => row);
  }

  async listBooks(): Promise<BookRow[]> {
    const rows = await this.db.all<BookRow>("books");
    return Promise.all(
      rows.map(async (row) => {
        if (row.blob !== undefined) return row;
        const bytes = await this.db.get<{ seriesId: string; blob: Blob }>("bookFiles", row.seriesId);
        return bytes === undefined ? row : { ...row, blob: bytes.blob };
      }),
    );
  }

  async removeBook(seriesId: string): Promise<void> {
    await this.db.remove("books", seriesId);
    await this.db.remove("bookFiles", seriesId);
  }

  /** A cached source search answer, so a repeated query paints before the network does. */
  async getSearchCache<T>(key: string): Promise<T | undefined> {
    const row = await this.db.get<{ key: string; value: T }>("searchCache", key);
    return row?.value;
  }

  async putSearchCache<T>(key: string, value: T): Promise<void> {
    await this.db.put("searchCache", { key, value });
  }

  /**
   * What the source-answer cache is holding.
   *
   * Measured rather than counted: a search answer is a list of titles, and "12 cached searches"
   * says nothing about whether clearing it is worth anything. The bytes are the JSON the row
   * already holds, which is what the disk will get back.
   */
  async searchCacheSize(): Promise<{ rows: number; bytes: number }> {
    const rows = await this.db.all<{ key: string; value: unknown }>("searchCache");
    let bytes = 0;
    for (const row of rows) {
      try {
        bytes += new TextEncoder().encode(JSON.stringify(row.value)).length;
      } catch {
        // A row that cannot be measured is still a row; it counts, its size does not.
      }
    }
    return { rows: rows.length, bytes };
  }

  /** Forget one stored answer — the "Try again" on a card the source refused to fill. */
  async removeSearchCache(key: string): Promise<void> {
    await this.db.remove("searchCache", key);
  }

  async clearSearchCache(): Promise<void> {
    for (const row of await this.db.all<{ key: string }>("searchCache")) await this.db.remove("searchCache", row.key);
  }

  async getSyncMeta<T>(key: string): Promise<T | undefined> {
    const row = await this.db.get<{ key: string; value: T }>("syncMeta", key);
    return row?.value;
  }

  async setSyncMeta<T>(key: string, value: T): Promise<void> {
    await this.db.put("syncMeta", { key, value });
  }

  /**
   * Forget what was read, keep where you are.
   *
   * Privacy means the log, not the bookmark: clearing history must not turn a half-read chapter
   * into an unread one or drop Continue Reading back to the start. `progress`, `position`, read
   * marks, library rows, categories and downloads are not touched — that separation is the whole
   * point of `reading_sessions` being its own table.
   *
   * A range clear (`since`/`until`) keeps the rest; a full clear passes neither. Every deleted row
   * leaves a tombstone, so a sync merge cannot bring it back from another device.
   */
  /** User deletion of selected chapter logs; bookmarks and read marks are deliberately untouched. */
  async removeHistoryEntries(chapterIds: readonly string[]): Promise<{ sessions: number; history: number }> {
    const ids = new Set(chapterIds);
    const at = Date.now();
    let sessions = 0;
    let history = 0;
    for (const row of await this.db.all<SessionRow>("sessions")) {
      if (!ids.has(row.chapterId)) continue;
      await this.db.remove("sessions", row.id);
      await this.recordTombstone("session", row.id, at);
      sessions += 1;
    }
    for (const row of await this.db.all<HistoryRow>("history")) {
      if (!ids.has(row.chapterId)) continue;
      await this.db.remove("history", row.chapterId);
      await this.recordTombstone("history", row.chapterId, at);
      history += 1;
    }
    return { sessions, history };
  }

  async clearHistory(range: { since?: number; until?: number } = {}): Promise<{ sessions: number; history: number }> {
    const inRange = (at: number): boolean =>
      (range.since === undefined || at >= range.since) && (range.until === undefined || at < range.until);
    const at = Date.now();
    let sessions = 0;
    let history = 0;
    for (const row of await this.db.all<SessionRow>("sessions")) {
      if (!inRange(row.startedAt)) continue;
      await this.db.remove("sessions", row.id);
      await this.recordTombstone("session", row.id, at);
      sessions += 1;
    }
    for (const row of await this.db.all<HistoryRow>("history")) {
      if (!inRange(row.at)) continue;
      await this.db.remove("history", row.chapterId);
      await this.recordTombstone("history", row.chapterId, at);
      history += 1;
    }
    return { sessions, history };
  }

  /**
   * Delete sessions past the retention window. `days <= 0` keeps everything.
   *
   * Only sessions age out. Progress, read marks, positions, library rows, categories and downloads
   * have no retention: they are state, not a log.
   */
  async pruneSessions(days: number, now = Date.now()): Promise<number> {
    if (days <= 0) return 0;
    const cutoff = now - days * 86_400_000;
    let removed = 0;
    for (const row of await this.db.all<SessionRow>("sessions")) {
      // An open session is the read in progress, not history yet.
      if (row.endedAt === undefined || row.startedAt >= cutoff) continue;
      await this.db.remove("sessions", row.id);
      await this.recordTombstone("session", row.id, now);
      removed += 1;
    }
    return removed;
  }

  async recordTombstone(kind: TombstoneRow["kind"], id: string, at = Date.now()): Promise<void> {
    const key = `${kind}:${id}`;
    await this.db.put("tombstones", { key, kind, id, at } as unknown as Record<string, unknown>);
  }

  async listTombstones(): Promise<TombstoneRow[]> {
    return this.db.all<TombstoneRow>("tombstones");
  }

  async listCategories(): Promise<Category[]> {
    return normaliseCategories(await this.db.all<Category>("categories"));
  }

  async putCategory(category: Category): Promise<void> {
    await this.db.put("categories", { ...category } as unknown as Record<string, unknown>);
  }

  async removeCategory(categoryId: string): Promise<void> {
    await this.db.remove("categories", categoryId);
    // Membership lives on the series rows, so a deleted category must be taken off
    // them too — otherwise a row keeps pointing at an id nothing resolves.
    for (const series of await this.listSeries()) {
      const ids = series.categoryIds ?? [];
      if (!ids.includes(categoryId)) continue;
      await this.setSeriesCategories(series.id, ids.filter((id) => id !== categoryId));
    }
  }

  async setSeriesCategories(seriesId: string, categoryIds: string[]): Promise<void> {
    // Read the row with its `addedAt`: filing a title is not adding one, and the shelf's order is
    // `addedAt`. Stamping it here moved every title you filed into to the front of the library —
    // the same "it jumped for no reason" bug `setSeriesCover` is careful about.
    const row = await this.db.get<Series & { addedAt?: number }>("series", seriesId);
    if (row === undefined) throw new Error(`not in the library: ${seriesId}`);
    await this.db.put("series", { ...row, categoryIds });
  }

  /**
   * Source marks: the same eye and pin, on the source a title came from.
   *
   * A row is written only when a mark is actually set — an unmarked source has no row, which is what
   * keeps the store honest about "never touched" versus "unhidden on purpose".
   */
  async listSourceMarks(): Promise<SourceMark[]> {
    return normaliseSourceMarks(await this.db.all<SourceMark>("sourceMarks"));
  }

  async putSourceMark(mark: SourceMark): Promise<void> {
    // A row is kept while any of the three marks is on; "all off" is the untouched state.
    if (!mark.hidden && !mark.pinned && !mark.incognito) {
      await this.db.remove("sourceMarks", mark.id);
      return;
    }
    await this.db.put("sourceMarks", { ...mark } as unknown as Record<string, unknown>);
  }

  /** Series that belong to one category, for the rail's selection. */
  async seriesInCategory(categoryId: string): Promise<Series[]> {
    return (await this.listSeries()).filter((s) => (s.categoryIds ?? []).includes(categoryId));
  }
}

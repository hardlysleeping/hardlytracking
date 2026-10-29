/**
 * The app's own library: what you added, where you were, what you prefer.
 *
 * Deliberately not the runtime's database. Suwayomi keeps its own library and read
 * state; this store keeps *our* rows so the app opens instantly, works offline and
 * can remember a position the server has no field for. Who wins on progress is
 * decided per provider (`SourceProvider.ownsProgress`), never here.
 */
import type { Chapter, Page, Series } from "../../api/source";
import type { InstalledExtension } from "../../api/dalvik";
import { normaliseCategories, type Category } from "../categories";
import type { Database } from "./open";

export interface ProgressRow {
  chapterId: string;
  page: number;
  total: number;
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
}

export interface DownloadRow {
  chapterId: string;
  seriesId: string;
  chapterName: string;
  pages: number;
  bytes: number;
  at: number;
}

export interface SourceMappingRow {
  seriesId: string;
  provider: string;
  sourceId: string;
  packageId?: string;
  at: number;
}

interface ChapterRow extends Chapter {
  /** Present so `all("chapters")` can be filtered without an index. */
  id: string;
}

interface PagesRow {
  chapterId: string;
  urls: string[];
  /** Parallel to `urls`; `null` where a page needs no headers. */
  headers?: Array<Record<string, string> | null>;
}

export class LibraryStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
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

  async putChapters(seriesId: string, chapters: Chapter[]): Promise<void> {
    for (const chapter of chapters) await this.db.put("chapters", { ...chapter, seriesId } as unknown as Record<string, unknown>);
  }

  async listChapters(seriesId: string): Promise<Chapter[]> {
    const rows = await this.db.all<ChapterRow>("chapters");
    return rows
      .filter((c) => c.seriesId === seriesId)
      .sort((a, b) => b.number - a.number)
      .map(({ ...chapter }) => chapter);
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

  async setProgress(chapterId: string, page: number, total: number): Promise<void> {
    const row: ProgressRow = { chapterId, page, total, at: Date.now() };
    await this.db.put("progress", row as unknown as Record<string, unknown>);
  }

  /** Local read marks. The providers that own these are `local` and `dalvik`. */
  async setRead(chapterId: string, read: boolean): Promise<void> {
    await this.setPref(`read:${chapterId}`, read);
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

  async putExtension(extension: InstalledExtension): Promise<void> {
    await this.db.put("extensions", { ...extension } as unknown as Record<string, unknown>);
  }

  async removeExtension(extensionId: string): Promise<void> {
    await this.db.remove("extensions", extensionId);
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

  /** Where the reader was in a series. One row per series, so it is a lookup, not a scan. */
  async setPosition(seriesId: string, chapterId: string, page: number, at = Date.now()): Promise<void> {
    await this.db.put("position", { seriesId, chapterId, page, at } as unknown as Record<string, unknown>);
  }

  async getPosition(seriesId: string): Promise<PositionRow | undefined> {
    return this.db.get<PositionRow>("position", seriesId);
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
    for (const page of await this.listDownloadPages(chapterId)) {
      await this.db.remove("downloadPages", `${chapterId}#${page.index}`);
    }
  }

  async listDownloadPages(chapterId: string): Promise<Array<{ index: number; blob: Blob }>> {
    const rows = await this.db.all<{ id: string; chapterId: string; index: number; blob: Blob }>("downloadPages");
    return rows.filter((row) => row.chapterId === chapterId).map(({ index, blob }) => ({ index, blob }));
  }

  async putDownloadPage(row: { id: string; chapterId: string; index: number; blob: Blob }): Promise<void> {
    await this.db.put("downloadPages", { ...row } as unknown as Record<string, unknown>);
  }

  // ---- categories: hidden + pinned -----------------------------------------
  //
  // In HardlyReader these two marks live in a FreshRSS extension that writes
  // `feed.priority`. Here the library is ours, so they are rows in our own
  // database: nothing is written to the Mihon runtime, and there is no "Strict"
  // mode to reconcile because there is no second authority.

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
    const series = await this.getSeries(seriesId);
    if (series === undefined) throw new Error(`not in the library: ${seriesId}`);
    await this.db.put("series", { ...series, categoryIds, addedAt: Date.now() } as unknown as Record<string, unknown>);
  }

  /** Series that belong to one category, for the rail's selection. */
  async seriesInCategory(categoryId: string): Promise<Series[]> {
    return (await this.listSeries()).filter((s) => (s.categoryIds ?? []).includes(categoryId));
  }
}

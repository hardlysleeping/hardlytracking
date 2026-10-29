/**
 * The app's own library: what you added, where you were, what you prefer.
 *
 * Deliberately not the runtime's database. Suwayomi keeps its own library and read
 * state; this store keeps *our* rows so the app opens instantly, works offline and
 * can remember a position the server has no field for. Who wins on progress is
 * decided per provider (`SourceProvider.ownsProgress`), never here.
 */
import type { Chapter, Page, Series } from "../../api/source";
import type { Database } from "./open";

export interface ProgressRow {
  chapterId: string;
  page: number;
  total: number;
  at: number;
}

interface ChapterRow extends Chapter {
  /** Present so `all("chapters")` can be filtered without an index. */
  id: string;
}

interface PagesRow {
  chapterId: string;
  urls: string[];
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

  async putPages(chapterId: string, pages: Page[]): Promise<void> {
    const row: PagesRow = { chapterId, urls: pages.map((p) => p.url) };
    await this.db.put("pages", row as unknown as Record<string, unknown>);
  }

  async getPages(chapterId: string): Promise<Page[]> {
    const row = await this.db.get<PagesRow>("pages", chapterId);
    return (row?.urls ?? []).map((url, index) => ({ index, url }));
  }

  async getProgress(chapterId: string): Promise<ProgressRow | undefined> {
    return this.db.get<ProgressRow>("progress", chapterId);
  }

  async setProgress(chapterId: string, page: number, total: number): Promise<void> {
    const row: ProgressRow = { chapterId, page, total, at: Date.now() };
    await this.db.put("progress", row as unknown as Record<string, unknown>);
  }

  /** Local read marks. The only provider that owns these is `local`. */
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
}

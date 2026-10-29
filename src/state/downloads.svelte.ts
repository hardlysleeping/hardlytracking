/**
 * Downloads: pages kept on this device, so a chapter opens with no network at all.
 *
 * A download is the chapter's page list, fetched once and stored as blobs in the library
 * database. Nothing about it goes through the runtime afterwards — that is the point: the
 * extension host can be down, offline or unreachable and the chapter still reads.
 *
 * One chapter at a time, deliberately. A phone running six extension fetches at once is how a
 * queue becomes a memory spike, and a manga chapter is 20–60 images.
 */
import { library } from "./library.svelte";
import type { Chapter } from "../api/source";
import type { DownloadRow } from "../lib/db/store";
import { imageSrc } from "../lib/pages";

export type { DownloadRow };

export interface Progress {
  chapterId: string;
  done: number;
  total: number;
}

class Downloads {
  rows = $state<DownloadRow[]>([]);
  queue = $state<Array<{ chapterId: string; seriesId: string; chapterName: string }>>([]);
  active = $state<Progress | null>(null);
  error = $state<string | null>(null);

  private running = false;
  /** Object URLs handed to the reader, so they can be revoked when a chapter is deleted. */
  private cache = new Map<string, string[]>();

  async load(): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) return;
    this.rows = await store.listDownloads();
  }

  get bytes(): number {
    return this.rows.reduce((sum, row) => sum + row.bytes, 0);
  }

  isDownloaded(chapterId: string): boolean {
    return this.rows.some((row) => row.chapterId === chapterId);
  }

  inQueue(chapterId: string): boolean {
    return this.active?.chapterId === chapterId || this.queue.some((item) => item.chapterId === chapterId);
  }

  /** Queue a chapter. A duplicate is ignored rather than downloaded twice. */
  enqueue(seriesId: string, chapter: Chapter): void {
    if (this.isDownloaded(chapter.id) || this.inQueue(chapter.id)) return;
    this.queue = [...this.queue, { chapterId: chapter.id, seriesId, chapterName: chapter.name }];
    void this.run();
  }

  enqueueMany(seriesId: string, chapters: Chapter[]): void {
    for (const chapter of chapters) {
      if (this.isDownloaded(chapter.id) || this.inQueue(chapter.id)) continue;
      this.queue = [...this.queue, { chapterId: chapter.id, seriesId, chapterName: chapter.name }];
    }
    void this.run();
  }

  cancel(chapterId: string): void {
    this.queue = this.queue.filter((item) => item.chapterId !== chapterId);
  }

  private async run(): Promise<void> {
    if (this.running) return;
    const store = library.profile?.store;
    if (store === undefined) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue[0];
        this.queue = this.queue.slice(1);
        this.active = { chapterId: next.chapterId, done: 0, total: 0 };
        try {
          const pages = await library.pages(next.chapterId);
          this.active = { chapterId: next.chapterId, done: 0, total: pages.length };
          let bytes = 0;
          for (const page of pages) {
            const response = await fetch(imageSrc(page));
            if (!response.ok) throw new Error(`page ${page.index + 1}: HTTP ${response.status}`);
            const blob = await response.blob();
            bytes += blob.size;
            await store.putDownloadPage({
              id: `${next.chapterId}#${page.index}`,
              chapterId: next.chapterId,
              index: page.index,
              blob,
            });
            this.active = { chapterId: next.chapterId, done: page.index + 1, total: pages.length };
          }
          await store.putDownload({
            chapterId: next.chapterId,
            seriesId: next.seriesId,
            chapterName: next.chapterName,
            pages: pages.length,
            bytes,
            at: Date.now(),
          });
          await this.load();
        } catch (error) {
          // One failed chapter must not stop the queue; it is reported and skipped.
          this.error = `${next.chapterName}: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
          this.active = null;
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * The pages of a downloaded chapter, as object URLs the reader can put in an `<img>`.
   *
   * Cached per chapter: rebuilding them on every page turn would leak a URL per render.
   */
  async urls(chapterId: string): Promise<string[] | null> {
    const cached = this.cache.get(chapterId);
    if (cached !== undefined) return cached;
    const store = library.profile?.store;
    if (store === undefined) return null;
    const rows = await store.listDownloadPages(chapterId);
    if (rows.length === 0) return null;
    const urls = rows.sort((a, b) => a.index - b.index).map((row) => URL.createObjectURL(row.blob));
    this.cache.set(chapterId, urls);
    return urls;
  }

  async remove(chapterId: string): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) return;
    for (const url of this.cache.get(chapterId) ?? []) URL.revokeObjectURL(url);
    this.cache.delete(chapterId);
    await store.removeDownload(chapterId);
    await this.load();
  }

  async removeSeries(seriesId: string): Promise<void> {
    for (const row of this.rows.filter((item) => item.seriesId === seriesId)) {
      await this.remove(row.chapterId);
    }
  }
}

export const downloads = new Downloads();

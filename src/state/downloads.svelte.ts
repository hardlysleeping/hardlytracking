/**
 * Downloads: pages kept on this device, so a chapter opens with no network at all.
 *
 * A download is the chapter's page list, fetched once and stored as blobs in the library
 * database. Nothing about it goes through the runtime afterwards — that is the point: the
 * extension host can be down, offline or unreachable and the chapter still reads.
 *
 * One chapter at a time, deliberately. A phone running six extension fetches at once is how a
 * queue becomes a memory spike, and a manga chapter is 20–60 images.
 *
 * The decisions — what is complete, what runs next, what a reload resumes — are in
 * `lib/downloads/state.ts`, and the work is in `lib/downloads/engine.ts`. This file is the
 * reactive shell: `$state` fields the views read, and the two dependencies the engine cannot own
 * (the open library, and `fetch` through `/api/img`).
 */
import { library } from "./library.svelte";
import type { Chapter, Page } from "../api/source";
import type { DownloadRow } from "../lib/db/store";
import { DownloadEngine, type DownloadHost, type LocalChapter } from "../lib/downloads/engine";
import { isComplete, type Progress, type QueueItem } from "../lib/downloads/state";
import { imageSrc } from "../lib/pages";
import { workBudget } from "../lib/performance";
import { settings } from "./settings.svelte";

export type { DownloadRow, LocalChapter, Progress, QueueItem };

class Downloads implements DownloadHost {
  rows = $state<DownloadRow[]>([]);
  queue = $state<QueueItem[]>([]);
  active = $state<Progress | null>(null);
  error = $state<string | null>(null);

  private engine: DownloadEngine | null = null;
  private engineStore: unknown = null;

  /** The engine for the open library, built once per opened store. */
  private worker(): DownloadEngine | null {
    const store = library.profile?.store;
    if (store === undefined) return null;
    if (this.engine === null || this.engineStore !== store) {
      this.engine = new DownloadEngine(this, {
        store,
        // The page list is the one thing that has to come from the source; a host that is down
        // throws here and the chapter is recorded as failed rather than as an empty chapter.
        pages: (chapterId: string) => library.pages(chapterId),
        fetchBlob: (page: Page, timeoutMs?: number) => fetchPage(page, timeoutMs),
        // The Performance setting decides how many pages are in flight and whether the queue paces
        // itself; read lazily so a change applies to the next chapter, not the next reload.
        budget: () => workBudget(settings.cpuLevel),
      });
      this.engineStore = store;
    }
    return this.engine;
  }

  /** Read the device, fix any row that lies, and bring the queue back after a reload. */
  async load(): Promise<void> {
    await this.worker()?.load();
  }

  get bytes(): number {
    return this.rows.reduce((sum, row) => sum + row.bytes, 0);
  }

  /** A chapter whose pages are all here. A partial one is not "downloaded" — it is on its way. */
  isDownloaded(chapterId: string): boolean {
    return this.rows.some((row) => row.chapterId === chapterId && isComplete(row));
  }

  /** Some pages of this chapter are on the device, complete or not. */
  hasLocal(chapterId: string): boolean {
    return this.rows.some((row) => row.chapterId === chapterId && row.pages > 0);
  }

  inQueue(chapterId: string): boolean {
    return this.active?.chapterId === chapterId || this.queue.some((item) => item.chapterId === chapterId);
  }

  /** Queue a chapter. A duplicate is ignored rather than downloaded twice. */
  enqueue(seriesId: string, chapter: Chapter): void {
    this.worker()?.enqueue(seriesId, chapter);
  }

  enqueueMany(seriesId: string, chapters: Chapter[]): void {
    this.worker()?.enqueueMany(seriesId, chapters);
  }

  cancel(chapterId: string): void {
    this.worker()?.cancel(chapterId);
  }

  retry(chapterId: string): void {
    this.worker()?.retry(chapterId);
  }

  /**
   * The pages of a downloaded chapter, as object URLs the reader can put in an `<img>`.
   *
   * `null` means this device has no download for the chapter, so the reader uses the network as
   * it always did. Anything else is the device's copy — including a partial one, where `urls` has
   * `null` for the pages that are missing.
   */
  async local(chapterId: string): Promise<LocalChapter | null> {
    return (await this.worker()?.local(chapterId)) ?? null;
  }

  async remove(chapterId: string): Promise<void> {
    await this.worker()?.remove(chapterId);
  }

  async removeSeries(seriesId: string): Promise<void> {
    await this.worker()?.removeSeries(seriesId);
  }
}

/**
 * One page's bytes.
 *
 * A page that needs headers goes through our own `/api/img` (a browser will not let an `<img>` or
 * a bare `fetch` set `Referer`), which is the same rule the reader uses — `imageSrc` is the single
 * place that decides.
 */
async function fetchPage(page: Page, timeoutMs?: number): Promise<Blob> {
  // The timeout comes from the work level: a request left hanging is work the machine keeps paying
  // for, and a stalled page would hold the queue forever.
  const signal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const response = await fetch(imageSrc(page), signal === undefined ? {} : { signal });
  if (!response.ok) throw new Error(`page ${page.index + 1}: HTTP ${response.status}`);
  return response.blob();
}

export const downloads = new Downloads();

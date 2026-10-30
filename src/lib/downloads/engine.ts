/**
 * The download queue, as a plain object.
 *
 * This is the part that has to be right: one chapter at a time, a queue that is written down
 * before it runs so a reload resumes it, a run that was interrupted marked `partial` instead of
 * `done`, and pages that stay on this device when the extension host is not there.
 *
 * It is deliberately not a Svelte module. The view layer (`state/downloads.svelte.ts`) is a thin
 * shell that gives these fields reactive storage; everything that decides what happens lives here,
 * so `tests/unit/downloads-state.test.mjs` can drive the real engine against the in-memory
 * database instead of a description of it.
 *
 * Nothing in this file fetches on its own: `pages` and `fetchBlob` are injected, so the engine has
 * no opinion about hosts, tokens or `/api/img`.
 */
import type { Chapter, Page } from "../../api/source";
import type { WorkBudget } from "../performance";
import type { DownloadRow } from "../db/store";
import {
  QUEUE_PREF,
  isComplete,
  planQueue,
  reconcile,
  retryable,
  type Progress,
  type QueueItem,
  type StoredCount,
} from "./state";

/** The store methods a download needs. `LibraryStore` satisfies this as it stands. */
export interface DownloadStore {
  listDownloads(): Promise<DownloadRow[]>;
  putDownload(row: DownloadRow): Promise<void>;
  removeDownload(chapterId: string): Promise<void>;
  listDownloadPages(chapterId: string): Promise<Array<{ index: number; blob: Blob }>>;
  putDownloadPage(row: { id: string; chapterId: string; index: number; blob: Blob }): Promise<void>;
  allDownloadPages(): Promise<Array<{ id: string; chapterId: string; index: number; blob: Blob }>>;
  getPref<T>(key: string): Promise<T | undefined>;
  setPref<T>(key: string, value: T): Promise<void>;
}

export interface DownloadDeps {
  store: DownloadStore;
  /**
   * The chapter's page list, from its source. It throws when the host is down — that is a failure
   * to record, never an empty chapter.
   */
  pages: (chapterId: string) => Promise<Page[]>;
  /** The bytes of one page. The caller owns headers, tokens and `/api/img`. */
  fetchBlob: (page: Page, timeoutMs?: number) => Promise<Blob>;
  /**
   * How much work the app may have in flight, from the Performance setting.
   *
   * Defaulted so a test can construct an engine without one; the app always passes the user's level.
   */
  budget?: () => WorkBudget;
  now?: () => number;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
}

/** The fields the engine reads and writes. The Svelte state object is one of these. */
export interface DownloadHost {
  rows: DownloadRow[];
  queue: QueueItem[];
  active: Progress | null;
  error: string | null;
}

/** A downloaded chapter as the reader needs it: one URL per page, `null` where nothing is stored. */
export interface LocalChapter {
  chapterId: string;
  /** Length is the chapter's page count; an entry is `null` when this device does not have it. */
  urls: Array<string | null>;
  stored: number;
  total: number;
  /** Every page is here. Only then may the reader skip the network entirely. */
  complete: boolean;
  state: "done" | "partial" | "failed";
}

/** Thrown between pages when the user cancels; not an error worth a banner. */
class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

export class DownloadEngine {
  private readonly host: DownloadHost;
  private readonly deps: DownloadDeps;
  private readonly now: () => number;
  private readonly createUrl: (blob: Blob) => string;
  private readonly revokeUrl: (url: string) => void;

  private running = false;
  /** The run in flight, so a caller (and a test) can wait for the queue to settle. */
  private pending: Promise<void> | null = null;
  /** Chapters the user cancelled while they were running; checked between pages. */
  private readonly cancelled = new Set<string>();
  /** Object URLs handed to the reader, so deleting a chapter frees them. */
  private readonly urls = new Map<string, LocalChapter>();

  constructor(host: DownloadHost, deps: DownloadDeps) {
    this.host = host;
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.createUrl = deps.createUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeUrl = deps.revokeUrl ?? ((url) => URL.revokeObjectURL(url));
  }

  get store(): DownloadStore {
    return this.deps.store;
  }

  /**
   * Read what is on the device, make it honest, and bring the queue back.
   *
   * Called at launch, when the Downloads screen opens, and after every finished chapter. It is
   * idempotent: rows that already tell the truth are not rewritten.
   */
  async load(): Promise<void> {
    const store = this.deps.store;
    const [rows, pages, queued] = await Promise.all([
      store.listDownloads(),
      store.allDownloadPages(),
      store.getPref<QueueItem[]>(QUEUE_PREF),
    ]);

    const stored = new Map<string, StoredCount>();
    for (const page of pages) {
      const count = stored.get(page.chapterId) ?? { pages: 0, bytes: 0 };
      count.pages += 1;
      count.bytes += page.blob.size;
      stored.set(page.chapterId, count);
    }

    const result = reconcile(rows, stored, Array.isArray(queued) ? queued : []);
    // Page rows with no download row are bytes nothing can reach: `removeDownload` clears both
    // halves, and for an orphan the row half is simply absent.
    for (const chapterId of result.orphans) await store.removeDownload(chapterId);
    if (result.changed) {
      for (const row of result.rows) await store.putDownload(row);
      await store.setPref(QUEUE_PREF, result.queue);
    }
    this.host.rows = [...result.rows].sort((a, b) => b.at - a.at);
    this.host.queue = result.queue;
    // A queue that survived the reload starts again: that is what "resumes" means. Inside a run
    // this is a no-op, because `run` hands back the loop that is already going.
    if (this.host.queue.length > 0) void this.run();
  }

  /** Queue one chapter. A chapter already here — or already complete — is not queued twice. */
  enqueue(seriesId: string, chapter: Chapter): void {
    if (this.host.rows.some((row) => row.chapterId === chapter.id && isComplete(row))) return;
    if (this.host.queue.some((item) => item.chapterId === chapter.id)) return;
    if (this.host.active?.chapterId === chapter.id) return;
    this.host.queue = [
      ...this.host.queue,
      {
        chapterId: chapter.id,
        seriesId,
        chapterName: chapter.name,
        ...(chapter.number > 0 ? { number: chapter.number } : {}),
      },
    ];
    void this.persistQueue();
    void this.run();
  }

  enqueueMany(seriesId: string, chapters: Chapter[]): void {
    const queued = new Set(this.host.queue.map((item) => item.chapterId));
    const complete = new Set(this.host.rows.filter(isComplete).map((row) => row.chapterId));
    const added: QueueItem[] = [];
    for (const chapter of chapters) {
      if (queued.has(chapter.id) || complete.has(chapter.id)) continue;
      queued.add(chapter.id);
      added.push({
        chapterId: chapter.id,
        seriesId,
        chapterName: chapter.name,
        ...(chapter.number > 0 ? { number: chapter.number } : {}),
      });
    }
    if (added.length === 0) return;
    this.host.queue = [...this.host.queue, ...added];
    void this.persistQueue();
    void this.run();
  }

  /**
   * Stop a chapter.
   *
   * A queued chapter simply leaves the list. A running one is stopped between pages and kept as a
   * partial with the pages that already arrived — the reader can still open it, and Retry picks up
   * from where it stopped.
   */
  cancel(chapterId: string): void {
    if (this.host.active?.chapterId === chapterId) {
      this.cancelled.add(chapterId);
      return;
    }
    const next = this.host.queue.filter((item) => item.chapterId !== chapterId);
    if (next.length === this.host.queue.length) return;
    this.host.queue = next;
    void this.persistQueue();
  }

  /** Try a chapter again: a failed one, or a partial one that should finish. */
  retry(chapterId: string): void {
    const item = this.host.queue.find((row) => row.chapterId === chapterId);
    if (item !== undefined) {
      this.host.queue = this.host.queue.map((row) =>
        row.chapterId === chapterId ? { chapterId: row.chapterId, seriesId: row.seriesId, chapterName: row.chapterName, ...(row.number === undefined ? {} : { number: row.number }) } : row,
      );
    } else {
      const row = this.host.rows.find((entry) => entry.chapterId === chapterId);
      if (row === undefined) return;
      this.host.queue = [
        {
          chapterId: row.chapterId,
          seriesId: row.seriesId,
          chapterName: row.chapterName,
          ...(row.number === undefined ? {} : { number: row.number }),
        },
        ...this.host.queue,
      ];
    }
    this.host.error = null;
    this.invalidate(chapterId);
    void this.persistQueue();
    void this.run();
  }

  /**
   * Delete a download: the row, every page row, and the object URLs the reader may be holding.
   *
   * All three, or the bytes stay on the device after the screen says they are gone.
   */
  async remove(chapterId: string): Promise<void> {
    this.invalidate(chapterId);
    this.host.queue = this.host.queue.filter((item) => item.chapterId !== chapterId);
    await this.deps.store.removeDownload(chapterId);
    await this.persistQueue();
    await this.load();
  }

  async removeSeries(seriesId: string): Promise<void> {
    const chapters = new Set<string>([
      ...this.host.rows.filter((row) => row.seriesId === seriesId).map((row) => row.chapterId),
      ...this.host.queue.filter((item) => item.seriesId === seriesId).map((item) => item.chapterId),
    ]);
    if (chapters.size === 0) return;
    this.host.queue = this.host.queue.filter((item) => item.seriesId !== seriesId);
    for (const chapterId of chapters) {
      this.invalidate(chapterId);
      await this.deps.store.removeDownload(chapterId);
    }
    await this.persistQueue();
    await this.load();
  }

  /**
   * The pages of one chapter as this device has them.
   *
   * `null` means there is no download at all and the reader should use the network as usual. A
   * result with `complete: false` means some pages are here and some are not: the reader must use
   * the URLs it got and never fetch a page that is already stored.
   */
  async local(chapterId: string): Promise<LocalChapter | null> {
    const row = this.host.rows.find((entry) => entry.chapterId === chapterId);
    const pages = await this.deps.store.listDownloadPages(chapterId);
    // A row whose pages are all gone (deleted under us, or a stale "done" that reconciled to
    // partial) is not a local chapter: handing the reader twenty empty slots shows a blank chapter
    // instead of falling back to the network.
    if (pages.length === 0) return null;

    const cached = this.urls.get(chapterId);
    // The cache is a page-set, not a promise: a retry that added pages rebuilds it, and a chapter
    // whose pages did not change keeps the URLs the reader is already showing.
    if (cached !== undefined && cached.stored === pages.length) return cached;
    if (cached !== undefined) this.invalidate(chapterId);

    const ordered = [...pages].sort((a, b) => a.index - b.index);
    const highest = ordered.reduce((max, page) => Math.max(max, page.index + 1), 0);
    const total = row?.total !== undefined && row.total > 0 ? row.total : highest;
    const urls: Array<string | null> = new Array(total).fill(null);
    for (const page of ordered) {
      if (page.index < 0 || page.index >= total) continue;
      urls[page.index] = this.createUrl(page.blob);
    }
    const stored = ordered.length;
    const complete = row !== undefined && isComplete(row) && stored >= total && total > 0;
    const local: LocalChapter = {
      chapterId,
      urls,
      stored,
      total,
      complete,
      state: complete ? "done" : row?.state === "failed" ? "failed" : "partial",
    };
    this.urls.set(chapterId, local);
    return local;
  }

  /** Drop a chapter's object URLs: the pages behind them are gone, or are about to be. */
  invalidate(chapterId: string): void {
    const cached = this.urls.get(chapterId);
    if (cached === undefined) return;
    for (const url of cached.urls) if (url !== null) this.revokeUrl(url);
    this.urls.delete(chapterId);
  }

  /** Why the last run gave up, for the screen to show. */
  get lastError(): string | null {
    return this.host.error;
  }

  private async persistQueue(): Promise<void> {
    await this.deps.store.setPref(QUEUE_PREF, this.host.queue);
  }

  /**
   * Run the queue, one chapter at a time.
   *
   * The loop re-reads the queue each pass, so a chapter queued while another is downloading runs
   * after it rather than being dropped.
   */
  run(): Promise<void> {
    if (this.running) return this.pending ?? Promise.resolve();
    this.pending = this.execute().finally(() => {
      this.running = false;
      this.pending = null;
    });
    return this.pending;
  }

  /** Resolves when nothing is downloading any more. */
  async whenIdle(): Promise<void> {
    await this.pending;
  }

  private async execute(): Promise<void> {
    this.running = true;
    try {
      for (;;) {
        const { next, rest } = planQueue(this.host.queue, this.host.active);
        if (next === null) break;
        this.host.queue = rest;
        await this.persistQueue();
        this.host.active = { chapterId: next.chapterId, done: 0, total: 0 };
        try {
          await this.download(next);
        } finally {
          this.host.active = null;
          this.cancelled.delete(next.chapterId);
        }
        await this.load();
      }
    } finally {
      this.running = false;
      this.host.active = null;
    }
  }

  /**
   * One chapter, from the page list to the last blob.
   *
   * Pages already stored are skipped, so a retry of a partial chapter fetches only what is
   * missing. The row is written as `downloading` before the first byte arrives: a kill after that
   * is visible as an interrupted download rather than a chapter that quietly is not there.
   */
  private async download(item: QueueItem): Promise<void> {
    const store = this.deps.store;
    try {
      const pages = await this.deps.pages(item.chapterId);
      if (pages.length === 0) throw new Error("the source returned no pages");

      const existing = await store.listDownloadPages(item.chapterId);
      const have = new Map(existing.map((page) => [page.index, page.blob.size]));
      let bytes = [...have.values()].reduce((sum, size) => sum + size, 0);

      this.host.active = { chapterId: item.chapterId, done: have.size, total: pages.length };
      const base: DownloadRow = {
        chapterId: item.chapterId,
        seriesId: item.seriesId,
        chapterName: item.chapterName,
        pages: have.size,
        bytes,
        at: this.now(),
        total: pages.length,
        ...(item.number === undefined ? {} : { number: item.number }),
        state: "downloading",
      };
      await store.putDownload(base);

      let done = have.size;
      const budget = this.deps.budget?.() ?? { downloadConcurrency: 1, imageWarmBatch: 0, pagePacingMs: 0, pageTimeoutMs: 30_000 };
      const pending = pages.filter((page) => !have.has(page.index));
      let cursor = 0;
      // Pages in flight at once is the knob that decides CPU; the level steps it down and adds a
      // pause between requests at the quiet end.
      const worker = async (): Promise<void> => {
        while (cursor < pending.length) {
          const page = pending[cursor++];
          if (this.cancelled.has(item.chapterId)) throw new Cancelled();
          // A page that never resolves would stall the queue forever — the one freeze-shaped hole
          // left after the concurrency cap, so the level's timeout is enforced here.
          const blob = await this.deps.fetchBlob(page, budget.pageTimeoutMs);
          bytes += blob.size;
          await store.putDownloadPage({
            id: `${item.chapterId}#${page.index}`,
            chapterId: item.chapterId,
            index: page.index,
            blob,
          });
          done += 1;
          this.host.active = { chapterId: item.chapterId, done, total: pages.length };
          if (budget.pagePacingMs > 0) await new Promise((resolve) => setTimeout(resolve, budget.pagePacingMs));
        }
      };
      await Promise.all(
        Array.from({ length: Math.max(1, Math.min(budget.downloadConcurrency, pending.length || 1)) }, () => worker()),
      );

      const after = await store.listDownloadPages(item.chapterId);
      if (after.length < pages.length) {
        throw new Error(`only ${after.length} of ${pages.length} pages could be stored`);
      }
      const size = after.reduce((sum, page) => sum + page.blob.size, 0);
      await store.putDownload({ ...base, pages: after.length, bytes: size, at: this.now(), state: "done", error: undefined });
      this.host.error = null;
    } catch (error) {
      await this.settle(item, error);
    }
  }

  /**
   * Record a run that did not finish.
   *
   * The pages that arrived stay — a partial chapter is readable, and pretending otherwise would
   * throw away a download the user paid for in bandwidth. With no pages at all there is nothing to
   * keep, so the row is removed and the chapter is left as a failed queue item instead of a
   * download that would send the reader to an empty chapter.
   */
  private async settle(item: QueueItem, error: unknown): Promise<void> {
    const store = this.deps.store;
    const cancelled = error instanceof Cancelled;
    const message = cancelled ? "cancelled" : error instanceof Error ? error.message : String(error);
    const pages = await store.listDownloadPages(item.chapterId);

    if (pages.length === 0) {
      await store.removeDownload(item.chapterId);
      if (cancelled) return;
      this.host.error = `${item.chapterName}: ${message}`;
      this.host.queue = [
        ...this.host.queue.filter((row) => row.chapterId !== item.chapterId),
        { ...item, state: "failed", error: message },
      ];
      await this.persistQueue();
      return;
    }

    const bytes = pages.reduce((sum, page) => sum + page.blob.size, 0);
    const total = Math.max(...pages.map((page) => page.index + 1), pages.length);
    await store.putDownload({
      chapterId: item.chapterId,
      seriesId: item.seriesId,
      chapterName: item.chapterName,
      pages: pages.length,
      bytes,
      at: this.now(),
      total: this.host.active?.total !== undefined && this.host.active.total > 0 ? this.host.active.total : total,
      ...(item.number === undefined ? {} : { number: item.number }),
      state: "partial",
      error: message,
    });
    if (cancelled) return;
    this.host.error = `${item.chapterName}: ${message}${retryable(error) ? " — Retry when the source is back" : ""}`;
    this.host.queue = [
      ...this.host.queue.filter((row) => row.chapterId !== item.chapterId),
      { ...item, state: "failed", error: message },
    ];
    await this.persistQueue();
  }
}

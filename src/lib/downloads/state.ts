/**
 * Downloads, decided as data: what is on this device, what still has to arrive, and which rows
 * may be called finished.
 *
 * Nothing here touches IndexedDB, Svelte or the network. The engine (`engine.ts`) moves rows and
 * fetches bytes; the rules that make a download trustworthy — a partial is never "done", a queue
 * survives a reload, a series lists in chapter order — live here, where a test can pin them.
 */
import type { DownloadRow, DownloadState } from "../db/store";

export type { DownloadRow, DownloadState };

/** Where the waiting queue is kept. One pref key, so a reload reads the same list the app wrote. */
export const QUEUE_PREF = "downloadQueue";

/**
 * The queue as plain data.
 *
 * The app's queue is a rune proxy, and IndexedDB's structured clone refuses a proxy: queueing a
 * download threw `DataCloneError: [object Array] could not be cloned`, so nothing was ever written
 * down and a reload lost the queue. Copying the fields is what makes it storable.
 */
export function plainQueue(queue: readonly QueueItem[]): QueueItem[] {
  return queue.map((item) => ({
    chapterId: item.chapterId,
    seriesId: item.seriesId,
    chapterName: item.chapterName,
    ...(item.number === undefined ? {} : { number: item.number }),
    ...(item.state === undefined ? {} : { state: item.state }),
    ...(item.error === undefined ? {} : { error: item.error }),
  }));
}

/** One chapter waiting for its turn. The active chapter is *not* in this list while it runs. */
export interface QueueItem {
  chapterId: string;
  seriesId: string;
  chapterName: string;
  /** The source's chapter number, so a series reads in chapter order, not download order. */
  number?: number;
  /** `failed` when a run gave up; a chapter that never ran has no state. */
  state?: "queued" | "failed";
  /** Why the last run gave up, in the source's words. */
  error?: string;
}

/** A run in flight: which chapter, and how far into it. */
export interface Progress {
  chapterId: string;
  done: number;
  total: number;
  /** The series it belongs to, so a screen can name it without searching every list it has. */
  seriesId?: string;
  /** The chapter's own name, for the same reason. */
  chapterName?: string;
}

/** What the Downloads screen draws: one line per chapter, whatever state it is in. */
export interface ManageRow {
  chapterId: string;
  seriesId: string;
  chapterName: string;
  number?: number;
  state: DownloadState | "queued";
  /** Pages actually stored on this device. */
  pages: number;
  /** Pages the source said the chapter has, when that is known. */
  total?: number;
  bytes: number;
  at: number;
  error?: string;
  /** Pages done in the run that is happening right now. */
  done?: number;
}

/** The parts of a row that ordering needs, so a `ManageRow` and a `DownloadRow` sort alike. */
export interface Sortable {
  seriesId: string;
  chapterName: string;
  number?: number;
  bytes: number;
}

/**
 * Is this download finished, in full?
 *
 * Only when the row says so *and* the numbers agree: a row written by an interrupted run, a
 * download that gave up, or a stored page count that does not match the recorded total is not
 * complete — it is a partial that must never read as a finished chapter.
 *
 * Rows from before the state and total fields existed are complete when they have pages: that is
 * the only way they were ever written.
 */
export function isComplete(row: DownloadRow): boolean {
  if (row.pages <= 0) return false;
  if (row.state === "partial" || row.state === "failed" || row.state === "downloading") return false;
  if (row.total !== undefined && row.pages !== row.total) return false;
  return true;
}

/** The state to show for a stored row. A row that disagrees with its own numbers is partial. */
export function stateOf(row: DownloadRow): DownloadState {
  if (row.state === "downloading") return "downloading";
  if (row.state === "failed") return "failed";
  if (isComplete(row)) return "done";
  return "partial";
}

/**
 * What runs next.
 *
 * One chapter at a time: while something is running nothing else starts, and the rest waits in
 * order. A chapter that already gave up stays in the list (so the user can see it and retry) but
 * is skipped — otherwise one broken source would retry forever at the head of the queue.
 */
export function planQueue(queue: QueueItem[], active: Progress | null): { next: QueueItem | null; rest: QueueItem[] } {
  if (active !== null) return { next: null, rest: [...queue] };
  const index = queue.findIndex((item) => item.state !== "failed");
  if (index === -1) return { next: null, rest: [...queue] };
  return { next: queue[index], rest: queue.filter((_, position) => position !== index) };
}

/**
 * Is this failure worth another try?
 *
 * A source that says "not found" or "no pages" will say it again; a dropped connection, a host
 * that is down, a 5xx or a cancelled run will not. The answer only decides whether Retry is
 * offered — it never retries on its own.
 */
export function retryable(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (message.trim() === "") return false;
  if (/\b(400|401|403|404|410|422)\b/.test(message)) return false;
  if (/\b(not found|no pages|unsupported|unknown chapter|invalid)\b/.test(message)) return false;
  return true;
}

/** Everything those rows take up. */
export function bytesOf(rows: Array<{ bytes: number }>): number {
  return rows.reduce((sum, row) => sum + (Number.isFinite(row.bytes) ? row.bytes : 0), 0);
}

/**
 * Reading order inside a downloads list: series first, then chapter order.
 *
 * Chapter order is the source's number when it has one — a downloads list that runs 7, 3, 12 is a
 * list you cannot check against the series page — and the name otherwise.
 */
export function sortForManage<T extends Sortable>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.seriesId !== b.seriesId) return a.seriesId < b.seriesId ? -1 : 1;
    const an = a.number ?? Number.POSITIVE_INFINITY;
    const bn = b.number ?? Number.POSITIVE_INFINITY;
    if (an !== bn) return an - bn;
    return a.chapterName.localeCompare(b.chapterName);
  });
}

export interface SeriesGroup<T extends Sortable> {
  seriesId: string;
  rows: T[];
  bytes: number;
  chapters: number;
}

/**
 * Rows per series, each series in chapter order.
 *
 * Groups are ordered by title when one is known (the screen has titles; the database only has
 * ids), so a downloads list is alphabetical by series rather than by an id nobody can read.
 */
export function groupBySeries<T extends Sortable>(rows: T[], titles?: Map<string, string>): Array<SeriesGroup<T>> {
  const groups = new Map<string, T[]>();
  for (const row of sortForManage(rows)) {
    const bucket = groups.get(row.seriesId);
    if (bucket === undefined) groups.set(row.seriesId, [row]);
    else bucket.push(row);
  }
  const label = (seriesId: string): string => titles?.get(seriesId) ?? seriesId;
  return [...groups.entries()]
    .sort(([a], [b]) => label(a).localeCompare(label(b)))
    .map(([seriesId, list]) => ({ seriesId, rows: list, bytes: bytesOf(list), chapters: list.length }));
}

/** Where the expected page count for a chapter comes from: a number, a map, or a lookup. */
export type ExpectedPages = number | Map<string, number> | Record<string, number> | ((row: DownloadRow) => number | undefined);

function expectedFor(expected: ExpectedPages, row: DownloadRow): number | undefined {
  if (typeof expected === "number") return expected;
  if (typeof expected === "function") return expected(row);
  if (expected instanceof Map) return expected.get(row.chapterId);
  const value = expected[row.chapterId];
  return typeof value === "number" ? value : undefined;
}

/**
 * Downloads whose stored page count does not match what the chapter is supposed to have.
 *
 * This is the check that stops a half-finished download from reading as a finished one: a row
 * claiming 40 pages with 12 stored, or with no pages at all, is stale no matter what its state
 * field says. `expectedPages` adds the source's own count when the caller has it (a series page
 * knows `chapter.pageCount`), so a row that lied about its total is caught too.
 */
export function staleRows(rows: DownloadRow[], expectedPages?: ExpectedPages): DownloadRow[] {
  return rows.filter((row) => {
    if (row.pages <= 0) return true;
    if (row.total !== undefined && row.pages !== row.total) return true;
    if (expectedPages === undefined) return false;
    const expected = expectedFor(expectedPages, row);
    return expected !== undefined && expected !== row.pages;
  });
}

/** What is actually stored for one chapter: how many pages, and how many bytes. */
export interface StoredCount {
  pages: number;
  bytes: number;
}

export interface ReconcileResult {
  rows: DownloadRow[];
  queue: QueueItem[];
  /** Page rows whose chapter has no download row — the leftovers a delete failed to remove. */
  orphans: string[];
  /** True when the database has to be written back. */
  changed: boolean;
}

/**
 * Make the stored rows tell the truth, and bring the queue back after a reload.
 *
 * A run that was killed mid-chapter left a row saying `downloading`; it is turned into `partial`
 * with the pages that really arrived, and the chapter goes back to the head of the queue so the
 * reload resumes it instead of dropping it. A row whose numbers disagree with the pages on disk is
 * corrected and demoted. Page rows with no download row are reported as orphans so they can be
 * freed — a delete that missed them would keep the bytes forever.
 *
 * Only an interrupted run (`downloading`) is re-queued. A chapter that failed for a reason keeps
 * its failure: retrying a 404 on every launch is not a queue, it is a loop.
 */
export function reconcile(rows: DownloadRow[], stored: Map<string, StoredCount>, queue: QueueItem[]): ReconcileResult {
  let changed = false;
  const resumed: QueueItem[] = [];
  const fixed: DownloadRow[] = rows.map((row) => {
    const actual = stored.get(row.chapterId) ?? { pages: 0, bytes: 0 };
    const interrupted = row.state === "downloading";
    const next: DownloadRow = { ...row, pages: actual.pages, bytes: actual.bytes };
    if (interrupted) {
      const finished = row.total !== undefined && row.total > 0 && actual.pages >= row.total;
      next.state = finished ? "done" : "partial";
      if (!finished) {
        next.error = row.error ?? "interrupted";
        resumed.push({ chapterId: row.chapterId, seriesId: row.seriesId, chapterName: row.chapterName, ...(row.number === undefined ? {} : { number: row.number }) });
      }
    } else if (row.total !== undefined && actual.pages !== row.total && row.state === "done") {
      // A row that called itself done with the wrong number of pages is a partial.
      next.state = "partial";
    }
    if (next.pages !== row.pages || next.bytes !== row.bytes || next.state !== row.state || next.error !== row.error) changed = true;
    return next;
  });

  const known = new Set(fixed.map((row) => row.chapterId));
  const orphans = [...stored.keys()].filter((chapterId) => !known.has(chapterId));

  const seen = new Set<string>();
  const merged: QueueItem[] = [];
  for (const item of [...resumed, ...queue]) {
    if (seen.has(item.chapterId)) continue;
    if (known.has(item.chapterId) && isComplete(fixed.find((row) => row.chapterId === item.chapterId)!)) continue;
    seen.add(item.chapterId);
    merged.push(item);
  }
  if (merged.length !== queue.length) changed = true;

  return { rows: fixed, queue: merged, orphans, changed };
}

/**
 * One line per chapter for the manage screen: the queue in front, then what is stored.
 *
 * A chapter can be in both — a partial download queued again to finish — and then the queue wins,
 * because "queued" is the thing that is about to change. The size shown is always what is really
 * on disk.
 */
export function manageRows(rows: DownloadRow[], queue: QueueItem[], active: Progress | null): ManageRow[] {
  const stored = new Map(rows.map((row) => [row.chapterId, row]));
  const lines = new Map<string, ManageRow>();

  for (const item of queue) {
    const row = stored.get(item.chapterId);
    const running = active?.chapterId === item.chapterId;
    const state: ManageRow["state"] = running ? "downloading" : item.state === "failed" ? "failed" : "queued";
    lines.set(item.chapterId, {
      chapterId: item.chapterId,
      seriesId: item.seriesId,
      chapterName: item.chapterName,
      ...(item.number === undefined ? {} : { number: item.number }),
      state,
      pages: row?.pages ?? 0,
      ...(row?.total === undefined ? {} : { total: row.total }),
      bytes: row?.bytes ?? 0,
      at: row?.at ?? 0,
      ...(item.error === undefined ? {} : { error: item.error }),
      ...(running && active !== null ? { done: active.done, total: active.total } : {}),
    });
  }

  for (const row of rows) {
    if (lines.has(row.chapterId)) continue;
    const state = stateOf(row);
    lines.set(row.chapterId, {
      chapterId: row.chapterId,
      seriesId: row.seriesId,
      chapterName: row.chapterName,
      ...(row.number === undefined ? {} : { number: row.number }),
      state: state === "downloading" ? "partial" : state,
      pages: row.pages,
      ...(row.total === undefined ? {} : { total: row.total }),
      bytes: row.bytes,
      at: row.at,
      ...(row.error === undefined ? {} : { error: row.error }),
    });
  }

  return sortForManage([...lines.values()]);
}

/**
 * What "fetch" means, as a choice rather than a mood.
 *
 * `new` is the safe default: chapters this device has never seen a row for. `all` also takes the
 * rows that are half here or that gave up — the difference between "get me the rest of the series"
 * and "try the broken ones again". Neither re-downloads a chapter that is already complete, because
 * a queue that re-fetches finished work is a queue nobody trusts.
 */
export type FetchMode = "new" | "all";

/** The rows that already exist for a series, so "new" and "all" can be told apart. */
export interface SeenChapters {
  /** Chapters whose pages are all stored. */
  complete: ReadonlySet<string>;
  /** Chapters with a row of any kind: complete, partial, failed. */
  known: ReadonlySet<string>;
  /** Chapters already waiting in the queue or running. */
  queued: ReadonlySet<string>;
}

export function chaptersToFetch<T extends { id: string }>(
  chapters: readonly T[],
  seen: SeenChapters,
  mode: FetchMode,
): T[] {
  return chapters.filter((chapter) => {
    if (seen.complete.has(chapter.id)) return false;
    if (seen.queued.has(chapter.id)) return false;
    if (mode === "new") return !seen.known.has(chapter.id);
    return true;
  });
}

/** How many of a series' chapters are on this device, out of how many the series has. */
export function grabbedOf(complete: number, total?: number): { grabbed: number; total: number | null } {
  const safe = Number.isFinite(complete) && complete > 0 ? Math.floor(complete) : 0;
  const all = total !== undefined && Number.isFinite(total) && total > 0 ? Math.floor(total) : null;
  // A device can hold more than the series page currently lists (chapters get removed upstream);
  // reporting "7 of 5" would read as a bug, so the total never goes below what is here.
  return { grabbed: safe, total: all === null ? null : Math.max(all, safe) };
}

/** "3 of 12 issues" — or just "3 issues" when the series has never been listed on this device. */
export function grabbedLabel(complete: number, total?: number): string {
  const { grabbed, total: all } = grabbedOf(complete, total);
  if (all === null) return `${grabbed} issue${grabbed === 1 ? "" : "s"}`;
  return `${grabbed} of ${all} issue${all === 1 ? "" : "s"}`;
}

/**
 * Filter a downloads list by what the user typed.
 *
 * The search box covers both columns of the screen, so it matches the series title as well as the
 * chapter name — searching "berserk" in Finished has to find the chapters of Berserk, not only a
 * chapter literally called Berserk.
 */
export function matchesDownloadQuery(query: string, ...fields: Array<string | undefined>): boolean {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return true;
  return fields.some((field) => (field ?? "").toLowerCase().includes(wanted));
}

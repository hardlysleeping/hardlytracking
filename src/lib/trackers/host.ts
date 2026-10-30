/**
 * The tracker seam, and the one place a chapter is pushed.
 *
 * An adapter talks to one service; this module decides *when* to talk and what to do when the
 * service is unreachable. The rule it exists to enforce: **the read is local first**. The chapter
 * mark is already written before anything here runs, so a tracker that is down costs a retry, never
 * a lost chapter.
 */
import type { LibraryStore } from "../db/store";
import {
  planPush,
  reconcile,
  trackerId,
  type TrackerAccountRow,
  type TrackerEntry,
  type TrackerRow,
  type TrackerSearchResult,
  type TrackerService,
  type TrackerStatus,
} from "./types";

export interface Tracker {
  readonly service: TrackerService;
  search(title: string): Promise<TrackerSearchResult[]>;
  /** What the service says about an entry right now. */
  pull(remoteId: string): Promise<TrackerEntry>;
  push(remoteId: string, chapter: number): Promise<TrackerEntry>;
  setScore(remoteId: string, serviceScore: number): Promise<void>;
  setStatus(remoteId: string, status: TrackerStatus): Promise<void>;
}

/** One service per kind, registered only when an account is connected. */
export type TrackerSet = Partial<Record<TrackerService, Tracker>>;

export interface TrackerHostOptions {
  store: LibraryStore;
  trackers: TrackerSet;
  /** Where a per-series preference lives; the settings store satisfies this. */
  now?: () => number;
}

export interface PushOutcome {
  pushed: boolean;
  reason?: "no-adapter" | "no-binding" | "not-forward" | "already-sent" | "no-chapter" | "failed";
  error?: string;
}

/**
 * Push a finished chapter to every service this series is bound to.
 *
 * Never throws: a read that already happened must not fail because a list is down. A failure is
 * written onto the row as `pending`, which is the retry queue — it survives a reload because it is
 * a column, not a timer.
 */
export async function pushChapter(
  options: TrackerHostOptions,
  seriesId: string,
  chapter: number,
): Promise<PushOutcome[]> {
  const rows = await options.store.listTrackersForSeries(seriesId);
  if (rows.length === 0) return [];
  const now = options.now ?? Date.now;
  const outcomes: PushOutcome[] = [];

  for (const row of rows) {
    const tracker = options.trackers[row.service];
    if (tracker === undefined) {
      outcomes.push({ pushed: false, reason: "no-adapter" });
      continue;
    }
    const plan = planPush(row, chapter);
    if ("skip" in plan) {
      outcomes.push({ pushed: false, reason: plan.skip });
      continue;
    }
    try {
      const entry = await tracker.push(row.remoteId, plan.send);
      const merged = reconcile({ chapter: plan.send }, entry);
      await options.store.putTracker({
        ...row,
        lastChapter: Math.max(row.lastChapter ?? 0, merged.chapter),
        ...(entry.status === undefined ? {} : { status: entry.status }),
        syncedAt: now(),
        pending: undefined,
      });
      outcomes.push({ pushed: true });
    } catch (error) {
      await options.store.putTracker({
        ...row,
        pending: { chapter: plan.send, at: now(), error: message(error) },
      });
      outcomes.push({ pushed: false, reason: "failed", error: message(error) });
    }
  }
  return outcomes;
}

/**
 * Retry everything that owes a push.
 *
 * Called on launch, on reconnect and from "Sync trackers now". It reads the queue off the rows, so a
 * process that was killed mid-push still knows what it owes.
 */
export async function flushPending(options: TrackerHostOptions): Promise<{ flushed: number; failed: number }> {
  const rows = (await options.store.listTrackers()).filter((row) => row.pending !== undefined);
  let flushed = 0;
  let failed = 0;
  for (const row of rows) {
    const tracker = options.trackers[row.service];
    if (tracker === undefined) {
      failed += 1;
      continue;
    }
    const chapter = row.pending?.chapter ?? 0;
    try {
      const entry = await tracker.push(row.remoteId, chapter);
      await options.store.putTracker({
        ...row,
        lastChapter: Math.max(row.lastChapter ?? 0, entry.lastChapter ?? chapter),
        ...(entry.status === undefined ? {} : { status: entry.status }),
        syncedAt: (options.now ?? Date.now)(),
        pending: undefined,
      });
      flushed += 1;
    } catch (error) {
      await options.store.putTracker({ ...row, pending: { chapter, at: (options.now ?? Date.now)(), error: message(error) } });
      failed += 1;
    }
  }
  return { flushed, failed };
}

/** Pull every bound series' remote state, so a series page can show what the service thinks. */
export async function pullSeries(
  options: TrackerHostOptions,
  seriesId: string,
): Promise<{ row: TrackerRow; disagreement: boolean }[]> {
  const rows = await options.store.listTrackersForSeries(seriesId);
  const results: { row: TrackerRow; disagreement: boolean }[] = [];
  for (const row of rows) {
    const tracker = options.trackers[row.service];
    if (tracker === undefined) continue;
    try {
      const entry = await tracker.pull(row.remoteId);
      const merged = reconcile({ chapter: row.lastChapter ?? 0 }, entry);
      const next: TrackerRow = {
        ...row,
        ...(entry.status === undefined ? {} : { status: entry.status }),
        ...(entry.score === undefined ? {} : { score: entry.score }),
        lastChapter: merged.chapter,
        syncedAt: (options.now ?? Date.now)(),
      };
      await options.store.putTracker(next);
      results.push({ row: next, disagreement: merged.disagreement });
    } catch {
      // A service that cannot be reached leaves the row as it is; the card shows "last synced".
      results.push({ row, disagreement: false });
    }
  }
  return results;
}

/** Bind a series to a remote entry. The remote's own state seeds the row so the card is not blank. */
export async function bindSeries(
  options: TrackerHostOptions,
  input: { seriesId: string; service: TrackerService; remoteId: string; remoteTitle?: string; localChapter?: number },
): Promise<TrackerRow> {
  const tracker = options.trackers[input.service];
  if (tracker === undefined) throw new Error(`${input.service} is not connected`);
  let entry: TrackerEntry = {};
  try {
    entry = await tracker.pull(input.remoteId);
  } catch {
    // Binding is worth doing even when the first pull fails: the push will fill it in.
  }
  const merged = reconcile({ chapter: input.localChapter ?? 0 }, entry);
  const row: TrackerRow = {
    id: trackerId(input.service, input.seriesId),
    seriesId: input.seriesId,
    service: input.service,
    remoteId: input.remoteId,
    ...(input.remoteTitle === undefined ? {} : { remoteTitle: input.remoteTitle }),
    ...(entry.status === undefined ? {} : { status: entry.status }),
    ...(entry.score === undefined ? {} : { score: entry.score }),
    lastChapter: merged.chapter,
    syncedAt: (options.now ?? Date.now)(),
    // A local device ahead of the service owes it a push from the moment it binds.
    ...(merged.chapter > (entry.lastChapter ?? 0) ? { pending: { chapter: merged.chapter, at: (options.now ?? Date.now)() } } : {}),
  };
  await options.store.putTracker(row);
  return row;
}

export async function unbindSeries(store: LibraryStore, service: TrackerService, seriesId: string): Promise<void> {
  await store.removeTracker(trackerId(service, seriesId));
}

/** Accounts are read here and nowhere else, so a token has one door. */
export async function trackerAccount(store: LibraryStore, service: TrackerService): Promise<TrackerAccountRow | undefined> {
  return store.getTrackerAccount(service);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

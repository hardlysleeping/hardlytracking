/**
 * The wiring: a read mark becomes a queued push, and the queue gets drained when it can.
 *
 * `host.ts` is *what* a push does; this file is *when*. It exists as its own module so the rule that
 * matters is visible in one place: **nothing here is ever awaited by the reader.** The chapter is
 * already marked read in our database before this runs, so a service that is down costs a retry, and
 * a retry that fails again costs another one later. It never costs the read.
 *
 * There is no account and no adapter yet (T26–T28 need the owner's own logins), so `trackers` starts
 * empty and every entry point below is a no-op until one is registered. That is deliberate: the
 * engine and its ladder are provable with a fake adapter, and the day a service is connected the
 * only change is one line here.
 */
import type { LibraryStore } from "../db/store";
import { flushPending, pushChapter, type TrackerHostOptions, type TrackerSet } from "./host";
import type { TrackerService } from "./types";

/**
 * The connected services, one adapter each.
 *
 * Empty until an account exists. An adapter registers itself here after its login succeeds; an
 * adapter that is missing is not an error, it just means that service is not connected.
 */
export const trackers: TrackerSet = {};

export function registerTracker(adapter: TrackerSet[TrackerService]): void {
  if (adapter === undefined) return;
  trackers[adapter.service] = adapter;
}

/**
 * Stop talking to a service, without touching anything already downloaded or read.
 *
 * Disconnecting is a settings action, so it has to take effect now rather than at the next launch:
 * an adapter left registered would keep receiving read marks from a list the reader just removed.
 */
export function unregisterTracker(service: TrackerService): void {
  delete trackers[service];
}

/**
 * "Sync now" — every owed push, the backoff ladder ignored because the reader asked.
 *
 * Lives here rather than in the panel so the panel never builds a host of its own and the shared
 * `trackers` set stays the only place an adapter can be reached from.
 */
export function syncTrackersNow(store: LibraryStore, options: { now?: () => number } = {}): Promise<{ flushed: number; failed: number }> {
  return flushPending({ store, trackers, ...(options.now === undefined ? {} : { now: options.now }) }, { force: true });
}

export interface TrackerSync {
  /** "Sync trackers now": every owed push, the backoff ladder ignored because the user asked. */
  syncAll(): Promise<{ flushed: number; failed: number }>;
  /** Drop the listeners this install added (a test or a profile switch). */
  dispose(): void;
}

/**
 * Make read marks push, and drain the queue on launch and on reconnect.
 *
 * Returns the manual entry point rather than drawing a button: the Settings → Tracking screen is
 * T29, and a control that does nothing would be worse than none.
 */
export function installTrackerSync(store: LibraryStore, options: { now?: () => number } = {}): TrackerSync {
  const host: TrackerHostOptions = { store, trackers, ...(options.now === undefined ? {} : { now: options.now }) };

  store.onReadMark = (chapter) => {
    // Fire and forget, on purpose: `pushChapter` reports failures on the row, and the caller is a
    // read that already happened.
    void pushChapter(host, chapter.seriesId, chapter.number);
  };

  const online = (): void => {
    void flushPending(host);
  };
  const listenable = typeof window !== "undefined" && typeof window.addEventListener === "function";
  if (listenable) window.addEventListener("online", online);

  // A row left owed by the last run is retried now if its ladder says so.
  void flushPending(host);

  return {
    syncAll: () => flushPending(host, { force: true }),
    dispose: () => {
      store.onReadMark = undefined;
      if (listenable) window.removeEventListener("online", online);
    },
  };
}

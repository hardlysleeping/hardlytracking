/**
 * Reading history: the part of the database that is about time rather than position.
 *
 * `progress` answers "where am I", `position` answers "what should Continue open", and a
 * `SessionRow` answers "when did I read this, for how long, and did I finish". Stats, History and
 * the privacy controls all read from here, so the arithmetic lives in one pure module that a test
 * can pin — the store only moves rows.
 */
import type { ProgressRow, SessionRow } from "./db/store";

/** How long a session is kept unless the user says otherwise. */
export const RETENTION_DAYS = 365;

/**
 * A read ends after this long with no page turn.
 *
 * Five minutes is long enough that putting the tablet down mid-chapter does not split the session,
 * and short enough that a chapter left open overnight is not reported as eight hours of reading.
 */
export const INACTIVITY_TIMEOUT_MS = 5 * 60_000;

/**
 * How long the app may be in the background before the session ends.
 *
 * A notification, a glance at another app, a short phone call: all the same session. A backgrounded
 * app for longer than this is a different sitting, and saying so is what keeps History honest.
 */
export const BACKGROUND_GRACE_MS = 60_000;

/** Does an idle gap end the session? */
export function shouldEndForIdle(idleMs: number): boolean {
  return idleMs >= INACTIVITY_TIMEOUT_MS;
}

/** Does time in the background end the session? */
export function shouldEndForBackground(hiddenMs: number): boolean {
  return hiddenMs >= BACKGROUND_GRACE_MS;
}

/** Pages actually read in a session: a backward re-read counts its pages too, never negative. */
export function pagesRead(startPage: number, endPage: number): number {
  return Math.abs(endPage - startPage) + 1;
}

/** Reading time in whole seconds, never negative. */
export function durationSeconds(startedAt: number, endedAt: number): number {
  return Math.max(Math.round((endedAt - startedAt) / 1000), 0);
}

export interface SessionSummary {
  sessions: number;
  chapters: number;
  /** Whole minutes of *closed* reading time; an interrupted session has no duration yet. */
  minutes: number;
  /** Pages turned, as each closed session recorded them. */
  pages: number;
  /** Chapters that were finished during a session. */
  completed: number;
  /** Sessions that were never closed — the app was killed, or the reader is open right now. */
  open: number;
}

/** What a set of sessions adds up to. */
export function summarize(rows: SessionRow[]): SessionSummary {
  const chapters = new Set<string>();
  let minutes = 0;
  let pages = 0;
  let completed = 0;
  let open = 0;
  let closed = 0;
  for (const row of rows) {
    chapters.add(row.chapterId);
    if (row.endedAt === undefined) {
      open += 1;
      continue;
    }
    closed += 1;
    // Seconds are the stored unit; a row from before that (no `durationSeconds`) falls back to its
    // own span rather than being counted as zero.
    const seconds = row.durationSeconds ?? Math.round((row.endedAt - row.startedAt) / 1000);
    minutes += Math.round(seconds / 60);
    pages += row.pagesRead ?? pagesRead(row.startPage, row.endPage);
    if (row.completedChapter === true) completed += 1;
  }
  return { sessions: closed, chapters: chapters.size, minutes, pages, completed, open };
}

/**
 * Sessions grouped by calendar day, newest day first.
 *
 * The History screen groups this way, and the grouping is by *local* day: a session at 23:50 and one
 * at 00:10 are different days to the reader even when they are the same night to the database.
 */
export function groupByDay(rows: SessionRow[], now = Date.now()): Array<{ day: string; rows: SessionRow[] }> {
  const days = new Map<string, SessionRow[]>();
  for (const row of [...rows].sort((a, b) => b.startedAt - a.startedAt)) {
    const key = dayKey(row.startedAt, now);
    const bucket = days.get(key);
    if (bucket === undefined) days.set(key, [row]);
    else bucket.push(row);
  }
  return [...days.entries()].map(([day, rows]) => ({ day, rows }));
}

/** `today`, `yesterday`, or a short date — the labels the History list uses. */
export function dayKey(at: number, now = Date.now()): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const midnight = start.getTime();
  if (at >= midnight) return "today";
  if (at >= midnight - 86_400_000) return "yesterday";
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Which sessions a retention policy keeps.
 *
 * Closed sessions older than `keepDays` go; an open session is kept regardless, because it is not
 * history yet — it is the read in progress. `keepDays <= 0` means keep everything.
 */
export function pruneSessions(rows: SessionRow[], keepDays = RETENTION_DAYS, now = Date.now()): SessionRow[] {
  if (keepDays <= 0) return [...rows];
  const cutoff = now - keepDays * 86_400_000;
  return rows.filter((row) => row.endedAt === undefined || row.startedAt >= cutoff);
}

/**
 * A chapter is finished when its last page is reached, and stays finished.
 *
 * Re-reading a chapter from page 1 must not flip it back to unread — Komikku users expect a read
 * chapter to stay read — so completion is sticky and only an explicit "mark unread" clears it.
 */
export function isComplete(progress: ProgressRow | undefined): boolean {
  if (progress === undefined) return false;
  if (progress.completed === true) return true;
  return progress.total > 0 && progress.page >= progress.total - 1;
}

/** The database key for a collection's remembered view. The unfiltered library is `all`. */
export function viewStateKey(collectionId: string | null | undefined): string {
  const id = (collectionId ?? "").trim();
  return id === "" ? "all" : id;
}

/** Human duration for the History list: `4m`, `1h 12m`. */
export function durationLabel(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

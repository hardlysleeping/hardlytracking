/**
 * The log behind the notices the app raises at the top of the screen.
 *
 * A notice is transient by design: it says something is wrong, or that a step finished, and it
 * leaves after a few seconds so it never becomes furniture. Leaving only a fading sentence means the
 * one that mattered is gone before it is read, though, so every notice is also written here — newest
 * first, capped, and device-local. It is a log of what *this* device was told, not user state, so it
 * lives beside the other device facts in `localStorage` and never travels in an export or through
 * sync.
 *
 * Pure functions plus two storage calls: the cap, the ordering and the dedupe are testable without a
 * browser, and a browser with storage disabled still runs (the log simply does not survive a reload).
 */

export interface NoticeLogEntry {
  /** When it was raised, in ms. */
  at: number;
  /** The sentence as it was shown. */
  text: string;
}

export const NOTICE_LOG_KEY = "hardlytracking.notices.v1";

/** How many entries are kept. Enough to answer "what did it say?", short enough to read. */
export const NOTICE_LOG_LIMIT = 50;

/** Keep only rows that are shaped like a notice; a hand-edited value must not break the page. */
export function parseNoticeLog(raw: unknown): NoticeLogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: NoticeLogEntry[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const text = typeof row.text === "string" ? row.text.trim() : "";
    const at = typeof row.at === "number" && Number.isFinite(row.at) ? row.at : 0;
    if (text === "") continue;
    out.push({ at, text });
  }
  return out.slice(0, NOTICE_LOG_LIMIT);
}

/**
 * The log with one notice added.
 *
 * Newest first, and the same sentence is not written twice in a row: a failing host reports on every
 * launch, and fifty copies of one line would push everything else out of the log. Repeating it moves
 * its timestamp instead, which is also what makes "still happening" visible.
 */
export function appendNotice(log: readonly NoticeLogEntry[], entry: NoticeLogEntry, limit: number = NOTICE_LOG_LIMIT): NoticeLogEntry[] {
  const text = entry.text.trim();
  if (text === "") return [...log];
  const rest = log.filter((row) => row.text !== text);
  return [{ at: entry.at, text }, ...rest].slice(0, Math.max(1, limit));
}

export function noticeTime(ms: number): string {
  if (ms <= 0) return "";
  return new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readNoticeLog(): NoticeLogEntry[] {
  const store = storage();
  if (store === null) return [];
  try {
    return parseNoticeLog(JSON.parse(store.getItem(NOTICE_LOG_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function writeNoticeLog(log: readonly NoticeLogEntry[]): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(NOTICE_LOG_KEY, JSON.stringify(log.slice(0, NOTICE_LOG_LIMIT)));
  } catch {
    // A browser with storage disabled still runs; the log simply does not survive a reload.
  }
}

export function clearNoticeLog(): void {
  const store = storage();
  try {
    store?.removeItem(NOTICE_LOG_KEY);
  } catch {
    // Same as above.
  }
}

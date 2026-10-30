/**
 * Trackers: the user's own list on someone else's service.
 *
 * HardlyTracking does not own a reading list in the cloud. What it owns is the *bind*: "this series
 * is entry 12345 on AniList". Progress still lives here first — a chapter read while a tracker is
 * down is read, and the push waits — and the service is a mirror that is reconciled, never trusted
 * to be the truth about this device.
 *
 * Three rules the types below encode:
 *
 * 1. **A push never lowers progress.** Services happily accept a lower chapter; a stale device
 *    pushing "chapter 3" over "chapter 40" is the classic way a list gets wrecked. `planPush` says
 *    what would be sent and refuses to go backwards.
 * 2. **A pull never lowers local progress.** The merge is `max`, and a disagreement is reported so
 *    the UI can say so instead of silently picking one.
 * 3. **Tokens are not backed up.** `TrackerAccountRow` is the one shape with a secret in it, so the
 *    sync document must never carry it; the backup code excludes this store by name.
 */

export type TrackerService = "mal" | "anilist" | "kitsu" | "shikimori" | "bangumi" | "mangaupdates";

export const TRACKER_SERVICES: TrackerService[] = ["mal", "anilist", "kitsu", "shikimori", "bangumi", "mangaupdates"];

/** What the services all agree on, in their own words where they differ. */
export type TrackerStatus = "reading" | "completed" | "on_hold" | "dropped" | "plan_to_read";

export const TRACKER_STATUSES: TrackerStatus[] = ["reading", "completed", "on_hold", "dropped", "plan_to_read"];

export const STATUS_LABEL: Record<TrackerStatus, string> = {
  reading: "Reading",
  completed: "Completed",
  on_hold: "On hold",
  dropped: "Dropped",
  plan_to_read: "Plan to read",
};

/** One bound series on one service. Key: `${service}:${seriesId}`. */
export interface TrackerRow {
  id: string;
  seriesId: string;
  service: TrackerService;
  remoteId: string;
  remoteTitle?: string;
  status?: TrackerStatus;
  /** The service's own scale, stored exactly as the service reports it. */
  score?: number;
  /** What the service says the user has read. */
  lastChapter?: number;
  syncedAt?: number;
  /**
   * A push that did not land.
   *
   * This is the queue: the row carries what it owes, so a failure survives a reload and the next
   * launch retries it. The reader never waits for it.
   */
  pending?: { chapter: number; at: number; error?: string };
}

/** A connected service. The only row in this app that holds a secret. */
export interface TrackerAccountRow {
  service: TrackerService;
  username?: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Absent means "no expiry known" — a password-grant JWT may not report one. */
  expiresAt?: number;
}

/** What a service reports about an entry. */
export interface TrackerEntry {
  status?: TrackerStatus;
  score?: number;
  lastChapter?: number;
}

export interface TrackerSearchResult {
  remoteId: string;
  title: string;
  year?: number;
  totalChapters?: number;
  cover?: string;
}

export function trackerId(service: TrackerService, seriesId: string): string {
  return `${service}:${seriesId}`;
}

export function splitTrackerId(id: string): { service: TrackerService; seriesId: string } | null {
  const at = id.indexOf(":");
  if (at < 1) return null;
  const service = id.slice(0, at) as TrackerService;
  if (!TRACKER_SERVICES.includes(service)) return null;
  return { service, seriesId: id.slice(at + 1) };
}

/**
 * The score scale each service uses, so one UI can show 0–10 and every adapter convert.
 *
 * `step` is the smallest move the service accepts: MAL and AniList are integers, Kitsu takes halves,
 * and a UI that offers 7.5 to MAL produces a 422 that looks like a bug in the app.
 */
export interface ScoreScale {
  max: number;
  step: number;
}

export const SCORE_SCALE: Record<TrackerService, ScoreScale> = {
  mal: { max: 10, step: 1 },
  anilist: { max: 100, step: 10 },
  kitsu: { max: 5, step: 0.5 },
  shikimori: { max: 10, step: 1 },
  bangumi: { max: 10, step: 1 },
  mangaupdates: { max: 10, step: 1 },
};

/** 0–10 from the UI to the service's own number, clamped and snapped to its step. */
export function toServiceScore(service: TrackerService, uiScore: number): number {
  const { max, step } = SCORE_SCALE[service];
  const raw = (Math.max(0, Math.min(10, uiScore)) / 10) * max;
  return Math.round(raw / step) * step;
}

/** The service's number back to 0–10 for the UI. */
export function toUiScore(service: TrackerService, serviceScore: number): number {
  const { max } = SCORE_SCALE[service];
  if (!Number.isFinite(serviceScore) || max <= 0) return 0;
  return Math.round(((serviceScore / max) * 10) * 2) / 2;
}

/**
 * What a push should send, or why it should send nothing.
 *
 * This is the whole safety of the feature in one pure function: it is the only place that decides
 * whether a chapter goes to a service, and it refuses three things that would corrupt a list —
 * going backwards, sending a chapter that was already sent, and sending nothing at all.
 */
export function planPush(
  row: Pick<TrackerRow, "lastChapter" | "pending">,
  chapter: number,
): { send: number } | { skip: "no-chapter" | "not-forward" | "already-sent" } {
  if (!Number.isFinite(chapter) || chapter <= 0) return { skip: "no-chapter" };
  const remote = row.lastChapter ?? 0;
  if (chapter <= remote) return { skip: "not-forward" };
  if (row.pending !== undefined && row.pending.chapter >= chapter) return { skip: "already-sent" };
  return { send: chapter };
}

/**
 * Merge what a service says with what this device knows.
 *
 * `chapter` is the higher of the two, `status` and `score` come from the service (it is the user's
 * list of record for those), and `disagreement` is true when the service is behind — the UI shows
 * "AniList says 12, you are at 40" rather than pretending they agree.
 */
export function reconcile(
  local: { chapter: number },
  remote: TrackerEntry,
): { chapter: number; disagreement: boolean; entry: TrackerEntry } {
  const remoteChapter = Number.isFinite(remote.lastChapter ?? NaN) ? (remote.lastChapter as number) : 0;
  return {
    chapter: Math.max(local.chapter, remoteChapter),
    disagreement: remoteChapter < local.chapter,
    entry: remote,
  };
}

/** A token that is about to expire is refreshed before the call, not after a 401. */
export function needsRefresh(account: Pick<TrackerAccountRow, "expiresAt">, now = Date.now(), skewMs = 60_000): boolean {
  if (account.expiresAt === undefined) return false;
  return account.expiresAt - skewMs <= now;
}

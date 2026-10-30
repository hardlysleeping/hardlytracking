/**
 * When a failed push may be tried again, and what a push is allowed to send.
 *
 * A tracker that is down must not be hammered: six services on a phone that just came back online
 * is six lists to retry, and retrying every one of them on every page turn is how an app gets rate
 * limited for a whole day. The ladder is a column on the row (`pending.attempt`), so it survives a
 * reload — a timer would restart at zero on every launch and a chapter could never be retried.
 *
 * Pure on purpose: the runner in `host.ts` decides nothing about timing, it asks these.
 */
import type { PendingPush } from "./types";

/**
 * The retry ladder, in ms, indexed by the number of failures so far.
 *
 * 1 min, 5 min, 15 min, 1 h, then 6 h forever. The first rung is short because the common failure is
 * a phone that lost signal for a minute; the cap is long because a service that has refused five
 * times is having an outage, not a hiccup, and a chapter owed to it is not urgent.
 */
export const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000] as const;

/** How long to wait after `attempt` failures. Zero failures means "due now". */
export function backoffDelay(attempt: number): number {
  const failures = Math.floor(attempt);
  if (!Number.isFinite(failures) || failures <= 0) return 0;
  const index = Math.min(failures, BACKOFF_MS.length) - 1;
  return BACKOFF_MS[index];
}

/**
 * Is this debt ready for another attempt?
 *
 * A row that has never been tried is due immediately — that is the case a bind produces (the device
 * is ahead of the service and owes it a push), and waiting a minute for it would look like the
 * feature does not work.
 */
export function isDue(pending: Pick<PendingPush, "at" | "attempt">, now: number): boolean {
  const at = Number.isFinite(pending.at) ? pending.at : 0;
  return at + backoffDelay(pending.attempt ?? 0) <= now;
}

/**
 * The chapter a push and a pull settle on: the higher of the two.
 *
 * Never lowers either side, which is the whole reason it exists — a stale device or a stale row must
 * not be able to walk a list backwards.
 */
export function nextChapter(local: number | undefined, remote: number | undefined): number {
  const a = Number.isFinite(local ?? NaN) ? (local as number) : 0;
  const b = Number.isFinite(remote ?? NaN) ? (remote as number) : 0;
  return Math.max(a, b);
}

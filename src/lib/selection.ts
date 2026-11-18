/**
 * Wait for a selection to stop moving.
 *
 * A pane is chosen by tapping, and tapping is a burst: flicking through five titles in a second used
 * to start five detail fetches and five chapter fetches — four of which were thrown away on arrival,
 * after their round trips (or a Dalvik extension's scraper) had already been paid for. Waiting a
 * moment for the selection to settle turns a burst into one fetch, for the title the reader stopped
 * on.
 *
 * The wait is only ever the *remote* half. What the database already holds is painted on the pick
 * itself, so the pane answers the finger immediately; this is the part that costs a network call.
 *
 * `stillWanted` is asked before the timer starts and again after it fires, so a selection that moved
 * while the timer was running answers `false` and the caller does no work at all.
 */
export const SELECTION_SETTLE_MS = 150;

export async function settleSelection(ms: number, stillWanted: () => boolean): Promise<boolean> {
  // A full page is a decision, not a gesture: nothing to wait for.
  if (ms <= 0) return stillWanted();
  if (!stillWanted()) return false;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
  return stillWanted();
}
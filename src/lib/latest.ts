/**
 * "The newest request is the only one allowed to paint."
 *
 * A screen whose rows depend on a tap — a source listing, a detail refresh, a page of results —
 * gets its answers out of order as soon as it is tapped twice. The slow answer for the source the
 * reader left arrives after the fast answer for the one they are looking at, and the grid fills with
 * the wrong title's rows. Cancelling the fetch is the polite version; this is the version that works
 * for a provider that cannot be cancelled, and it is what the detail and reader screens already do
 * by hand.
 *
 * `begin()` claims the screen and returns a token. `isCurrent(token)` is the only thing an await is
 * allowed to check before it writes. `cancel()` claims it without starting anything, for a screen
 * that is being torn down or reset — every request already in flight becomes stale.
 */
export interface Generations {
  begin(): number;
  isCurrent(token: number): boolean;
  cancel(): void;
}

export function generations(): Generations {
  let current = 0;
  return {
    begin: () => {
      current += 1;
      return current;
    },
    isCurrent: (token) => token === current,
    cancel: () => {
      current += 1;
    },
  };
}
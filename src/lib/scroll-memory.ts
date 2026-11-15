/**
 * Where each screen was left.
 *
 * The shell owns one scroller for every destination, and the reader is a separate route that
 * unmounts the shell entirely — so opening a chapter destroyed the scroll position of the list it
 * was opened from, and Back put you at the top of a page you had half read. Keeping the offsets
 * beside the component (not inside it) is what lets a screen that was never on display remember
 * its own place.
 *
 * The key is the route key the shell is given: two screens that share a name are one place, and a
 * different title (a different id) is a different place with its own offset.
 */
const offsets = new Map<string, number>();

/** The place a route was left at, or the top when it has never been left. */
export function scrollFor(key: string): number {
  return offsets.get(key) ?? 0;
}

/** Record where a route now sits. An empty key is a route with no place to keep. */
export function rememberScroll(key: string, top: number): void {
  if (key === "" || !Number.isFinite(top) || top < 0) return;
  offsets.set(key, top);
}

/** Forget everything: used by a fresh profile, where another library's offsets mean nothing. */
export function forgetScroll(): void {
  offsets.clear();
}

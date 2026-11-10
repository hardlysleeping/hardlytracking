/**
 * Where the reader came from, so leaving it returns there.
 *
 * The reader covers the whole screen and is a route, so "close" is a navigation like any other.
 * It used to close on the *series* page (`#/series/<id>`) no matter how it was opened, which meant
 * a ▶ on a library card or a Continue row — both of which resume a chapter without ever showing the
 * series page — dropped you on a page you had not asked for, with the shelf, its collection and its
 * scroll position gone. The reader now remembers the screen it was opened from and hands it back.
 *
 * `steps` matters as much as the path: chapter-to-chapter jumps are hash pushes too, so leaving must
 * pop every entry the reader added. Going back `steps` entries lands on the original entry rather
 * than pushing a new one — a copy of the shelf on top of the reader's stack would make the phone's
 * Back button open the reader again.
 *
 * A cold start on `#/read/…` has no origin (nothing was left behind), so it keeps the old answer:
 * the series page. Nothing here is stored, because a relaunch has no history to return to.
 */
import { navHistory } from "./nav-history.svelte";
import { go, pathTo } from "./nav";

/** The hash of the last screen that was not the reader, and the router depth it sat at. */
let origin: string | null = null;
let originDepth = 0;
/** The previous route, so an entry into the reader can be told from a chapter change. */
let lastPath: string | null = null;
let lastWasRead = false;

/** Called by the router on every route, in both directions. */
export function noteRoute(hash: string, isRead: boolean): void {
  if (isRead) {
    // Only an entry counts: a chapter change (read → read) keeps the origin it already has.
    if (!lastWasRead) {
      origin = lastPath;
      // The reader's own entry is already on the stack when this runs (the router pushed it, then
      // told us), so the origin sits one entry below. A router that has no marks to count yet is
      // treated as having nothing to pop — the replace path below is safe there.
      originDepth = navHistory.depth > 0 ? navHistory.depth - 1 : navHistory.depth;
    }
  } else {
    // Out of the reader by any other door (device Back, a link): there is nothing to return to.
    origin = null;
  }
  lastPath = hash;
  lastWasRead = isRead;
}

/** The remembered screen, or null when this reader was not opened from one. */
export function readerOrigin(): { hash: string; steps: number } | null {
  if (origin === null) return null;
  return { hash: origin, steps: Math.max(0, navHistory.depth - originDepth) };
}

/**
 * Leave the reader: back to the screen it was opened from, or the series page when there is none.
 *
 * The series id is the fallback only — it is never where a reader opened from a shelf lands.
 */
export function leaveReader(seriesId: string): void {
  const back = readerOrigin();
  if (back === null) {
    go(pathTo("series", seriesId));
    return;
  }
  if (back.steps > 0) {
    // The exact entry, with every reader entry popped: Back afterwards leaves the screen, not reopens.
    history.go(-back.steps);
    return;
  }
  // No entry to pop (a replaced route, or a router that reset): replace rather than stack.
  history.replaceState(null, "", back.hash);
  go(back.hash);
}

/** For a label: what the exit door goes back to, in the owner's words. */
export function readerOriginLabel(): string {
  const hash = origin ?? "";
  if (hash.startsWith("#/library")) return "Library";
  if (hash.startsWith("#/history")) return "History";
  if (hash.startsWith("#/downloads")) return "Downloads";
  if (hash.startsWith("#/updates")) return "Updates";
  if (hash.startsWith("#/search")) return "Search";
  if (hash.startsWith("#/browse")) return "Browse";
  if (hash.startsWith("#/series")) return "the series";
  return "the previous screen";
}

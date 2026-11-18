/**
 * Which page is being read, without measuring the whole chapter.
 *
 * The reader used to answer that by walking every `[data-page]` node on each scroll event and
 * calling `getBoundingClientRect()` on it: on a 214-page webtoon that is 214 forced layouts per
 * scroll event, and the scroll is the one thing that must stay smooth. The boxes that can matter are
 * the ones on screen, so an `IntersectionObserver` keeps that set and this module picks the current
 * page from it — a handful of measurements instead of a chapter's worth.
 *
 * Both pieces are pure so they can be tested without a browser: the observer's job is only to say
 * which indexes are near, and that is `remember()`.
 */

/** Add and remove indexes from `visible` as the observer reports boxes entering and leaving. */
export function remember(visible: Set<number>, entries: Array<{ index: number; visible: boolean }>): Set<number> {
  for (const entry of entries) {
    if (entry.visible) visible.add(entry.index);
    else visible.delete(entry.index);
  }
  return visible;
}

/**
 * The page whose leading edge is nearest the reading edge.
 *
 * `candidates` are the measurements taken for the boxes on screen, each with the page's index and
 * how far its edge is from the viewport's. `fallback` is the page already being read: an empty
 * candidate list (a fast fling, a re-layout, the moment before the observer reports) must not
 * reset the reader to page one.
 */
export function currentPage(
  candidates: Array<{ index: number; distance: number }>,
  fallback: number,
): number {
  let best = fallback;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.distance)) continue;
    if (candidate.distance < bestDistance) {
      bestDistance = candidate.distance;
      best = candidate.index;
    }
  }
  return best;
}
/**
 * Chapter order, decided in one place.
 *
 * The series page used to sort only when the reader asked for oldest-first and otherwise trust the
 * provider's order — which made the toggle look dead on every source that already returned chapters
 * ascending. A sort control must always sort: the host's order is not a promise, and "newest first"
 * has to mean newest first whatever the host happened to send.
 */
import type { Chapter } from "../api/source";

export type ChapterOrder = "oldest" | "newest";

/**
 * Sort chapters by number, in the requested direction.
 *
 * Unnumbered chapters (`number` 0, a special or a bonus) go last in both directions: they are not
 * "the oldest", they simply have no place in the sequence. Ties keep a stable order by name so the
 * list does not reshuffle between renders.
 */
export function orderChapters<T extends Pick<Chapter, "number" | "name">>(chapters: readonly T[], order: ChapterOrder): T[] {
  const direction = order === "oldest" ? 1 : -1;
  return [...chapters].sort((a, b) => {
    const aNumbered = a.number > 0;
    const bNumbered = b.number > 0;
    if (aNumbered !== bNumbered) return aNumbered ? -1 : 1;
    if (aNumbered && a.number !== b.number) return direction * (a.number - b.number);
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

/** The label on the control: what the list is showing now. */
export function orderLabel(order: ChapterOrder): string {
  return order === "oldest" ? "Oldest first" : "Newest first";
}

/** What a tap does. */
export function flipOrder(order: ChapterOrder): ChapterOrder {
  return order === "oldest" ? "newest" : "oldest";
}

/**
 * What this device knows about a title, in the numbers a tracker cares about.
 *
 * Kept out of the view because the rule has a wrong answer that looks right: the *last* chapter in
 * the list is not the furthest one read, and an unread chapter with a high number is not progress.
 * Only read marks count, and only their own `number` — never the position in the list.
 */
import type { Chapter } from "../../api/source";

/** The highest chapter number this device has a read mark for, or 0 when it has none. */
export function highestReadChapter(chapters: Pick<Chapter, "read" | "number">[]): number {
  let top = 0;
  for (const chapter of chapters) {
    if (!chapter.read) continue;
    const number = chapter.number;
    if (Number.isFinite(number) && number > top) top = number;
  }
  return top;
}
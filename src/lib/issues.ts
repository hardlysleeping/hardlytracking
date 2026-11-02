/**
 * The issue list behind a card, as data rather than as markup.
 *
 * Two rules live here because both are easy to get subtly wrong in a component and neither is
 * obvious from looking at the screen: which read marks count, and which answer to believe when the
 * user has already moved on to another title.
 */
import type { Chapter } from "../api/source";

/** A preference row, as the store hands it over. */
export interface PrefRow {
  key: unknown;
  value: unknown;
}

/**
 * The read tick as the app should draw it.
 *
 * A provider that keeps its own read marks (Suwayomi, Komga) says so per chapter; ours live in the
 * prefs store under `read:<chapterId>`. Either is enough for a tick, and neither may clear the other —
 * a chapter the server marked read must not lose its tick because this device has no pref for it.
 */
export function mergeReadMarks(chapters: Chapter[], prefs: PrefRow[]): Chapter[] {
  const local = new Set(
    prefs
      .filter((row) => typeof row.key === "string" && row.key.startsWith("read:") && row.value === true)
      .map((row) => (row.key as string).slice("read:".length)),
  );
  if (local.size === 0) return chapters;
  return chapters.map((chapter) =>
    chapter.read || local.has(chapter.id) ? { ...chapter, read: true } : chapter,
  );
}

/**
 * Whether an answer that arrived now is still wanted.
 *
 * A card is opened, closed and opened again quickly; the first source can answer last. Every open
 * takes a token, and only the newest one may paint — otherwise the card shows the previous title's
 * chapters under this title's name.
 */
export function stillWanted(answerToken: number, currentToken: number): boolean {
  return answerToken === currentToken;
}

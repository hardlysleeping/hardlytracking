/**
 * Continue Reading: what the strip offers, and what happens when a chapter is finished.
 *
 * Two decisions, both testable without a browser:
 *
 * 1. **What is eligible.** A position row is the fact; a dismissal is a preference. Dismissing a
 *    title takes it off the strip without deleting anything — the position, the library row and
 *    the history row all stay, because "don't show me this here" is not "forget I read it" (§8).
 * 2. **Where to go after a finished chapter.** The spec's rule is the *next unread* chapter, not
 *    the next chapter: a re-read of chapter 3 should not point at chapter 4 when chapter 12 is the
 *    one that was never opened. And at the end of the list it does nothing at all — never wraps to
 *    chapter 1, which would silently lose the reader's place.
 */
import type { Chapter } from "../../api/source";

export interface ContinueRow {
  seriesId: string;
  chapterId: string;
  page: number;
  title: string;
  cover?: string;
  chapterName?: string;
}

export type ContinueSize = "small" | "medium";
export type ContinuePosition = "above" | "below";
export type AfterFinish = "next-unread" | "hold";

export interface ContinueRules {
  afterFinish: AfterFinish;
  /** 1–20; the strip never draws more. */
  max: number;
  size: ContinueSize;
  position: ContinuePosition;
}

export const DEFAULT_CONTINUE_RULES: ContinueRules = {
  afterFinish: "next-unread",
  max: 10,
  size: "small",
  position: "above",
};

/** Clamp a stored value, so a hand-edited pref cannot draw 400 cards. */
export function clampMax(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONTINUE_RULES.max;
  return Math.min(Math.max(Math.round(value), 1), 20);
}

/**
 * The series a position row belongs to.
 *
 * The row stores whatever series id the reader was opened under, and a URL can name another one —
 * an old bookmark, a hand-written hash, a link from before a migration. The chapter mirror is the
 * authority on which series owns a chapter, so when the two disagree the chapter wins: the resume
 * link then carries a series that exists, and prev/next and the back link work. Without this a
 * position written under a wrong id made Continue point at a series that was never in the library,
 * which read as a title with no name and two dead buttons.
 */
export function seriesOfPosition(stored: string, chapter: { seriesId?: string } | undefined): string {
  const owner = chapter?.seriesId;
  return typeof owner === "string" && owner !== "" ? owner : stored;
}

/** A new reader sees the strip open; only an explicit `true` folds it. */
export const DEFAULT_CONTINUE_COLLAPSED = false;

/**
 * The fold from storage.
 *
 * A pref written by an older build, a hand-edited value or a restored JSON that forgot the field
 * must not fold the strip: only the literal `true` does, so the default is safe on every path.
 */
export function continueCollapsedOf(value: unknown): boolean {
  return value === true;
}

/** The rows the strip draws: dismissed series dropped, order kept, then truncated. */
export function eligible(rows: ContinueRow[], dismissed: Set<string>, max: number = DEFAULT_CONTINUE_RULES.max): ContinueRow[] {
  const kept = rows.filter((row) => !dismissed.has(row.seriesId));
  const limit = clampMax(max);
  return kept.slice(0, limit);
}

/**
 * The next chapter to read after `currentId`.
 *
 * The list is walked in the order it is given — the caller passes the series' reading order. A
 * chapter that is already read is skipped, because the point is the next thing *to read*.
 */
export function nextUnread(chapters: Chapter[], currentId: string): Chapter | null {
  const at = chapters.findIndex((chapter) => chapter.id === currentId);
  if (at < 0) return null;
  for (let index = at + 1; index < chapters.length; index += 1) {
    const chapter = chapters[index];
    if (chapter !== undefined && !chapter.read) return chapter;
  }
  return null;
}

/** True when the strip should be drawn at all. */
export function showsContinue(show: boolean, rows: ContinueRow[]): boolean {
  return show && rows.length > 0;
}

/**
 * The quick-action sheet's arithmetic: what to offer on a series, what a category row says, and what
 * a toggle does.
 *
 * Pure, because all three are decisions a user will notice when they are wrong: a count that includes
 * the title you are filing, an "Uncategorized" tick that stays on after you picked a shelf, a toggle
 * that removes the last category and leaves the row in limbo instead of back in Uncategorized.
 *
 * Uncategorized is not a category. In the store it is `categoryIds: []`, exactly as a Mihon backup
 * writes it, so nothing new is stored — the picker draws it as a row because a user needs to see
 * where a title will land, and it is checked precisely when nothing else is.
 */
import type { Category } from "../categories";

/** What a picker row is: a real category, or the absence of one. */
export const UNCATEGORIZED_ID = "__uncategorized__";

export interface PickerRow {
  id: string;
  name: string;
  /** How many library titles are filed here. For Uncategorized, how many are in no category. */
  count: number;
  /** Is the series being edited filed here right now? */
  checked: boolean;
}

export interface PickerModel {
  uncategorized: PickerRow;
  rows: PickerRow[];
}

/** The ids a series is filed under, as a set the picker can ask about. */
function idsOf(series: { categoryIds?: string[] }): string[] {
  return series.categoryIds ?? [];
}

/**
 * The picker: Uncategorized first, then every category in the user's own order.
 *
 * Counts are of the whole library, and they include the title being edited — a shelf that says "12"
 * and holds the title you are filing is the truth; a count that quietly subtracted it would move as
 * you toggle and read as a bug.
 */
export function pickerModel(
  categories: Category[],
  series: { categoryIds?: string[] },
  library: Array<{ categoryIds?: string[] }>,
): PickerModel {
  const mine = new Set(idsOf(series));
  const counts = new Map<string, number>();
  let uncategorized = 0;
  for (const row of library) {
    const ids = idsOf(row);
    if (ids.length === 0) uncategorized += 1;
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ordered = [...categories].sort((a, b) => a.order - b.order);
  return {
    uncategorized: {
      id: UNCATEGORIZED_ID,
      name: "Uncategorized",
      count: uncategorized,
      // Checked when the title is in nothing — which is also the state it is added in.
      checked: mine.size === 0,
    },
    rows: ordered.map((category) => ({
      id: category.id,
      name: category.name,
      count: counts.get(category.id) ?? 0,
      checked: mine.has(category.id),
    })),
  };
}

/**
 * Toggling one row. Uncategorized is exclusive and implicit: choosing a category clears it, and
 * clearing the last category brings it back — there is no state where a title is in a category *and*
 * uncategorized, because that is not a state the store can hold.
 */
export function toggleAssignment(selected: string[], id: string): string[] {
  if (id === UNCATEGORIZED_ID) return [];
  return selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
}

/** The row's subtitle: where this title sits, in words, never a bare number. */
export function assignmentLabel(names: string[]): string {
  if (names.length === 0) return "Uncategorized";
  if (names.length <= 2) return names.join(", ");
  return `${names.length} categories`;
}

/** The category button's own words, which also carry the count. */
export function categoryActionLabel(names: string[]): string {
  if (names.length === 0) return "Categories";
  return `Categories · ${names.length}`;
}

/**
 * What "Download" should queue: every chapter this device does not already hold, newest first as the
 * provider returned them.
 *
 * The button says how many, so nothing is queued silently, and a series already on the device gets
 * no work at all rather than a queue of zero-length items.
 */
export function downloadCandidates<T extends { id: string }>(
  chapters: T[],
  isDownloaded: (chapterId: string) => boolean,
  limit = DOWNLOAD_LIMIT,
): T[] {
  return chapters.filter((chapter) => !isDownloaded(chapter.id)).slice(0, Math.max(0, limit));
}

/**
 * How many chapters one tap may queue.
 *
 * A series can have 500+ chapters and the quick sheet is one tap in a list of results: queueing all
 * of them because the first chapter looked interesting is a download nobody asked for. The button
 * says the number, and "Download all" stays on the series page where the user has decided.
 */
export const DOWNLOAD_LIMIT = 25;

/** The Download row's label, so the count is never a surprise after the tap. */
export function downloadLabel(candidates: number, busy: boolean, loaded = true): string {
  if (busy) return "Checking chapters…";
  // Before the chapter list has answered, "Downloaded" would be a claim the app cannot make yet.
  if (!loaded) return "Download";
  if (candidates === 1) return "Download 1 chapter";
  if (candidates > 1) return `Download ${candidates} chapters`;
  return "Downloaded";
}

/**
 * Where "Read" goes: the chapter being read, else the first unread one, else the first chapter.
 *
 * Newest-first providers and oldest-first providers both arrive in their own order, so this never
 * re-sorts — it picks the first row that answers the question, and `null` means there is nothing to
 * read yet (the caller opens the series page instead of an empty reader).
 */
export function readTarget<T extends { id: string; read?: boolean }>(
  chapters: T[],
  resumeChapterId?: string | null,
): T | null {
  if (chapters.length === 0) return null;
  if (resumeChapterId !== undefined && resumeChapterId !== null) {
    const resumed = chapters.find((chapter) => chapter.id === resumeChapterId);
    if (resumed !== undefined) return resumed;
  }
  return chapters.find((chapter) => chapter.read !== true) ?? chapters[0];
}

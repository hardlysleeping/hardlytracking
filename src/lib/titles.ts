/**
 * Names for things that were stored as ids.
 *
 * A history row keeps the ids it needs to resume a chapter, not the title — that is right, because a
 * title can change and a row must still open. The cost is that anything rendering a row has to
 * resolve a name, and a raw provider id in a list is a bug the reader sees. These helpers keep the
 * decision in one place: a real name, or an honest placeholder, never an id.
 */

/** True for `dalvik:…`, `mihon:…`, `local:…` — a namespaced provider id, not a title. */
export function looksLikeId(value: string): boolean {
  return /^(dalvik|mihon|local|komga|suwayomi):/i.test(value.trim());
}

/** A name, or the fallback when it is empty or is really an id. */
export function readableName(name: string | undefined | null, fallback: string): string {
  if (name === undefined || name === null) return fallback;
  const trimmed = name.trim();
  if (trimmed === "") return fallback;
  if (looksLikeId(trimmed)) return fallback;
  return trimmed;
}

/** `Chapter 12`, or the honest placeholder — a chapter row without a name is still a chapter. */
export function chapterLabel(name: string | undefined | null): string {
  return readableName(name, "Chapter");
}

/**
 * What a chapter row is called.
 *
 * A real name beats a generated one: Mihon's own names are "Chapter 12", so those stay as they are,
 * while an archive.org volume called "Berserk v01 (2003)" stops being "Chapter 1". The series page and
 * the search card both draw chapter rows, and they must not disagree about the same chapter.
 */
export function chapterTitle(chapter: { name?: string | null; number?: number | null }): string {
  const named = chapterLabel(chapter.name);
  if (named !== "Chapter") return named;
  const number = chapter.number ?? 0;
  return number > 0 ? `Chapter ${number}` : named;
}

/** `Unknown title` — the placeholder for a series we cannot name yet. */
export function seriesLabel(name: string | undefined | null): string {
  return readableName(name, "Unknown title");
}

/**
 * The source as a reader names it, never as the runtime spells it.
 *
 * `mihon` and `dalvik` are implementation words — one is the Suwayomi runtime, the other an
 * extension host — so a card that said `dalvik` would be showing an id where a name belongs.
 * An extension's own name is better still when the caller knows it; this is the floor.
 */
export function sourceLabel(provider: string | undefined | null): string {
  switch ((provider ?? "").trim().toLowerCase()) {
    case "mihon":
      return "Suwayomi";
    case "dalvik":
      return "Extension";
    case "komga":
      return "Komga";
    case "local":
      return "This device";
    default:
      return "Unknown source";
  }
}

/** `2 unread`, `1 unread`, or nothing at all — never `0 unread`. */
export function unreadLabel(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "1 unread" : `${count} unread`;
}

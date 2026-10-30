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

/** `Unknown title` — the placeholder for a series we cannot name yet. */
export function seriesLabel(name: string | undefined | null): string {
  return readableName(name, "Unknown title");
}

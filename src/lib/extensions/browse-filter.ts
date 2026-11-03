/**
 * What the Available list shows, as pure functions.
 *
 * One repository can publish over a thousand extensions across a dozen languages, and the list is
 * read through two controls that must agree: the search box and the language chips. Keeping the
 * rule here rather than inside the template means the "no match" count and the rows cannot drift.
 */
import type { ExtensionEntry } from "./index";

/** The value that means "do not narrow by language". Never a real source code. */
export const ALL_LANGUAGES = "all";

/** Every language the visible entries publish in, lower-case and sorted, for the chips. */
export function languagesOf(entries: ExtensionEntry[]): string[] {
  const codes = new Set<string>();
  for (const entry of entries) {
    for (const source of entry.sources) {
      const code = source.lang.trim().toLowerCase();
      if (code !== "") codes.add(code);
    }
  }
  return [...codes].sort((a, b) => a.localeCompare(b));
}

/**
 * One entry, against the search text and the chosen language.
 *
 * The search deliberately still has the final say over languages: it matches the entry's name,
 * package and language codes, so typing `es` finds Spanish sources whether or not a chip is set.
 */
export function matchesBrowseFilter(
  entry: ExtensionEntry,
  query: string,
  language: string = ALL_LANGUAGES,
): boolean {
  const wanted = language.trim().toLowerCase();
  const codes = entry.sources.map((source) => source.lang.trim().toLowerCase());
  if (wanted !== ALL_LANGUAGES && wanted !== "" && !codes.includes(wanted)) return false;
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return `${entry.name} ${entry.pkg} ${codes.join(" ")}`.toLowerCase().includes(needle);
}

/** The same rule for a whole list, in index order. */
export function filterEntries(
  entries: ExtensionEntry[],
  query: string,
  language: string = ALL_LANGUAGES,
): ExtensionEntry[] {
  return entries.filter((entry) => matchesBrowseFilter(entry, query, language));
}

/**
 * Keep a chosen language only while the entries still offer it.
 *
 * Tapping another repository must not leave the list filtered to a language that repository does
 * not publish — that reads as an empty repository rather than as a forgotten chip.
 */
export function keepLanguage(language: string, entries: ExtensionEntry[]): string {
  if (language === ALL_LANGUAGES) return ALL_LANGUAGES;
  return languagesOf(entries).includes(language) ? language : ALL_LANGUAGES;
}

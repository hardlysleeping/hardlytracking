/**
 * What the Available list shows, as pure functions.
 *
 * One repository can publish over a thousand extensions across dozens of languages. The list is read
 * through two controls that must agree — the search box and the language sheet — so the rule lives
 * here rather than in the template, where the count and the rows would drift apart.
 *
 * Two decisions are encoded here because they are easy to lose in a template:
 *
 * - **No filter means the whole index, alphabetically.** The list is a catalogue: opening a
 *   repository lists what is in it, A to Z, without anyone typing or picking anything first.
 * - **Languages are a set.** A reader who wants Spanish and English picks both; a single chosen code
 *   used to replace the last one, which made the chips behave like radio buttons and hid most of the
 *   index.
 */
import type { ExtensionEntry } from "./index";

/** Every language the given entries publish in, lower-case and sorted, for the sheet. */
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

/** How many entries publish in each language — the number beside a row in the language sheet. */
export function languageCounts(entries: ExtensionEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const codes = new Set(entry.sources.map((source) => source.lang.trim().toLowerCase()).filter((code) => code !== ""));
    for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return counts;
}

/**
 * One entry, against the search text and the chosen languages.
 *
 * An empty selection is "every language", never "no language": clearing the sheet has to mean the
 * whole index again. An entry with no sources is in the index but in no language, so a language
 * filter hides it — and search still finds it by name or package.
 *
 * The search deliberately keeps the final say: it matches the entry's name, package and language
 * codes, so typing `es` finds Spanish sources whether or not any language is picked.
 */
export function matchesBrowseFilter(
  entry: ExtensionEntry,
  query: string,
  languages: readonly string[] = [],
): boolean {
  const wanted = languages.map((code) => code.trim().toLowerCase()).filter((code) => code !== "");
  if (wanted.length > 0) {
    const codes = entry.sources.map((source) => source.lang.trim().toLowerCase());
    if (!wanted.some((code) => codes.includes(code))) return false;
  }
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return `${entry.name} ${entry.pkg} ${entry.sources.map((source) => source.lang).join(" ")}`.toLowerCase().includes(needle);
}

/**
 * The rows the list draws: filtered, then alphabetical by name.
 *
 * Alphabetical is the point, not a detail — an index arrives roughly grouped the way its publisher
 * wrote it, and a catalogue nobody can scan is why the list read as broken until a search was typed.
 */
export function filterEntries(
  entries: ExtensionEntry[],
  query: string,
  languages: readonly string[] = [],
): ExtensionEntry[] {
  return entries
    .filter((entry) => matchesBrowseFilter(entry, query, languages))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.pkg.localeCompare(b.pkg));
}

/**
 * Drop chosen languages the current index does not publish.
 *
 * Switching repository must not leave the list filtered to a language the new index has never heard
 * of — that reads as an empty repository rather than as a forgotten filter.
 */
export function keepLanguages(languages: readonly string[], entries: ExtensionEntry[]): string[] {
  const available = new Set(languagesOf(entries));
  return languages.filter((code) => available.has(code));
}

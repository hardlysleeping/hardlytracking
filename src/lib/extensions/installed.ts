/**
 * An installed extension, described for a person.
 *
 * The database row is a runtime handle: a sha256, a package id, a version code. None of that is
 * what the user installed — they installed "MangaFire". The index knows the name and the icon, so
 * both are stored on the row at install time; an older row that has neither still renders, from its
 * package id, rather than showing a blank card.
 */
import type { InstalledExtension } from "../../api/dalvik";
import type { Source } from "../../api/source";

/** "eu.kanade.tachiyomi.extension.all.mangafire" → "Mangafire". Last resort only. */
export function nameFromPackage(packageId: string): string {
  const last = packageId.split(".").filter(Boolean).pop() ?? packageId;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/** What to print above the version: the index's name, else something readable from the package. */
export function extensionLabel(row: Pick<InstalledExtension, "name" | "packageId">): string {
  const name = (row.name ?? "").trim();
  return name === "" ? nameFromPackage(row.packageId) : name;
}

/** Languages the extension's sources cover, de-duplicated and ordered as the index lists them. */
export function extensionLanguages(row: Pick<InstalledExtension, "sources">): string[] {
  const seen: string[] = [];
  for (const source of row.sources) {
    const lang = (source.lang ?? "").trim();
    if (lang !== "" && !seen.includes(lang)) seen.push(lang);
  }
  return seen;
}

/** The namespaced ids of this extension's sources, so a button can open one. */
export function extensionSourceIds(row: Pick<InstalledExtension, "sources">): string[] {
  return row.sources.map((source) => `dalvik:src:${source.id}`);
}

/**
 * The installed sources that belong to one extension.
 *
 * Matching by id keeps the two views honest: the extension row owns its source ids, and the source
 * list is the provider's answer. A source whose extension was uninstalled simply has no match.
 */
export function sourcesOfExtension(sources: readonly Source[], row: Pick<InstalledExtension, "sources">): Source[] {
  const ids = new Set(extensionSourceIds(row));
  return sources.filter((source) => ids.has(source.id));
}

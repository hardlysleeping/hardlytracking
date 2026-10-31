/**
 * Aidoku source lists.
 *
 * `index.min.json` — `{ name, sources: [ … ] }`, one entry per installable package:
 *
 * ```json
 * { "id": "ar.aasq", "name": "3asq", "version": 2, "iconURL": "icons/ar.aasq-v2.png",
 *   "downloadURL": "sources/ar.aasq-v2.aix", "languages": ["ar"], "contentRating": 0,
 *   "baseURL": "https://3asq.online", "minAppVersion": "0.7.1" }
 * ```
 *
 * Every URL is relative to the list's own URL, which is why the parser takes the base. The
 * deprecated keys (`file`, `icon`, `lang`, `nsfw`) are still honoured: an older list is still a
 * list, and refusing it would hide sources that install fine.
 *
 * A package is a `.aix` — a zip whose `Payload/main.wasm` is the source itself (see
 * `src/lib/hosts/wasm/`). Nothing here downloads or runs it.
 */

import { absoluteUrl, arrayOf, contentWarningOf, isRecord, uniqueLangs } from "./index";
import type { RepoEntry, RepoIndex } from "./index";

function strings(value: unknown): string[] {
  return arrayOf(value).filter((v): v is string => typeof v === "string");
}

export function parseAidokuRepo(raw: unknown, base: string): RepoIndex {
  if (!isRecord(raw) || !Array.isArray(raw.sources)) {
    throw new Error("not an Aidoku source list: expected an object with a `sources` array");
  }
  const name = typeof raw.name === "string" && raw.name !== "" ? raw.name : "Aidoku source list";
  const entries: RepoEntry[] = [];

  for (const item of raw.sources) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id : "";
    if (id === "") continue;
    // `downloadURL` is current; `file` is the old form, resolved under `sources/`.
    const download =
      typeof item.downloadURL === "string"
        ? item.downloadURL
        : typeof item.file === "string"
          ? `sources/${item.file}`
          : "";
    if (download === "") continue;
    const icon =
      typeof item.iconURL === "string"
        ? item.iconURL
        : typeof item.icon === "string"
          ? `icons/${item.icon}`
          : undefined;
    const langs = uniqueLangs([...strings(item.languages), ...strings([item.lang])]);
    const displayName = typeof item.name === "string" && item.name !== "" ? item.name : id;
    const rating = item.contentRating ?? item.nsfw;
    const entry: RepoEntry = {
      kind: "aidoku",
      id,
      name: displayName,
      // Aidoku's `version` is an integer counter; there is no separate version name.
      version: typeof item.version === "number" ? String(item.version) : String(item.version ?? "0"),
      versionCode: typeof item.version === "number" ? item.version : Number(item.version) || 0,
      packageUrl: absoluteUrl(download, base),
      contentWarning: contentWarningOf(rating),
      langs,
      // One package is one source; its `baseURL` is the site it reads.
      sources: [
        {
          id,
          name: displayName,
          lang: langs[0] ?? "",
          ...(typeof item.baseURL === "string" ? { homeUrl: item.baseURL } : {}),
        },
      ],
    };
    if (icon !== undefined) entry.iconUrl = absoluteUrl(icon, base);
    if (typeof item.minAppVersion === "string") entry.minHostVersion = item.minAppVersion;
    entries.push(entry);
  }

  return { kind: "aidoku", name, entries };
}

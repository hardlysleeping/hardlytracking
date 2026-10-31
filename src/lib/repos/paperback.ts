/**
 * Paperback 0.9 repositories.
 *
 * `<base>/versioning.json` is the whole index:
 *
 * ```json
 * { "buildTime": "…", "builtWith": "…",
 *   "repository": { "name": "paperbackext", "description": "…" },
 *   "sources": [ { "id": "APComics", "name": "AP Comics", "version": "1.4.55.1",
 *                  "icon": "icon.png", "language": "en", "contentRating": "MATURE",
 *                  "capabilities": [4, 64, 1], "badges": [ … ], "developers": [ … ] } ] }
 * ```
 *
 * The source itself is plain JavaScript at `<base>/<id>/index.js` — no archive, no `.pbx` in the
 * 0.9 community repo (checked: `index.pbx` and `<id>.pbx` 404, `index.js` 320 kB, `static/icon.png`
 * 16 kB). That is why Paperback support is a JS-host job, not a packaging one.
 *
 * Paperback publishes no numeric version code, only a string, so `versionCode` is 0 and an update
 * cannot be ordered by number. The UI shows the version string; nothing pretends to compare them.
 */

import { absoluteUrl, arrayOf, contentWarningOf, isRecord, uniqueLangs } from "./index";
import type { RepoEntry, RepoIndex } from "./index";

export function parsePaperbackRepo(raw: unknown, base: string): RepoIndex {
  if (!isRecord(raw) || !Array.isArray(raw.sources)) {
    throw new Error("not a Paperback repository: expected an object with a `sources` array");
  }
  const repo = isRecord(raw.repository) ? raw.repository : {};
  const name = typeof repo.name === "string" && repo.name !== "" ? repo.name : "Paperback repository";
  const entries: RepoEntry[] = [];

  for (const item of raw.sources) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id : "";
    if (id === "") continue;
    const displayName = typeof item.name === "string" && item.name !== "" ? item.name : id;
    const langs = uniqueLangs(
      [typeof item.language === "string" ? item.language : "", ...arrayOf(item.languages).filter((l): l is string => typeof l === "string")],
    );
    const entry: RepoEntry = {
      kind: "paperback",
      id,
      name: displayName,
      version: typeof item.version === "string" ? item.version : String(item.version ?? "0"),
      versionCode: 0,
      packageUrl: absoluteUrl(`${id}/index.js`, base),
      contentWarning: contentWarningOf(item.contentRating),
      langs,
      sources: [{ id, name: displayName, lang: langs[0] ?? "" }],
    };
    if (typeof item.icon === "string") entry.iconUrl = absoluteUrl(`${id}/static/${item.icon}`, base);
    entries.push(entry);
  }

  return { kind: "paperback", name, entries };
}

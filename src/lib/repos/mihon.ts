/**
 * Mihon/Komikku indexes, projected into the neutral shape.
 *
 * The parsing itself stays where it already lives and is already tested
 * (`src/lib/extensions/index.ts`: v2 `extensionList` and the legacy bare array, plus `updateState`).
 * This file only re-shapes its entries, because `ExtensionEntry` is what the store, the install flow
 * and the Extensions screen are written against and renaming its fields would be churn for no gain.
 * One parser, one projection.
 */

import { parseIndex } from "../extensions/index";
import { absoluteUrl, contentWarningOf, uniqueLangs } from "./index";
import type { RepoEntry, RepoIndex } from "./index";

export function parseMihonRepo(raw: unknown, base: string): RepoIndex {
  const index = parseIndex(raw);
  const entries: RepoEntry[] = index.extensions.map((entry) => {
    const out: RepoEntry = {
      kind: "mihon",
      // The Android package name is the stable identity of a Mihon extension.
      id: entry.pkg,
      name: entry.name,
      version: entry.version,
      versionCode: entry.versionCode,
      packageUrl: absoluteUrl(entry.apkUrl, base),
      lib: entry.lib,
      contentWarning: contentWarningOf(entry.contentWarning),
      langs: uniqueLangs(entry.sources.map((s) => s.lang)),
      sources: entry.sources,
    };
    if (entry.iconUrl !== undefined) out.iconUrl = absoluteUrl(entry.iconUrl, base);
    if (entry.jarUrl !== undefined) out.auxUrl = absoluteUrl(entry.jarUrl, base);
    return out;
  });
  return { kind: "mihon", name: index.name, entries };
}

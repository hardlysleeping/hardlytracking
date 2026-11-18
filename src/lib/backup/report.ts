/**
 * What an import file contains, and what this device would have to do about it.
 *
 * The import screen shows this *before* anything is written, because "restore" is the one button
 * where being wrong costs a library. Two questions it has to answer, in this order:
 *
 * 1. **What is in the file?** Counts, in the reader's words — series, chapters, categories,
 *    sessions — not the fifteen collection names of the format.
 * 2. **What will not work afterwards?** A series whose extension is not installed imports as a row
 *    that cannot open, and a repository the file names is a URL the reader can add in one tap. Both
 *    are said plainly, before the confirm, and repeated after the apply.
 *
 * Nothing here writes, fetches or installs. It reads a parsed document plus this device's installed
 * extensions and repositories, and returns counts and one sentence.
 */
import type { InstalledExtension } from "../../api/dalvik";
import type { SyncDocument } from "../sync/document";
import { reattach, summarizeReattach, type MissingSource, type ReattachSummary } from "./identity";

export interface ImportSummary {
  series: number;
  chapters: number;
  categories: number;
  sessions: number;
  progress: number;
  history: number;
  mappings: number;
  repos: number;
  /** attached + missing + unknown, so the three always add up to the series count. */
  reattach: ReattachSummary;
  /** One row per source no enabled extension provides, biggest first. */
  missingSources: MissingSource[];
  /** Repository URLs the file names that this device has not added. */
  reposNotInstalled: string[];
  /** One sentence for the screen: what the file holds, and what is missing. */
  sentence: string;
}

/** A repository URL as a key: trailing slashes are not a different repository. */
export function repoKey(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "a, b and c" — the sentence reads as prose, so the last join is "and". */
function listOf(parts: readonly string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Summarise a parsed document against this device.
 *
 * `installed` is the `extensions` store; `repos` the `repos` store. Both are read, never written.
 */
export function summarizeImport(
  document: SyncDocument,
  installed: readonly InstalledExtension[],
  repos: readonly { url: string }[],
): ImportSummary {
  const attachments = reattach(document, installed);
  const summary = summarizeReattach(attachments);

  const here = new Set(repos.map((row) => repoKey(row.url)));
  const reposNotInstalled: string[] = [];
  for (const row of document.repos) {
    const key = repoKey(row.url);
    if (key === "" || here.has(key) || reposNotInstalled.includes(row.url)) continue;
    reposNotInstalled.push(row.url);
  }

  const counts: ImportSummary = {
    series: document.series.length,
    chapters: document.chapters.length,
    categories: document.categories.length,
    sessions: document.sessions.length,
    progress: document.progress.length,
    history: document.history.length,
    mappings: document.sourceMappings.length,
    repos: document.repos.length,
    reattach: summary,
    missingSources: summary.missingSources,
    reposNotInstalled,
    sentence: "",
  };
  counts.sentence = sentenceFor(counts);
  return counts;
}

/**
 * The one sentence the import screen shows.
 *
 * It never claims more than was counted: a series that is `unknown` is not called readable, and a
 * missing extension is named as the reason a series will not open.
 */
export function sentenceFor(summary: ImportSummary): string {
  const contents = listOf([
    plural(summary.series, "series", "series"),
    plural(summary.chapters, "chapter"),
    plural(summary.categories, "category", "categories"),
    plural(summary.sessions, "reading session"),
  ]);

  const parts = [`This file holds ${contents}.`];

  if (summary.missingSources.length > 0) {
    const sources = listOf(
      summary.missingSources.map((row) =>
        row.disabled
          ? `${row.sourceId} (extension switched off)`
          : row.packageName === undefined
            ? row.sourceId
            : `${row.packageName} (${row.sourceId})`,
      ),
    );
    parts.push(
      `${plural(summary.reattach.missing, "series", "series")} cannot open until ${summary.missingSources.length === 1 ? "this source is" : "these sources are"} installed: ${sources}.`,
    );
  } else if (summary.series > 0) {
    parts.push(`${plural(summary.reattach.attached, "series", "series")} already have an extension installed here.`);
  }

  if (summary.reattach.unknown > 0) {
    parts.push(
      `${plural(summary.reattach.unknown, "series", "series")} come from a host this device cannot check (a Mihon or Komga id names no extension source), so whether they open is up to that host.`,
    );
  }

  if (summary.reposNotInstalled.length > 0) {
    parts.push(`${plural(summary.reposNotInstalled.length, "repository", "repositories")} in the file ${summary.reposNotInstalled.length === 1 ? "is" : "are"} not added here.`);
  }

  return parts.join(" ");
}

/**
 * What happened after the apply: the counts that were written, and how many series can actually be
 * opened now. Separate from `sentenceFor` because "will be" and "was" are different claims.
 */
export function outcomeSentence(summary: ImportSummary, applied: { series: number; chapters: number }): string {
  const opened = summary.reattach.attached;
  const parts = [`Imported ${plural(applied.series, "series", "series")} and ${plural(applied.chapters, "chapter")}.`];
  if (summary.reattach.missing > 0) {
    parts.push(
      `${plural(opened, "series", "series")} reattached to an installed extension; ${summary.reattach.missing} need an extension you do not have.`,
    );
  } else {
    parts.push(`${plural(opened, "series", "series")} reattached to an installed extension.`);
  }
  if (summary.reattach.unknown > 0) parts.push(`${summary.reattach.unknown} could not be checked from the file.`);
  return parts.join(" ");
}

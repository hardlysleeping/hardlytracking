/**
 * Writing this device's library out in other apps' formats.
 *
 * The export side of the same seam the import uses: a document goes in, bytes come out. Three
 * formats are written here and each is verified against the app that reads it, not guessed:
 *
 * | format | what it is | verified from |
 * |---|---|---|
 * | HardlyTracking | our own JSON document | `src/lib/sync/document.ts` |
 * | Mihon `.tachibk` | protobuf, gzipped | `mihonapp/mihon` `data/backup/models/*.kt` |
 * | Aidoku `.json` | `Codable` JSON, dates as **seconds since 1970** | `Aidoku/Aidoku` `Core/Backup/Models/*.swift` |
 *
 * Two are deliberately **not** written yet, and the screen says so instead of handing over a file
 * that the other app would refuse:
 *
 * - **Suwatte** — its backup is a Realm snapshot (`storedContents`, `library`, `progressMarkers`,
 *   `runners`, …) and `LibraryEntry` decodes `content` only for `schemaVersion <= 15`; the date
 *   encoding lives in their `DaisukeEngine` package, which is not in the app's published source.
 *   A wrong date encoding is a backup that fails to import, so this waits for one real Suwatte file.
 * - **Paperback `.pas4`** — the container is not documented and the app's repository publishes no
 *   source to read it from. One real `.pas4` settles it.
 *
 * Nothing here writes to a network or touches the store: it maps rows and returns bytes.
 */

import { serializeSync } from "../sync/document";
import type { SyncDocument } from "../sync/document";
import { writeTachibk } from "./mihon";
import type { MihonBackup, MihonChapter, MihonManga } from "./mihon";

export type ExportKind = "hardlytracking" | "mihon" | "aidoku" | "suwatte" | "paperback";

export interface ExportFormat {
  kind: ExportKind;
  label: string;
  /** One line for the screen: what the file is for. */
  detail: string;
  extension: string;
  /** The button's own words. Two formats share `.json`, so the extension alone is ambiguous. */
  buttonLabel: string;
  mime: string;
  ready: boolean;
  /** Why it is not written, when it is not. Never empty for `ready: false`. */
  why?: string;
}

export const EXPORT_FORMATS: ExportFormat[] = [
  {
    kind: "hardlytracking",
    label: "HardlyTracking backup",
    detail: "Everything this app knows: library, chapters, categories, read marks, positions, history, sessions, mappings, settings.",
    extension: "json",
    buttonLabel: "Export .json",
    mime: "application/json",
    ready: true,
  },
  {
    kind: "mihon",
    label: "Mihon / Tachiyomi / Komikku",
    detail: "A .tachibk that Mihon restores: library, categories, chapters, read marks and page positions.",
    extension: "tachibk",
    buttonLabel: "Export .tachibk",
    mime: "application/octet-stream",
    ready: true,
  },
  {
    kind: "aidoku",
    label: "Aidoku",
    detail: "An Aidoku backup JSON: library entries, manga, chapters, history and categories.",
    extension: "json",
    buttonLabel: "Export Aidoku .json",
    mime: "application/json",
    ready: true,
  },
  {
    kind: "suwatte",
    label: "Suwatte",
    detail: "Not written yet.",
    extension: "json",
    buttonLabel: "Export .json",
    mime: "application/json",
    ready: false,
    why: "Suwatte's backup is a Realm snapshot and its date encoding is not in the app's published source. A wrong encoding is a backup that will not import, so this waits for one real Suwatte file to check against.",
  },
  {
    kind: "paperback",
    label: "Paperback",
    detail: "Not written yet.",
    extension: "pas4",
    buttonLabel: "Export .pas4",
    mime: "application/octet-stream",
    ready: false,
    why: "The .pas4 container is not documented and Paperback's repository publishes no source to read it from. One real .pas4 settles it.",
  },
];

export interface ExportOptions {
  /** Device id, stamped on the document we write ourselves. */
  device: string;
  at?: number;
  /** File name stem; the date and extension are added here. */
  stem?: string;
}

export interface ExportedFile {
  kind: ExportKind;
  filename: string;
  mime: string;
  bytes: Uint8Array;
}

function stamp(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function formatOf(kind: ExportKind): ExportFormat {
  const format = EXPORT_FORMATS.find((f) => f.kind === kind);
  if (format === undefined) throw new Error(`unknown export format ${kind}`);
  return format;
}

/**
 * The pieces of a series id, as the dalvik provider writes them: `dalvik:<sourceId>:<url>`.
 *
 * Anything that is not that shape is exported with its provider name as the source id and its whole
 * id as the url, which is what makes a `local:` or `archive:` title arrive in the other app as a
 * row whose source is missing rather than as a silently wrong source.
 */
export function splitSeriesId(seriesId: string): { provider: string; sourceId: string; url: string } {
  const parts = seriesId.split(":");
  if (parts.length >= 3 && parts[0] === "dalvik") {
    return { provider: parts[0], sourceId: parts[1] ?? "", url: parts.slice(2).join(":") };
  }
  const provider = parts[0] ?? "";
  return { provider, sourceId: provider, url: seriesId };
}

/** `dalvik:ch:<sourceId>:<url>` → its url; anything else keeps its own id. */
export function chapterUrlOf(chapterId: string): string {
  const parts = chapterId.split(":");
  if (parts.length >= 4 && parts[0] === "dalvik" && parts[1] === "ch") {
    return parts.slice(3).join(":");
  }
  return chapterId;
}

/** Our tracker names back to Mihon's numeric ids. */
const TRACKER_IDS: Record<string, number> = {
  myanimelist: 1,
  anilist: 2,
  kitsu: 3,
  shikimori: 4,
  bangumi: 5,
  mangaupdates: 6,
  mangadex: 7,
};

function trackerIdOf(service: string): number {
  const named = TRACKER_IDS[service];
  if (named !== undefined) return named;
  const numeric = Number(service.replace(/^tracker:/, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * The document as a Mihon backup.
 *
 * `sourceMappings` is consulted first for the source id, because that row is what the device wrote
 * when it added the series; the id shape is the fallback. Read marks and page positions come from
 * their own collections, which is where this app keeps them — Mihon keeps them on the chapter, and
 * that is the shape written here.
 */
export function documentToMihon(doc: SyncDocument): MihonBackup {
  const sourceBySeries = new Map<string, string>();
  for (const mapping of doc.sourceMappings) {
    if (mapping.sourceId !== "") sourceBySeries.set(mapping.seriesId, mapping.sourceId);
  }
  const readAt = new Map(doc.readState.map((row) => [row.chapterId, row]));
  const progressAt = new Map(doc.progress.map((row) => [row.chapterId, row]));

  const mangas: MihonManga[] = doc.series.map((series) => {
    const parts = splitSeriesId(series.id);
    const source = sourceBySeries.get(series.id) ?? parts.sourceId;
    const chapters: MihonChapter[] = doc.chapters
      .filter((chapter) => chapter.seriesId === series.id)
      .map((chapter) => {
        const progress = progressAt.get(chapter.id);
        return {
          url: chapterUrlOf(chapter.id),
          name: chapter.name,
          read: readAt.get(chapter.id)?.read === true,
          bookmark: false,
          lastPageRead: progress?.page ?? 0,
          dateFetch: chapter.at,
          dateUpload: chapter.uploadedAt ?? 0,
          chapterNumber: chapter.number,
          sourceOrder: 0,
        };
      });
    const history = doc.history
      .filter((row) => row.seriesId === series.id)
      .map((row) => ({ url: chapterUrlOf(row.chapterId), lastRead: row.at, readDuration: 0 }));
    const tracking = doc.trackers
      .filter((row) => row.seriesId === series.id)
      .map((row) => ({
        syncId: trackerIdOf(row.service),
        remoteId: row.remoteId,
        title: series.title,
        lastChapterRead: 0,
        score: 0,
        status: 0,
      }));
    const manga: MihonManga = {
      source,
      url: parts.url,
      title: series.title,
      genre: [],
      status: 0,
      dateAdded: series.at,
      chapters,
      categories: series.categoryIds
        .map((id) => id.replace(/^c:/, ""))
        .filter((id) => id !== ""),
      tracking,
      favorite: true,
      history,
    };
    if (series.author !== undefined) manga.author = series.author;
    if (series.description !== undefined) manga.description = series.description;
    if (series.cover !== undefined) manga.thumbnailUrl = series.cover;
    return manga;
  });

  const categories = doc.categories.map((category, index) => ({
    id: category.id.replace(/^c:/, ""),
    name: category.name,
    order: category.order ?? index,
  }));

  // One source row per distinct source, named by whatever the document knows.
  const seen = new Set<string>();
  const sources: { sourceId: string; name: string }[] = [];
  for (const manga of mangas) {
    if (seen.has(manga.source)) continue;
    seen.add(manga.source);
    sources.push({ sourceId: manga.source, name: manga.source });
  }

  return {
    gzipped: true,
    preferenceKeys: [],
    mangas,
    categories,
    sources,
    stores: doc.repos.map((repo) => ({ indexUrl: repo.indexUrl || repo.url, name: repo.name })),
  };
}

/** Aidoku's content status enum: 0 unknown, 1 ongoing, 2 completed, 3 hiatus, 4 cancelled. */
function aidokuStatus(status: string | undefined): number {
  const word = (status ?? "").toLowerCase();
  if (word.includes("ongoing") || word.includes("publishing")) return 1;
  if (word.includes("complete")) return 2;
  if (word.includes("hiatus") || word.includes("on hold")) return 3;
  if (word.includes("cancel") || word.includes("discontinued")) return 4;
  return 0;
}

export interface AidokuBackup {
  library: {
    mangaId: string;
    sourceId: string;
    dateAdded: number;
    lastOpened: number;
    lastUpdated: number;
    lastRead?: number;
    categories?: string[];
  }[];
  manga: {
    id: string;
    sourceId: string;
    title: string;
    author?: string;
    artist?: string;
    desc?: string;
    tags?: string[];
    cover?: string;
    url?: string;
    status: number;
    nsfw: number;
    viewer: number;
  }[];
  chapters: {
    sourceId: string;
    mangaId: string;
    id: string;
    title?: string;
    chapter?: number;
    sourceOrder: number;
    lang: string;
  }[];
  history: {
    dateRead: number;
    sourceId: string;
    chapterId: string;
    mangaId: string;
    progress?: number;
    total?: number;
    completed: boolean;
  }[];
  categories: string[];
  sources: string[];
  sourceLists: string[];
  settings: Record<string, unknown>;
  date: number;
  name: string;
  automatic: boolean;
  version: string;
}

/**
 * The document as an Aidoku backup.
 *
 * Aidoku decodes dates with `.secondsSince1970` (`Core/Backup/Models/Backup.swift`), so every date
 * here is seconds, not milliseconds — the one place this format differs from ours and the easiest
 * thing to get wrong.
 */
export function documentToAidoku(doc: SyncDocument, at: number): AidokuBackup {
  const seconds = (ms: number): number => Math.round(ms / 1000);
  const sourceBySeries = new Map<string, string>();
  for (const mapping of doc.sourceMappings) {
    if (mapping.sourceId !== "") sourceBySeries.set(mapping.seriesId, mapping.sourceId);
  }
  const categoryName = new Map(doc.categories.map((c) => [c.id, c.name]));
  const readIds = new Set(doc.readState.filter((row) => row.read).map((row) => row.chapterId));
  const progressAt = new Map(doc.progress.map((row) => [row.chapterId, row]));
  const lastReadAt = new Map<string, number>();
  for (const row of doc.history) {
    const current = lastReadAt.get(row.seriesId) ?? 0;
    if (row.at > current) lastReadAt.set(row.seriesId, row.at);
  }

  const backup: AidokuBackup = {
    library: [],
    manga: [],
    chapters: [],
    history: [],
    categories: doc.categories.map((category) => category.name),
    sources: [],
    sourceLists: doc.repos.map((repo) => repo.url),
    settings: {},
    date: seconds(at),
    name: `HardlyTracking ${stamp(at)}`,
    automatic: false,
    version: "1",
  };

  const sources = new Set<string>();
  for (const series of doc.series) {
    const parts = splitSeriesId(series.id);
    const sourceId = sourceBySeries.get(series.id) ?? parts.sourceId;
    sources.add(sourceId);
    const entry: AidokuBackup["library"][number] = {
      mangaId: parts.url,
      sourceId,
      dateAdded: seconds(series.at),
      lastOpened: seconds(series.at),
      lastUpdated: seconds(series.at),
    };
    const lastRead = lastReadAt.get(series.id);
    if (lastRead !== undefined) entry.lastRead = seconds(lastRead);
    const names = series.categoryIds
      .map((id) => categoryName.get(id))
      .filter((name): name is string => typeof name === "string" && name !== "");
    if (names.length > 0) entry.categories = names;
    backup.library.push(entry);

    const manga: AidokuBackup["manga"][number] = {
      id: parts.url,
      sourceId,
      title: series.title,
      status: aidokuStatus(series.status),
      nsfw: 0,
      viewer: 0,
    };
    if (series.author !== undefined) manga.author = series.author;
    if (series.description !== undefined) manga.desc = series.description;
    if (series.cover !== undefined) manga.cover = series.cover;
    backup.manga.push(manga);

    for (const chapter of doc.chapters.filter((row) => row.seriesId === series.id)) {
      const row: AidokuBackup["chapters"][number] = {
        sourceId,
        mangaId: parts.url,
        id: chapterUrlOf(chapter.id),
        sourceOrder: 0,
        lang: "en",
      };
      if (chapter.name !== "") row.title = chapter.name;
      if (Number.isFinite(chapter.number) && chapter.number > 0) row.chapter = chapter.number;
      backup.chapters.push(row);

      if (readIds.has(chapter.id) || progressAt.has(chapter.id)) {
        const progress = progressAt.get(chapter.id);
        const historyRow: AidokuBackup["history"][number] = {
          dateRead: seconds(progress?.at ?? chapter.at),
          sourceId,
          chapterId: chapterUrlOf(chapter.id),
          mangaId: parts.url,
          completed: readIds.has(chapter.id),
        };
        if (progress !== undefined) {
          historyRow.progress = progress.page;
          if (progress.total > 0) historyRow.total = progress.total;
        }
        backup.history.push(historyRow);
      }
    }
  }
  backup.sources = [...sources];
  return backup;
}

/** Map and serialise. Throws for a format this build does not write, with the reason. */
export async function exportDocument(doc: SyncDocument, kind: ExportKind, options: ExportOptions): Promise<ExportedFile> {
  const format = formatOf(kind);
  const at = options.at ?? Date.now();
  const stem = options.stem ?? "hardlytracking";
  if (!format.ready) {
    throw new Error(`${format.label} export is not written yet — ${format.why ?? "no reason recorded"}`);
  }
  switch (kind) {
    case "hardlytracking": {
      const text = serializeSync(doc);
      return {
        kind,
        filename: `${stem}-${stamp(at)}.json`,
        mime: format.mime,
        bytes: new TextEncoder().encode(text),
      };
    }
    case "mihon": {
      const bytes = await writeTachibk(documentToMihon(doc), { gzip: true });
      return { kind, filename: `${stem}-${stamp(at)}.tachibk`, mime: format.mime, bytes };
    }
    case "aidoku": {
      const json = JSON.stringify(documentToAidoku(doc, at), null, 2);
      return {
        kind,
        filename: `${stem}-${stamp(at)}-aidoku.json`,
        mime: format.mime,
        bytes: new TextEncoder().encode(json),
      };
    }
    default:
      throw new Error(`${format.label} export is not written yet — ${format.why ?? "no reason recorded"}`);
  }
}

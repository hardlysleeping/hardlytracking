/**
 * Mihon / Tachiyomi / Komikku backups (`.tachibk`).
 *
 * A `.tachibk` is a protobuf `Backup` message, gzipped or not — `BackupDecoder.read()` sniffs
 * `0x1f8b` and wraps the stream in gzip, and refuses a JSON file with a message saying so. Field
 * numbers are read from `mihonapp/mihon` `data/backup/models/*.kt`, not guessed:
 *
 * ```
 * Backup            1 backupManga, 2 backupCategories, 101 backupSources,
 *                   104 backupPreferences, 105 backupSourcePreferences, 106 backupExtensionStores
 * BackupManga       1 source(int64) 2 url 3 title 4 artist 5 author 6 description 7 genre[]
 *                   8 status 9 thumbnailUrl 13 dateAdded 16 chapters 17 categories[] 18 tracking
 *                   100 favorite 101 chapterFlags 104 history 105 updateStrategy
 *                   107 favoriteModifiedAt 108 excludedScanlators[] 110 notes 111 initialized
 * BackupChapter     1 url 2 name 3 scanlator 4 read 5 bookmark 6 lastPageRead 7 dateFetch
 *                   8 dateUpload 9 chapterNumber(float) 10 sourceOrder 13 memo
 * BackupHistory     1 url 2 lastRead 3 readDuration
 * BackupCategory    1 name 2 order 3 id 100 flags
 * BackupSource      1 name 2 sourceId(int64)
 * BackupTracking    1 syncId 2 libraryId 3 mediaIdInt 4 trackingUrl 5 title 6 lastChapterRead(float)
 *                   7 totalChapters 8 score(float) 9 status 10 startedReadingDate 11 finishedReadingDate
 *                   12 private 100 mediaId(int64)
 * BackupExtensionStore 1 indexUrl 2 name 3 badgeLabel 4 contactWebsite 5 signingKey 6 contactDiscord
 *                   7 isLegacy 8 extensionListUrl
 * ```
 *
 * **Reading is exact about ids.** `source` is an int64 and a real source id is 19 digits, past
 * `Number.MAX_SAFE_INTEGER`; it is read as a `BigInt` and kept as a decimal string. That string is
 * what a series id, a chapter id and a source mapping are built from, so rounding it would produce
 * a library that cannot find its own source.
 *
 * **Nothing here trusts a backup to be well-formed.** A truncated file throws; a field with the
 * wrong wire type is skipped rather than read as garbage; an entry without a url is dropped.
 */

import { emptyDocument } from "../sync/document";
import type { SyncDocument } from "../sync/document";
import {
  ProtoError,
  bytesToString,
  concat,
  fieldBool,
  fieldFloat,
  fieldMessage,
  fieldString,
  fieldVarint,
  fixed32ToFloat,
  group,
  readFields,
  varintToNumber,
  varintToString,
} from "./proto";
import type { ProtoField } from "./proto";

export interface MihonChapter {
  url: string;
  name: string;
  scanlator?: string;
  read: boolean;
  bookmark: boolean;
  lastPageRead: number;
  dateFetch: number;
  dateUpload: number;
  chapterNumber: number;
  sourceOrder: number;
}

export interface MihonHistory {
  url: string;
  lastRead: number;
  readDuration: number;
}

export interface MihonTracking {
  syncId: number;
  remoteId: string;
  title: string;
  lastChapterRead: number;
  score: number;
  status: number;
}

export interface MihonManga {
  /** The source Long, as an exact decimal string. */
  source: string;
  url: string;
  title: string;
  artist?: string;
  author?: string;
  description?: string;
  genre: string[];
  status: number;
  thumbnailUrl?: string;
  dateAdded: number;
  chapters: MihonChapter[];
  /** Category ids, as strings. */
  categories: string[];
  tracking: MihonTracking[];
  favorite: boolean;
  history: MihonHistory[];
  notes?: string;
}

export interface MihonCategory {
  id: string;
  name: string;
  order: number;
}

export interface MihonSource {
  sourceId: string;
  name: string;
}

export interface MihonExtensionStore {
  indexUrl: string;
  name: string;
}

export interface MihonBackup {
  mangas: MihonManga[];
  categories: MihonCategory[];
  sources: MihonSource[];
  stores: MihonExtensionStore[];
  /** Global preferences, read but deliberately not applied — another app's settings are not ours. */
  preferenceKeys: string[];
  /** True when the file was gzipped, so a re-export can round-trip the same container. */
  gzipped: boolean;
}

export function isGzipped(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Gunzip with the platform's own decompressor; no dependency ships for this. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function str(fields: ProtoField[], no: number): string | undefined {
  const field = fields.find((f) => f.no === no);
  if (field === undefined || field.wire !== 2) return undefined;
  return bytesToString(field.value);
}

function strAll(fields: ProtoField[], no: number): string[] {
  return fields.filter((f) => f.no === no && f.wire === 2).map((f) => bytesToString(f.value));
}

function num(fields: ProtoField[], no: number): number | undefined {
  const field = fields.find((f) => f.no === no);
  if (field === undefined || field.wire !== 0) return undefined;
  return varintToNumber(field.value);
}

function big(fields: ProtoField[], no: number): string | undefined {
  const field = fields.find((f) => f.no === no);
  if (field === undefined || field.wire !== 0) return undefined;
  return varintToString(field.value);
}

function bool(fields: ProtoField[], no: number): boolean {
  return (num(fields, no) ?? 0) !== 0;
}

function float(fields: ProtoField[], no: number): number {
  const field = fields.find((f) => f.no === no);
  if (field === undefined) return 0;
  if (field.wire === 5) return fixed32ToFloat(field.value);
  if (field.wire === 0) return varintToNumber(field.value);
  return 0;
}

function messages(fields: ProtoField[], no: number): ProtoField[][] {
  return fields.filter((f) => f.no === no && f.wire === 2).map((f) => readFields(f.value as Uint8Array));
}

function chapterOf(fields: ProtoField[]): MihonChapter | null {
  const url = str(fields, 1);
  if (url === undefined || url === "") return null;
  const chapter: MihonChapter = {
    url,
    name: str(fields, 2) ?? "",
    read: bool(fields, 4),
    bookmark: bool(fields, 5),
    lastPageRead: num(fields, 6) ?? 0,
    dateFetch: num(fields, 7) ?? 0,
    dateUpload: num(fields, 8) ?? 0,
    chapterNumber: float(fields, 9),
    sourceOrder: num(fields, 10) ?? 0,
  };
  const scanlator = str(fields, 3);
  if (scanlator !== undefined && scanlator !== "") chapter.scanlator = scanlator;
  return chapter;
}

function mangaOf(fields: ProtoField[]): MihonManga | null {
  const url = str(fields, 2);
  const source = big(fields, 1);
  if (url === undefined || url === "" || source === undefined) return null;
  const manga: MihonManga = {
    source,
    url,
    title: str(fields, 3) ?? url,
    genre: strAll(fields, 7),
    status: num(fields, 8) ?? 0,
    dateAdded: num(fields, 13) ?? 0,
    chapters: messages(fields, 16)
      .map(chapterOf)
      .filter((c): c is MihonChapter => c !== null),
    categories: fields
      .filter((f) => f.no === 17 && f.wire === 0)
      .map((f) => varintToString(f.value)),
    tracking: messages(fields, 18).map((t) => ({
      syncId: num(t, 1) ?? 0,
      remoteId: big(t, 100) ?? String(num(t, 3) ?? 0),
      title: str(t, 5) ?? "",
      lastChapterRead: float(t, 6),
      score: float(t, 8),
      status: num(t, 9) ?? 0,
    })),
    favorite: fields.some((f) => f.no === 100) ? bool(fields, 100) : true,
    history: messages(fields, 104).map((h) => ({
      url: str(h, 1) ?? "",
      lastRead: num(h, 2) ?? 0,
      readDuration: num(h, 3) ?? 0,
    })),
  };
  const artist = str(fields, 4);
  if (artist !== undefined && artist !== "") manga.artist = artist;
  const author = str(fields, 5);
  if (author !== undefined && author !== "") manga.author = author;
  const description = str(fields, 6);
  if (description !== undefined && description !== "") manga.description = description;
  const cover = str(fields, 9);
  if (cover !== undefined && cover !== "") manga.thumbnailUrl = cover;
  const notes = str(fields, 110);
  if (notes !== undefined && notes !== "") manga.notes = notes;
  return manga;
}

/**
 * Read a `.tachibk`.
 *
 * The whole file is decoded in one pass rather than streamed entry-by-entry like Mihon does: a
 * phone-side import of a library in the low thousands is a few megabytes, and one pass keeps the
 * code readable. If a real backup turns out big enough to matter, the walk in `readFields` is
 * already field-oriented, so a streaming version replaces `decode` without touching the mapping.
 */
export async function readTachibk(bytes: Uint8Array): Promise<MihonBackup> {
  const gzipped = isGzipped(bytes);
  const raw = gzipped ? await gunzip(bytes) : bytes;
  if (raw.length > 0 && raw[0] === 0x7b) {
    // `{` — Mihon itself refuses this with "invalid backup file (json)". Say the same thing.
    throw new ProtoError("this is a JSON backup, which Mihon does not read either; import it as JSON");
  }
  const top = readFields(raw);
  const mangas = messages(top, 1)
    .map(mangaOf)
    .filter((m): m is MihonManga => m !== null);
  const categories: MihonCategory[] = messages(top, 2)
    .map((c) => ({
      id: big(c, 3) ?? "0",
      name: str(c, 1) ?? "",
      order: num(c, 2) ?? 0,
    }))
    .filter((c) => c.name !== "");
  const sources: MihonSource[] = messages(top, 101).map((s) => ({
    sourceId: big(s, 2) ?? "0",
    name: str(s, 1) ?? "",
  }));
  const stores: MihonExtensionStore[] = messages(top, 106)
    .map((s) => ({ indexUrl: str(s, 1) ?? "", name: str(s, 2) ?? "" }))
    .filter((s) => s.indexUrl !== "");
  const preferenceKeys = messages(top, 104)
    .map((p) => str(p, 1) ?? "")
    .filter((k) => k !== "");
  return { mangas, categories, sources, stores, preferenceKeys, gzipped };
}

/**
 * Mihon's tracker ids, which is all a backup carries (`syncId` is an int, not a name).
 * 1 MAL, 2 AniList, 3 Kitsu, 4 Shikimori, 5 Bangumi, 6 MangaUpdates, 7 MangaDex, 8 Hikka, 9 Trakt,
 * 10 MyAnimeList (new), 11 AniList (new). An unknown id becomes `tracker:<n>` rather than a guess.
 */
const TRACKERS: Record<number, string> = {
  1: "myanimelist",
  2: "anilist",
  3: "kitsu",
  4: "shikimori",
  5: "bangumi",
  6: "mangaupdates",
  7: "mangadex",
};

export function trackerName(syncId: number): string {
  return TRACKERS[syncId] ?? `tracker:${syncId}`;
}

export interface ImportOptions {
  /** Device id stamped on every row, so a merge can tell this import from another device's rows. */
  device: string;
  /** Stamped `at` for rows that carry no timestamp of their own. */
  at?: number;
}

/**
 * The series id a Mihon manga becomes.
 *
 * `dalvik:<sourceId>:<url>` is the shape `src/api/dalvik.ts` already writes, so an imported library
 * lands on exactly the ids the extension host would produce for the same title — which is what makes
 * "import, then install the extension, then read" work without a remap step.
 */
export function seriesIdOf(manga: { source: string; url: string }): string {
  return `dalvik:${manga.source}:${manga.url}`;
}

export function chapterIdOf(manga: { source: string }, chapterUrl: string): string {
  return `dalvik:ch:${manga.source}:${chapterUrl}`;
}

/**
 * A `.tachibk` as the app's own document.
 *
 * What is carried: series, chapters, categories, read state, resume points, history and tracker
 * mappings — the things the app can honour. What is deliberately not carried: Mihon's global
 * preferences (another app's settings), its extension *preferences* (an APK's own keys mean nothing
 * until that APK is installed), and its `memo` blobs (a JSON object per chapter that only Mihon
 * reads). The source list and extension stores do travel, because an import that cannot say which
 * repository a series needs is an import that leaves the reader hunting.
 */
export function toDocument(backup: MihonBackup, options: ImportOptions): SyncDocument {
  const at = options.at ?? Date.now();
  const device = options.device;
  const doc = emptyDocument(device, at);
  /** The resume point per series, decided while walking the chapters and written after them. */
  const resume = new Map<string, { chapterId: string; page: number; at: number }>();

  for (const category of backup.categories) {
    doc.categories.push({
      // `c:<n>` is the reversible mapping the collections module already uses for Mihon ids.
      id: `c:${category.id}`,
      name: category.name,
      order: category.order,
      hidden: false,
      pinned: false,
      at,
      device,
    });
  }

  for (const manga of backup.mangas) {
    const seriesId = seriesIdOf(manga);
    const categoryIds = manga.categories.map((id) => `c:${id}`);
    doc.series.push({
      id: seriesId,
      provider: "dalvik",
      title: manga.title,
      categoryIds,
      at: manga.dateAdded > 0 ? manga.dateAdded : at,
      device,
      ...(manga.thumbnailUrl !== undefined ? { cover: manga.thumbnailUrl } : {}),
      ...(manga.author !== undefined ? { author: manga.author } : {}),
      ...(manga.description !== undefined ? { description: manga.description } : {}),
    });

    // The source a series came from, in the terms a reinstall needs.
    doc.sourceMappings.push({
      seriesId,
      provider: "dalvik",
      sourceId: manga.source,
      at,
      device,
    });

    for (const chapter of manga.chapters) {
      const chapterId = chapterIdOf(manga, chapter.url);
      doc.chapters.push({
        id: chapterId,
        seriesId,
        name: chapter.name,
        number: Number.isFinite(chapter.chapterNumber) ? chapter.chapterNumber : 0,
        // Mihon does not store a page count; 0 means "unknown", never "empty".
        pageCount: 0,
        at: chapter.dateFetch > 0 ? chapter.dateFetch : at,
        device,
        ...(chapter.dateUpload > 0 ? { uploadedAt: chapter.dateUpload } : {}),
      });
      if (chapter.read) {
        doc.readState.push({ chapterId, read: true, at: at, device });
      }
      if (chapter.lastPageRead > 0) {
        doc.progress.push({ chapterId, seriesId, page: chapter.lastPageRead, total: 0, at, device });
        // Continue Reading reads `positions`, one row per series, so the resume point has to be a
        // position as well as a progress row — a progress row alone leaves the strip empty. The
        // newest chapter with a resume point wins, because that is where the reader actually was.
        const stamp = chapter.dateFetch > 0 ? chapter.dateFetch : at;
        const best = resume.get(seriesId);
        if (best === undefined || stamp >= best.at) {
          resume.set(seriesId, { chapterId, page: chapter.lastPageRead, at: stamp });
        }
      }
    }

    for (const entry of manga.history) {
      if (entry.url === "") continue;
      doc.history.push({
        seriesId,
        chapterId: chapterIdOf(manga, entry.url),
        at: entry.lastRead > 0 ? entry.lastRead : at,
        device,
      });
    }

    for (const track of manga.tracking) {
      doc.trackers.push({
        seriesId,
        service: trackerName(track.syncId),
        remoteId: track.remoteId,
        at,
        device,
      });
    }
  }

  // History is newest-first in the app; a backup's order is not meaningful.
  doc.history.sort((a, b) => b.at - a.at);

  for (const [seriesId, best] of resume) {
    doc.positions.push({ seriesId, chapterId: best.chapterId, page: best.page, at: best.at, device });
  }

  for (const store of backup.stores) {
    doc.repos.push({ url: store.indexUrl, indexUrl: store.indexUrl, name: store.name, at, device });
  }

  return doc;
}

export { group };

// ---------------------------------------------------------------------------------------------------
// Writing a `.tachibk` back out.
// ---------------------------------------------------------------------------------------------------

/** Gzip with the platform's own compressor. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chapterBody(chapter: MihonChapter): Uint8Array {
  const parts: Uint8Array[] = [
    fieldString(1, chapter.url),
    fieldString(2, chapter.name),
    fieldBool(4, chapter.read),
    fieldBool(5, chapter.bookmark),
    fieldVarint(6, chapter.lastPageRead),
    fieldVarint(7, chapter.dateFetch),
    fieldVarint(8, chapter.dateUpload),
    fieldFloat(9, chapter.chapterNumber),
    fieldVarint(10, chapter.sourceOrder),
  ];
  if (chapter.scanlator !== undefined) parts.push(fieldString(3, chapter.scanlator));
  return concat(parts);
}

function mangaBody(manga: MihonManga): Uint8Array {
  const parts: Uint8Array[] = [
    // The source id is written from its exact decimal string, never via a float.
    fieldVarint(1, BigInt(manga.source)),
    fieldString(2, manga.url),
    fieldString(3, manga.title),
    fieldVarint(8, manga.status),
    fieldVarint(13, manga.dateAdded),
    fieldBool(100, manga.favorite),
    ...manga.genre.map((g) => fieldString(7, g)),
    ...manga.categories.map((id) => fieldVarint(17, BigInt(id))),
    ...manga.chapters.map((chapter) => fieldMessage(16, chapterBody(chapter))),
    ...manga.history.map((entry) =>
      fieldMessage(104, concat([fieldString(1, entry.url), fieldVarint(2, entry.lastRead), fieldVarint(3, entry.readDuration)])),
    ),
    ...manga.tracking.map((track) =>
      fieldMessage(
        18,
        concat([
          fieldVarint(1, track.syncId),
          fieldString(5, track.title),
          fieldFloat(6, track.lastChapterRead),
          fieldFloat(8, track.score),
          fieldVarint(9, track.status),
          fieldVarint(100, BigInt(track.remoteId)),
        ]),
      ),
    ),
  ];
  if (manga.artist !== undefined) parts.push(fieldString(4, manga.artist));
  if (manga.author !== undefined) parts.push(fieldString(5, manga.author));
  if (manga.description !== undefined) parts.push(fieldString(6, manga.description));
  if (manga.thumbnailUrl !== undefined) parts.push(fieldString(9, manga.thumbnailUrl));
  if (manga.notes !== undefined) parts.push(fieldString(110, manga.notes));
  return concat(parts);
}

/**
 * Write a `.tachibk` that Mihon can read back.
 *
 * Gzipped by default because that is what Mihon produces; `gzip: false` writes the bare protobuf,
 * which Mihon also accepts. The reader keeps what it read (`backup.gzipped`) so a round-trip through
 * this app returns the same container it was handed.
 */
export async function writeTachibk(backup: MihonBackup, options: { gzip?: boolean } = {}): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (const manga of backup.mangas) parts.push(fieldMessage(1, mangaBody(manga)));
  for (const category of backup.categories) {
    parts.push(
      fieldMessage(
        2,
        concat([fieldString(1, category.name), fieldVarint(2, category.order), fieldVarint(3, BigInt(category.id))]),
      ),
    );
  }
  for (const source of backup.sources) {
    parts.push(fieldMessage(101, concat([fieldString(1, source.name), fieldVarint(2, BigInt(source.sourceId))])));
  }
  for (const store of backup.stores) {
    parts.push(fieldMessage(106, concat([fieldString(1, store.indexUrl), fieldString(2, store.name)])));
  }
  const raw = concat(parts);
  const shouldGzip = options.gzip ?? backup.gzipped;
  return shouldGzip ? await gzip(raw) : raw;
}

import type { Chapter, Series } from "../api/source";
import type { HistoryRow, LibraryStore, ProgressRow, SessionRow, SourceMappingRow } from "./db/store";
import type { Category } from "./categories";
import { contextOf, isHidden, sourceKeyOf, type SourceMark } from "./marks";
import { isComplete } from "./history";

/** Persisted snapshot only: never contacts a provider or writes a library. */
export interface ReadingStatsData {
  series: Series[];
  chapters: Chapter[];
  progress: ProgressRow[];
  prefs: Array<{ key: string; value: unknown }>;
  history: HistoryRow[];
  sessions: SessionRow[];
  mappings: SourceMappingRow[];
}

export async function loadReadingStats(store: LibraryStore): Promise<ReadingStatsData> {
  const [series, chapters, progress, prefs, history, sessions, mappings] = await Promise.all([
    store.listSeries(), store.listAllChapters(), store.listProgress(), store.listPrefs(),
    store.listHistory(Infinity), store.listSessions(Infinity), store.listMappings(),
  ]);
  return { series, chapters, progress, prefs, history, sessions, mappings };
}

export interface ReadingStats {
  readIssues: number;
  inProgressIssues: number;
  startedSeries: number;
  seriesWithReads: number;
  caughtUpSeries: number;
  /** Sum of current saved positions, NOT unique pages read or a lifetime total. */
  savedPages: number;
  knownProgressPages: number;
  progressIssues: number;
  closedSessions: number;
  openSessions: number;
  unmeasuredSessions: number;
  recordedSeconds: number;
  /** Stored session endpoint spans, NOT observed page turns. Includes rereads. */
  sessionPageSpans: number;
  hasActivity: boolean;
  days: Array<{ day: string; sessions: number; seconds: number; pageSpans: number; lastOpenedIssues: number }>;
  recent: Array<{ seriesId: string; chapterId: string; title: string; chapterName: string; at: number }>;
}

const validTime = (value: number): boolean => Number.isFinite(value) && value > 0;
const count = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
/** Calendar date in the viewer's timezone (including DST); no rolling 24-hour buckets. */
function localDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Explicit true/false marks override cached provider state and sticky completion. */
export function aggregateReadingStats(
  data: ReadingStatsData,
  visibility: { categories: Category[]; sources: SourceMark[] },
): ReadingStats {
  const series = new Map(data.series.map((row) => [row.id, row]));
  const mappings = new Map(data.mappings.map((row) => [row.seriesId, row]));
  const context = contextOf({ ...visibility, sourceOf: (id) => sourceKeyOf(id, mappings.get(id)) });
  const visible = (id: string): boolean => !isHidden(series.get(id) ?? { id }, context);
  const chapters = new Map(data.chapters.map((row) => [row.id, row]));
  const history = new Map(data.history.map((row) => [row.chapterId, row]));
  const sessions = new Map(data.sessions.map((row) => [row.id, row]));
  const progress = new Map<string, ProgressRow>();
  for (const row of data.progress) {
    if (!progress.has(row.chapterId) || row.at >= progress.get(row.chapterId)!.at) progress.set(row.chapterId, row);
  }
  const marks = new Map<string, boolean>();
  for (const row of data.prefs) {
    if (row.key.startsWith("read:") && typeof row.value === "boolean") marks.set(row.key.slice(5), row.value);
  }
  // Old/imported progress can lack a chapter mirror. Attribute from persisted evidence, never guess
  // a series from a chapter id (that would bypass source/category privacy).
  const owner = new Map<string, string>();
  for (const row of sessions.values()) owner.set(row.chapterId, row.seriesId);
  for (const row of history.values()) owner.set(row.chapterId, row.seriesId);
  for (const row of chapters.values()) owner.set(row.id, row.seriesId);
  const result: ReadingStats = {
    readIssues: 0, inProgressIssues: 0, startedSeries: 0, seriesWithReads: 0, caughtUpSeries: 0,
    savedPages: 0, knownProgressPages: 0, progressIssues: 0, closedSessions: 0, openSessions: 0,
    unmeasuredSessions: 0, recordedSeconds: 0, sessionPageSpans: 0, hasActivity: false, days: [], recent: [],
  };
  const started = new Set<string>();
  const withReads = new Set<string>();
  const reads = new Set<string>();
  const ids = new Set([...chapters.keys(), ...progress.keys(), ...marks.keys()]);
  for (const id of ids) {
    const seriesId = owner.get(id);
    if (seriesId === undefined || !visible(seriesId)) continue;
    const p = progress.get(id);
    const read = marks.get(id) ?? (isComplete(p) || chapters.get(id)?.read === true);
    if (read) { reads.add(id); withReads.add(seriesId); started.add(seriesId); }
    if (p !== undefined && Number.isFinite(p.page) && p.page >= 0) {
      if (p.page > 0) { started.add(seriesId); if (!read) result.inProgressIssues++; }
      // A mark-read is not evidence of pages viewed. Only actual saved progress contributes.
      if (count(p.total) > 0) {
        result.progressIssues++;
        result.savedPages += Math.min(count(p.page) + 1, count(p.total));
        result.knownProgressPages += count(p.total);
      }
    }
  }
  const knownBySeries = new Map<string, Chapter[]>();
  for (const chapter of chapters.values()) {
    if (!visible(chapter.seriesId)) continue;
    const list = knownBySeries.get(chapter.seriesId) ?? [];
    list.push(chapter); knownBySeries.set(chapter.seriesId, list);
  }
  for (const list of knownBySeries.values()) if (list.length > 0 && list.every((row) => reads.has(row.id))) result.caughtUpSeries++;
  const days = new Map<string, ReadingStats["days"][number]>();
  const dayOf = (at: number) => {
    const day = localDay(at);
    if (!days.has(day)) days.set(day, { day, sessions: 0, seconds: 0, pageSpans: 0, lastOpenedIssues: 0 });
    return days.get(day)!;
  };
  for (const row of sessions.values()) {
    if (!visible(row.seriesId) || !validTime(row.startedAt)) continue;
    started.add(row.seriesId);
    if (row.endedAt === undefined) { result.openSessions++; continue; }
    if (!validTime(row.endedAt) || row.endedAt < row.startedAt) continue;
    result.closedSessions++;
    const day = dayOf(row.startedAt);
    day.sessions++;
    // Never extrapolate a live session, or infer activity from a wall-clock span. Old rows without
    // a measured duration remain unmeasured. Clamp malformed imports to their actual closed span.
    const measured = row.durationSeconds !== undefined && Number.isFinite(row.durationSeconds) && row.durationSeconds >= 0;
    const seconds = measured ? Math.min(row.durationSeconds!, (row.endedAt - row.startedAt) / 1000) : 0;
    if (!measured) result.unmeasuredSessions++;
    const pages = count(row.pagesRead);
    result.recordedSeconds += seconds; day.seconds += seconds;
    result.sessionPageSpans += pages; day.pageSpans += pages;
  }
  for (const row of history.values()) {
    if (!visible(row.seriesId) || !validTime(row.at)) continue;
    started.add(row.seriesId);
    dayOf(row.at).lastOpenedIssues++;
    result.recent.push({ ...row, title: series.get(row.seriesId)?.title?.trim() || "Unknown title", chapterName: chapters.get(row.chapterId)?.name?.trim() || "Issue" });
  }
  result.readIssues = reads.size;
  result.startedSeries = started.size;
  result.seriesWithReads = withReads.size;
  result.days = [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
  result.recent.sort((a, b) => b.at - a.at || a.chapterId.localeCompare(b.chapterId));
  result.hasActivity = reads.size > 0 || result.progressIssues > 0 || started.size > 0;
  return result;
}

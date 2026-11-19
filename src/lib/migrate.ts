/**
 * Moving a title to another source without losing what the reader did with it.
 *
 * A source dies, or another extension carries the same series better, and the entry would otherwise
 * be stranded: its chapters, its read marks, its history and its place all belong to the source that
 * is going away. So the entry **keeps its identity** (the library row's id, its categories, its
 * hidden/pinned marks) and its **source mapping changes**. That is the whole model, and it is why
 * nothing here deletes a title: it is a remap of one row plus a carry of the per-chapter facts.
 *
 * Two rules make the remap safe, and they are decided here, not in a view:
 *
 * 1. **Nothing moves unless every chapter the reader touched has a counterpart.** A read mark or a
 *    page position on a chapter the target does not have would be silently dropped progress, so the
 *    plan refuses by name instead. Unread chapters that exist only on the old source are reported
 *    (the confirm panel says so) and nothing is lost by leaving them behind.
 * 2. **The old mapping is kept as an alternate.** A migration is not a one-way door: the row records
 *    where the title used to live, so switching back is the same operation in the other direction.
 *
 * The functions are pure — no store, no provider — so the matching rules are testable without a
 * network and a view can render the confirm panel from the same numbers the write uses.
 */
import type { Chapter, ProviderKind } from "../api/source";

/** Where a title is being moved to, in the target provider's own terms. */
export interface MigrationTarget {
  /** The target provider kind (`dalvik`, `mihon`, `komga`, `htserver`, `archive`). */
  provider: ProviderKind;
  /** The target source's name, so the confirm panel says a name and not an id. */
  sourceName: string;
  /** The target's own source id, without a prefix — what a mapping row stores. */
  sourceId: string;
  /** The series id inside the target's id space (`dalvik:src1:https://…`, `mihon:12`). */
  seriesId: string;
  title: string;
  cover?: string;
}

/**
 * A source a title used to live on.
 *
 * `at` is when it stopped being the active mapping, so a later reader can tell the order of a
 * title's homes without a log. `remoteSeriesId` is what makes the alternate usable: the series id
 * inside that provider's id space, which is not derivable from ours.
 */
export interface AlternateMapping {
  provider: string;
  /**
   * The source id inside that provider, or `""` when it was never known — a Mihon series id names no
   * source, and an alternate that invented one would be worse than an empty field.
   */
  sourceId: string;
  remoteSeriesId: string;
  packageId?: string;
  at: number;
}

/** One old chapter and the chapter that replaces it. */
export interface ChapterPair {
  from: Chapter;
  to: Chapter;
}

export interface MigrationPlan {
  seriesId: string;
  target: { provider: string; sourceId: string; seriesId: string };
  /** Every old chapter that has a counterpart, in the order the old list had them. */
  pairs: ChapterPair[];
  /** The target's chapters, which become this title's chapter list. */
  chapters: Chapter[];
  /** Old chapters that are read — the marks that will be written on their counterparts. */
  read: string[];
  /** Old chapters with a page position — the furthest one is what the panel names. */
  progressed: ChapterPair[];
  /** Old chapters the target does not have. Unread by construction; reported, never hidden. */
  stranded: Chapter[];
}

export type MigrationRefusalReason =
  | "same-series"
  | "no-chapters"
  | "empty-target"
  | "target-shorter"
  | "unnumbered-mismatch"
  | "unmatched-progress";

export type MigrationPlanResult = { ok: true; plan: MigrationPlan } | { ok: false; reason: MigrationRefusalReason; message: string };

/** What the confirm panel needs that the chapter lists cannot say. Counted by the caller. */
export interface MigrationFacts {
  fromSource: string;
  toSource: string;
  categories: number;
  trackers: number;
  /** History rows that will be rewritten onto the new chapter ids. */
  history: number;
  /** Downloads that can keep their pages (same page count) and ones that cannot. */
  downloadsKeep: number;
  downloadsDrop: number;
}

export interface SummaryRow {
  label: string;
  value: string;
  note?: string;
}

/** A chapter number a source actually parsed, or `null` when it did not (`0` is "unparsed"). */
function numberOrNull(chapter: Chapter): number | null {
  const value = chapter.number;
  if (!Number.isFinite(value) || value <= 0) return null;
  // Two decimal places is the precision a chapter number is ever published at, and it keeps
  // `12.0000001` and `12` from being two different chapters.
  return Math.round(value * 100) / 100;
}

/** What to call a chapter in a refusal, without printing a provider id at the reader. */
function labelOf(chapter: Chapter): string {
  const name = (chapter.name ?? "").trim();
  if (name !== "" && !/^[a-z]+:/i.test(name)) return name;
  const number = numberOrNull(chapter);
  return number === null ? "a chapter" : `Chapter ${number}`;
}

/**
 * Match the old chapter list to the target's, one chapter to one chapter.
 *
 * Number first, because that is the only identity two sources share for a chapter. When **both**
 * lists are unnumbered — an archive of volumes, a source that publishes names only — the order is
 * the only signal there is, and it is used only when the counts are equal (which the caller has
 * already checked); a shorter or longer unnumbered list is refused rather than guessed at.
 *
 * A repeated number (the same chapter from two scan groups) is consumed in list order, so a source
 * that publishes `Chapter 5` twice does not send both of the old source's chapter 5s to the same row.
 */
export function alignChapters(from: Chapter[], to: Chapter[]): Map<string, Chapter> {
  const pairs = new Map<string, Chapter>();
  const numbered = from.every((chapter) => numberOrNull(chapter) !== null) && to.every((chapter) => numberOrNull(chapter) !== null);

  if (!numbered) {
    for (let index = 0; index < Math.min(from.length, to.length); index += 1) {
      pairs.set(from[index].id, to[index]);
    }
    return pairs;
  }

  const byNumber = new Map<number, Chapter[]>();
  for (const chapter of to) {
    const key = numberOrNull(chapter) as number;
    const queue = byNumber.get(key);
    if (queue === undefined) byNumber.set(key, [chapter]);
    else queue.push(chapter);
  }
  for (const chapter of from) {
    const key = numberOrNull(chapter) as number;
    const queue = byNumber.get(key);
    if (queue === undefined || queue.length === 0) continue;
    pairs.set(chapter.id, queue.shift() as Chapter);
  }
  return pairs;
}

/**
 * The plan, or the reason there is none.
 *
 * `read` and `pages` are the reader's own facts about the old chapters: a mark in the prefs store
 * and a progress row per chapter. They are the reason this function can refuse — a chapter with a
 * mark and no counterpart is the one case where migrating would quietly lose something.
 */
export function planMigration(input: {
  seriesId: string;
  target: MigrationTarget;
  /**
   * The series id the title reads from right now — its own, or the one a previous migration set.
   * Migrating *back* to the original source targets the title's own id, which is not a no-op.
   */
  currentSeriesId?: string;
  from: Chapter[];
  to: Chapter[];
  read: Set<string>;
  pages: Map<string, number>;
}): MigrationPlanResult {
  const { seriesId, target, from, to, read, pages } = input;

  if (target.seriesId === (input.currentSeriesId ?? seriesId)) {
    return { ok: false, reason: "same-series", message: "That is this title on the source it is already on — there is nothing to move." };
  }
  if (from.length === 0) {
    return {
      ok: false,
      reason: "no-chapters",
      message: "This title has no chapters on its current source yet, so there is nothing to carry over.",
    };
  }
  if (to.length === 0) {
    return { ok: false, reason: "empty-target", message: `${target.title} has no chapters on that source, so nothing was moved.` };
  }
  if (to.length < from.length) {
    return {
      ok: false,
      reason: "target-shorter",
      message: `That source has ${to.length} chapters and this title has ${from.length}. Nothing was moved.`,
    };
  }

  const numbered = from.every((chapter) => numberOrNull(chapter) !== null) && to.every((chapter) => numberOrNull(chapter) !== null);
  if (!numbered && to.length !== from.length) {
    return {
      ok: false,
      reason: "unnumbered-mismatch",
      message: `Neither list numbers its chapters, so they can only be matched in order — and that source has ${to.length} against ${from.length}. Nothing was moved.`,
    };
  }

  const aligned = alignChapters(from, to);
  const pairs: ChapterPair[] = [];
  const progressed: ChapterPair[] = [];
  const stranded: Chapter[] = [];
  const marked: string[] = [];

  for (const chapter of from) {
    const counterpart = aligned.get(chapter.id);
    if (counterpart === undefined) {
      // Unread and unopened: leaving it behind costs nothing, and the panel says it happened.
      if (read.has(chapter.id) || (pages.get(chapter.id) ?? 0) > 0) {
        return {
          ok: false,
          reason: "unmatched-progress",
          message: `${labelOf(chapter)} is read here and that source does not have it. Nothing was moved.`,
        };
      }
      stranded.push(chapter);
      continue;
    }
    pairs.push({ from: chapter, to: counterpart });
    if (read.has(chapter.id)) marked.push(chapter.id);
    if ((pages.get(chapter.id) ?? 0) > 0) progressed.push({ from: chapter, to: counterpart });
  }

  return {
    ok: true,
    plan: {
      seriesId,
      target: { provider: target.provider, sourceId: target.sourceId, seriesId: target.seriesId },
      pairs,
      chapters: to,
      read: marked,
      progressed,
      stranded,
    },
  };
}

/** The furthest chapter the reader got to, for the panel's one line about progress. */
export function furthestProgress(plan: MigrationPlan, pages: Map<string, number>): { chapter: ChapterPair; page: number } | null {
  let best: { chapter: ChapterPair; page: number } | null = null;
  for (const pair of plan.progressed) {
    const page = pages.get(pair.from.id) ?? 0;
    const number = numberOrNull(pair.to) ?? 0;
    const bestNumber = best === null ? -1 : (numberOrNull(best.chapter.to) ?? 0);
    if (best === null || number > bestNumber || (number === bestNumber && page > best.page)) {
      best = { chapter: pair, page };
    }
  }
  return best;
}

/**
 * The confirm panel, as rows.
 *
 * It states what moves and what does not, in the reader's words: the counts that follow the title
 * (categories, tracker links) are named as kept, because the whole point of the remap is that they
 * are not lost; downloads are the one thing that can be left behind, and the row says which.
 */
export function describeMigration(plan: MigrationPlan, facts: MigrationFacts, pages: Map<string, number>): SummaryRow[] {
  const rows: SummaryRow[] = [
    {
      label: "Chapters",
      value: `${plan.pairs.length + plan.stranded.length} → ${plan.chapters.length}`,
      note: `from ${facts.fromSource} to ${facts.toSource}`,
    },
    {
      label: "Read marks",
      value: plan.read.length === 0 ? "none" : `${plan.read.length} move`,
      ...(plan.read.length === 0 ? {} : { note: "onto the same chapters on the new source" }),
    },
  ];

  const furthest = furthestProgress(plan, pages);
  if (furthest !== null) {
    rows.push({
      label: "Furthest read",
      value: `${labelOf(furthest.chapter.to)}, page ${furthest.page + 1}`,
      note: "Continue Reading keeps its place",
    });
  }

  rows.push({
    label: "Reading history",
    value: facts.history === 0 ? "none" : `${facts.history} ${facts.history === 1 ? "entry" : "entries"}`,
    ...(facts.history === 0 ? {} : { note: "moves with the chapters" }),
  });
  rows.push({ label: "Categories", value: facts.categories === 0 ? "none" : `${facts.categories} kept`, note: "they belong to the title" });
  if (facts.trackers > 0) rows.push({ label: "Tracker links", value: `${facts.trackers} kept` });

  if (facts.downloadsKeep > 0 || facts.downloadsDrop > 0) {
    const parts: string[] = [];
    if (facts.downloadsKeep > 0) parts.push(`${facts.downloadsKeep} kept on this device`);
    if (facts.downloadsDrop > 0) parts.push(`${facts.downloadsDrop} removed (page count differs)`);
    rows.push({ label: "Downloads", value: parts.join(" · ") });
  }

  if (plan.stranded.length > 0) {
    rows.push({
      label: "Only on the old source",
      value: `${plan.stranded.length} ${plan.stranded.length === 1 ? "chapter" : "chapters"}`,
      note: "unread, so nothing is lost",
    });
  }

  rows.push({ label: "Old source", value: "kept as an alternate", note: "you can migrate back later" });
  return rows;
}

/**
 * The mapping a series id already implies, so a title added before migrations existed still has an
 * alternate to record. Mirrors what `recordMapping` derives, in one place.
 *
 * `mihon` ids carry no source id (`mihon:12` is a manga, not a source), so they answer `null` — a
 * mapping invented from nothing would be worse than an absent one.
 */
/**
 * A source id as a mapping row stores it.
 *
 * Extensions list sources in the app's namespaced form (`dalvik:src:123`), while a mapping records
 * the bare id (`123`) — the form `sourceKeyOfMapping` turns back into a mark key. Handing a *source*
 * id to `mappingFromId`, which reads *series* ids, answered `"src"`: a mapping that named no source,
 * so hiding the old source stopped hiding the title that had been migrated off it.
 */
export function mappingSourceId(sourceId: string): string {
  for (const kind of ["dalvik", "htserver", "mihon"]) {
    const prefix = `${kind}:`;
    if (!sourceId.startsWith(prefix)) continue;
    const native = sourceId.slice(prefix.length);
    return native.startsWith("src:") ? native.slice("src:".length) : native;
  }
  // Komga names a library (`komga:<server>:<library>`) and Archive is one source: both keep the id.
  return sourceId;
}

export function mappingFromId(seriesId: string, packageId?: string): { provider: string; sourceId: string; remoteSeriesId: string; packageId?: string } | null {
  const at = seriesId.indexOf(":");
  if (at < 1) return null;
  const provider = seriesId.slice(0, at);
  const native = seriesId.slice(at + 1);
  if (native === "") return null;
  if (provider === "dalvik" || provider === "htserver") {
    const sourceId = native.split(":")[0];
    if (sourceId === undefined || sourceId === "") return null;
    return { provider, sourceId, remoteSeriesId: seriesId, ...(packageId === undefined ? {} : { packageId }) };
  }
  if (provider === "mihon") return null;
  return { provider, sourceId: native, remoteSeriesId: seriesId, ...(packageId === undefined ? {} : { packageId }) };
}

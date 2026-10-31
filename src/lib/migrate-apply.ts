/**
 * Carrying a planned migration out, against the library database.
 *
 * `lib/migrate.ts` decides *what* moves; this file is the sequence that writes it. They are split so
 * the rules can be tested without a database and the sequence can be tested without a UI — and so
 * there is exactly one place that knows the order the writes have to happen in.
 *
 * **The mapping is written last.** Everything else is a per-chapter fact or a mirror row; if a write
 * dies half way, the title still reads from the source its mapping names and the chapter mirror is
 * refetched on the next open. Writing the mapping first would leave the entry pointing at a source
 * whose chapters were never carried.
 */
import type { LibraryStore } from "./db/store";
import type { AlternateMapping, MigrationPlan, MigrationTarget } from "./migrate";
import { mappingFromId } from "./migrate";

export interface ApplyMigrationInput {
  store: LibraryStore;
  plan: MigrationPlan;
  target: MigrationTarget;
  /** The target extension's package id, so a backup can find the extension again. */
  packageId?: string;
  /** One clock for the whole migration, so the rows agree about when it happened. */
  at?: number;
}

export interface AppliedMigration {
  chapters: number;
  read: number;
  stranded: number;
  /** Chapters that had a page position carried across. */
  pages: number;
  /** Downloads whose pages moved with the chapter, and ones that could not. */
  downloadsKept: number;
  downloadsDropped: number;
}

export async function applyMigration(input: ApplyMigrationInput): Promise<AppliedMigration> {
  const { store, plan, target } = input;
  const { seriesId } = plan;
  const now = input.at ?? Date.now();
  const pairs = new Map(plan.pairs.map((pair) => [pair.from.id, pair.to]));
  let pages = 0;
  let downloadsKept = 0;
  let downloadsDropped = 0;

  // 1. The reader's own facts, chapter by chapter: the mark and the page.
  for (const pair of plan.pairs) {
    if (plan.read.includes(pair.from.id)) {
      // Quietly: this read already happened on the old source, and announcing it would queue a push
      // for a chapter the tracker already has.
      await store.setRead(pair.to.id, true, { push: false });
      // The old id's mark is dead once its chapter is gone; a row nobody can resolve is not history.
      await store.removePref(`read:${pair.from.id}`);
    }
    const progress = await store.getProgress(pair.from.id);
    if (progress === undefined) continue;
    await store.putProgress({
      chapterId: pair.to.id,
      page: progress.page,
      total: pair.to.pageCount > 0 ? pair.to.pageCount : progress.total,
      at: progress.at,
      ...(progress.completed === true ? { completed: true } : {}),
    });
    await store.removeProgress(pair.from.id);
    pages += 1;
  }

  // 2. The bookmark. A position into a chapter that did not come across is cleared, never left
  //    pointing at a chapter this entry no longer has.
  const position = await store.getPosition(seriesId);
  if (position !== undefined) {
    const counterpart = pairs.get(position.chapterId);
    if (counterpart !== undefined) await store.setPosition(seriesId, counterpart.id, position.page, position.at);
    else await store.removePosition(seriesId);
  }

  // 3. History rows follow their chapters, keeping the time they were read. A row for a chapter the
  //    target does not have is left alone: it is a true fact about a chapter that still exists on
  //    the old source, and rewriting it onto a different chapter would be a lie.
  for (const row of (await store.listHistory(Number.POSITIVE_INFINITY)).filter((entry) => entry.seriesId === seriesId)) {
    const counterpart = pairs.get(row.chapterId);
    if (counterpart === undefined) continue;
    await store.recordHistory(seriesId, counterpart.id, row.at);
    await store.removeHistory(row.chapterId);
  }

  // 4. Downloads: pages that still describe the same chapter move with it; the rest go — and the
  //    confirm panel named that before this ran.
  for (const row of (await store.listDownloads()).filter((download) => download.seriesId === seriesId)) {
    const counterpart = pairs.get(row.chapterId);
    if (counterpart !== undefined && counterpart.pageCount === row.pages) {
      await store.rekeyDownload(row.chapterId, counterpart.id);
      downloadsKept += 1;
    } else {
      await store.removeDownload(row.chapterId);
      downloadsDropped += 1;
    }
  }

  // 5. The chapter list becomes the target's, stored under our id.
  for (const chapter of plan.stranded) await store.removeChapter(chapter.id);
  for (const pair of plan.pairs) await store.removeChapter(pair.from.id);
  await store.putChapters(seriesId, plan.chapters);

  // 6. The entry's own row: same id, same categories, the target's title and cover.
  await store.updateSeries(seriesId, {
    title: target.title,
    ...(target.cover === undefined ? {} : { cover: target.cover }),
    provider: target.provider,
  });

  // 7. The mapping, last. The old home becomes an alternate; the new one is active.
  const previous = await store.getMapping(seriesId);
  const derived = mappingFromId(seriesId);
  const active = previous ?? (derived === null ? null : { seriesId, ...derived, at: now });
  const alternates: AlternateMapping[] = [...(previous?.alternates ?? [])];
  if (active !== null) {
    alternates.push({
      provider: active.provider,
      sourceId: active.sourceId,
      remoteSeriesId: active.remoteSeriesId ?? seriesId,
      ...(active.packageId === undefined ? {} : { packageId: active.packageId }),
      at: now,
    });
  } else {
    // A `mihon:12` id names no source, and `recordMapping` never invented one for it. The old home
    // is still recorded — provider and the series id are what switching back needs — with an empty
    // source id rather than a guess.
    const provider = seriesId.slice(0, Math.max(seriesId.indexOf(":"), 0));
    if (provider !== "") alternates.push({ provider, sourceId: "", remoteSeriesId: seriesId, at: now });
  }
  await store.putMapping({
    seriesId,
    provider: target.provider,
    sourceId: target.sourceId,
    remoteSeriesId: target.seriesId,
    ...(input.packageId === undefined ? {} : { packageId: input.packageId }),
    at: now,
    ...(alternates.length === 0 ? {} : { alternates }),
  });

  return { chapters: plan.pairs.length, read: plan.read.length, stranded: plan.stranded.length, pages, downloadsKept, downloadsDropped };
}

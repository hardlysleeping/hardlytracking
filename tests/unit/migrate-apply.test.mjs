/**
 * The remap, end to end against the real store.
 *
 * The rules are tested in `migrate.test.mjs`; this is the write sequence, and what it has to prove is
 * that the entry keeps its identity: the same series id, its categories, its hidden/pinned marks, its
 * read marks now on the new chapter ids, its history still dated, its place, and an old mapping kept
 * as an alternate. It also pins the refusal: a target that cannot take the chapters changes nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import { planMigration } from "../../src/lib/migrate.ts";
import { applyMigration } from "../../src/lib/migrate-apply.ts";

const SERIES = "dalvik:1:https://old.example/manga/berserk";
const TARGET = {
  provider: "dalvik",
  sourceId: "2",
  seriesId: "dalvik:2:https://new.example/manga/berserk",
  title: "Berserk",
  sourceName: "New source",
};

const chapter = (id, seriesId, number, pageCount = 20) => ({
  id,
  seriesId,
  name: `Chapter ${number}`,
  number,
  pageCount,
  read: false,
});

/** A title with three chapters, two read, a page position, history, a bookmark and a download. */
async function seeded() {
  const store = new LibraryStore(memoryDatabase());
  await store.addSeries({
    id: SERIES,
    provider: "dalvik",
    title: "Berserk (old)",
    categoryIds: ["cat:fav"],
  });
  const from = [chapter("dalvik:ch:1:a1", SERIES, 1), chapter("dalvik:ch:1:a2", SERIES, 2), chapter("dalvik:ch:1:a3", SERIES, 3)];
  await store.putChapters(SERIES, from);
  await store.setRead("dalvik:ch:1:a1", true);
  await store.setRead("dalvik:ch:1:a2", true);
  await store.setProgress("dalvik:ch:1:a2", 4, 20, 1_700_000_000_000);
  await store.recordHistory(SERIES, "dalvik:ch:1:a1", 1_700_000_000_000);
  await store.recordHistory(SERIES, "dalvik:ch:1:a2", 1_700_000_100_000);
  await store.setPosition(SERIES, "dalvik:ch:1:a2", 4, 1_700_000_100_000);
  await store.putMapping({ seriesId: SERIES, provider: "dalvik", sourceId: "1", remoteSeriesId: SERIES, at: 1 });
  // One downloaded chapter whose page count matches the target's, one that does not.
  await store.putDownload({ chapterId: "dalvik:ch:1:a1", seriesId: SERIES, chapterName: "Chapter 1", pages: 20, bytes: 100, at: 1, total: 20 });
  await store.putDownloadPage({ id: "dalvik:ch:1:a1#0", chapterId: "dalvik:ch:1:a1", index: 0, blob: new Blob(["page"]) });
  await store.putDownload({ chapterId: "dalvik:ch:1:a2", seriesId: SERIES, chapterName: "Chapter 2", pages: 7, bytes: 40, at: 1, total: 20 });
  return { store, from };
}

const to = [
  chapter("dalvik:ch:2:b1", TARGET.seriesId, 1, 20),
  chapter("dalvik:ch:2:b2", TARGET.seriesId, 2, 20),
  chapter("dalvik:ch:2:b3", TARGET.seriesId, 3, 24),
];

test("a migration keeps the entry, and moves its marks, history, place and download", async () => {
  const { store, from } = await seeded();
  const plan = planMigration({
    seriesId: SERIES,
    target: TARGET,
    from,
    to,
    read: new Set(["dalvik:ch:1:a1", "dalvik:ch:1:a2"]),
    pages: new Map([["dalvik:ch:1:a2", 4]]),
  });
  assert.equal(plan.ok, true);
  const applied = await applyMigration({ store, plan: plan.plan, target: TARGET, at: 1_800_000_000_000 });

  // The entry is the same row: same id, same title until the target renames it, categories intact.
  const series = await store.getSeries(SERIES);
  assert.equal(series.id, SERIES);
  assert.equal(series.title, "Berserk");
  assert.deepEqual(series.categoryIds, ["cat:fav"]);
  assert.equal(await store.getSeries(TARGET.seriesId), undefined, "the target series is not a second library row");

  // Read marks are on the new chapter ids, and the old ones are gone.
  assert.equal(await store.isRead("dalvik:ch:2:b1"), true);
  assert.equal(await store.isRead("dalvik:ch:2:b2"), true);
  assert.equal(await store.isRead("dalvik:ch:2:b3"), false);
  assert.equal(await store.isRead("dalvik:ch:1:a1"), false);

  // The page position moved with its chapter, keeping the time it was written.
  const progress = await store.getProgress("dalvik:ch:2:b2");
  assert.equal(progress.page, 4);
  assert.equal(progress.at, 1_700_000_000_000);
  assert.equal(await store.getProgress("dalvik:ch:1:a2"), undefined);

  // The bookmark and the history rows follow, dated as before.
  const position = await store.getPosition(SERIES);
  assert.equal(position.chapterId, "dalvik:ch:2:b2");
  const history = await store.listHistory();
  assert.deepEqual(history.map((row) => row.chapterId).sort(), ["dalvik:ch:2:b1", "dalvik:ch:2:b2"]);
  assert.equal(history.find((row) => row.chapterId === "dalvik:ch:2:b1").at, 1_700_000_000_000);

  // The chapter list is the target's, under our id.
  const chapters = await store.listChapters(SERIES);
  assert.deepEqual(chapters.map((row) => row.id).sort(), ["dalvik:ch:2:b1", "dalvik:ch:2:b2", "dalvik:ch:2:b3"]);
  assert.equal(await store.getProgress("dalvik:ch:1:a1"), undefined, "old chapter rows are gone");

  // The download whose page count still matches moved; the one that does not was removed.
  const downloads = await store.listDownloads();
  assert.deepEqual(downloads.map((row) => row.chapterId), ["dalvik:ch:2:b1"]);
  assert.equal(downloads[0].pages, 20);
  const pages = await store.listDownloadPages("dalvik:ch:2:b1");
  assert.equal(pages.length, 1);
  assert.equal(await store.listDownloadPages("dalvik:ch:1:a1").then((rows) => rows.length), 0);
  assert.equal(applied.downloadsKept, 1);
  assert.equal(applied.downloadsDropped, 1);

  // The mapping is the remap: new source active, old source kept as an alternate.
  const mapping = await store.getMapping(SERIES);
  assert.equal(mapping.provider, "dalvik");
  assert.equal(mapping.sourceId, "2");
  assert.equal(mapping.remoteSeriesId, TARGET.seriesId);
  assert.equal(mapping.alternates.length, 1);
  assert.equal(mapping.alternates[0].sourceId, "1");
  assert.equal(mapping.alternates[0].remoteSeriesId, SERIES);
});

test("migrating back keeps both homes as alternates and returns the marks", async () => {
  const { store, from } = await seeded();
  const first = planMigration({ seriesId: SERIES, target: TARGET, from, to, read: new Set(["dalvik:ch:1:a1"]), pages: new Map() });
  await applyMigration({ store, plan: first.plan, target: TARGET, at: 1_800_000_000_000 });

  // Unread the old chapter first, so the mark that comes back can only have come from the migration.
  await store.setRead("dalvik:ch:1:a1", false);
  const back = { provider: "dalvik", sourceId: "1", seriesId: SERIES, title: "Berserk", sourceName: "Old source" };
  const second = planMigration({
    seriesId: SERIES,
    target: back,
    // The title reads from the new source right now, so its own id is a real destination again.
    currentSeriesId: TARGET.seriesId,
    from: to,
    to: from,
    read: new Set(["dalvik:ch:2:b1"]),
    pages: new Map(),
  });
  assert.equal(second.ok, true);
  await applyMigration({ store, plan: second.plan, target: back, at: 1_800_000_100_000 });

  assert.equal(await store.isRead("dalvik:ch:1:a1"), true, "the mark came back with the chapter");
  const mapping = await store.getMapping(SERIES);
  assert.equal(mapping.sourceId, "1");
  assert.equal(mapping.alternates.length, 2, "the new source is now an alternate too");
  assert.equal(mapping.alternates.at(-1).sourceId, "2");
});

test("a mihon entry, which never had a source id, still records its old home", async () => {
  const store = new LibraryStore(memoryDatabase());
  await store.addSeries({ id: "mihon:12", provider: "mihon", title: "Berserk" });
  const from = [chapter("mihon:ch:1", "mihon:12", 1)];
  await store.putChapters("mihon:12", from);
  const plan = planMigration({
    seriesId: "mihon:12",
    target: TARGET,
    from,
    to: [chapter("dalvik:ch:2:b1", TARGET.seriesId, 1, 20)],
    read: new Set(["mihon:ch:1"]),
    pages: new Map(),
  });
  assert.equal(plan.ok, true);
  await applyMigration({ store, plan: plan.plan, target: TARGET, at: 5 });
  const mapping = await store.getMapping("mihon:12");
  assert.equal(mapping.provider, "dalvik");
  assert.equal(mapping.alternates.length, 1);
  assert.deepEqual(
    { provider: mapping.alternates[0].provider, sourceId: mapping.alternates[0].sourceId, remoteSeriesId: mapping.alternates[0].remoteSeriesId },
    { provider: "mihon", sourceId: "", remoteSeriesId: "mihon:12" },
  );
  assert.equal(await store.isRead("dalvik:ch:2:b1"), true, "the mark moved with the chapter");
});

test("a refusal writes nothing at all", async () => {
  const { store, from } = await seeded();
  const before = JSON.stringify({
    series: await store.listSeries(),
    chapters: (await store.listAllChapters()).map((row) => row.id).sort(),
    history: await store.listHistory(),
    mapping: await store.getMapping(SERIES),
  });

  const plan = planMigration({
    seriesId: SERIES,
    target: TARGET,
    // The target is missing chapter 2, which is read here.
    from,
    to: [chapter("dalvik:ch:2:b1", TARGET.seriesId, 1, 20), chapter("dalvik:ch:2:b3", TARGET.seriesId, 3, 24), chapter("dalvik:ch:2:b4", TARGET.seriesId, 4, 20)],
    read: new Set(["dalvik:ch:1:a2"]),
    pages: new Map(),
  });
  assert.equal(plan.ok, false);

  const after = JSON.stringify({
    series: await store.listSeries(),
    chapters: (await store.listAllChapters()).map((row) => row.id).sort(),
    history: await store.listHistory(),
    mapping: await store.getMapping(SERIES),
  });
  assert.equal(after, before, "a refused migration is not a partial one");
});

test("a download with a different page count is dropped, and its pages with it", async () => {
  const { store, from } = await seeded();
  const plan = planMigration({ seriesId: SERIES, target: TARGET, from, to, read: new Set(), pages: new Map() });
  await applyMigration({ store, plan: plan.plan, target: TARGET, at: 1 });
  // Chapter 2 was downloaded with 7 pages; the target's chapter 2 has 20, so the old pages cannot be
  // claimed to be that chapter — but the page position still describes it and does carry across.
  assert.equal((await store.getProgress("dalvik:ch:2:b2")).page, 4);
  assert.equal((await store.listDownloads()).some((row) => row.chapterId === "dalvik:ch:2:b2"), false);
});

test("the position is cleared when its chapter did not come across", async () => {
  const store = new LibraryStore(memoryDatabase());
  await store.addSeries({ id: SERIES, provider: "dalvik", title: "Berserk" });
  const from = [chapter("dalvik:ch:1:a1", SERIES, 1), chapter("dalvik:ch:1:a2", SERIES, 2)];
  await store.putChapters(SERIES, from);
  // A bookmark at page 0 into a chapter that is unread — exactly what `advance` writes.
  await store.setPosition(SERIES, "dalvik:ch:1:a2", 0, 1_700_000_000_000);
  const plan = planMigration({
    seriesId: SERIES,
    target: TARGET,
    from,
    to: [chapter("dalvik:ch:2:b1", TARGET.seriesId, 1, 20), chapter("dalvik:ch:2:b4", TARGET.seriesId, 4, 20)],
    read: new Set(),
    pages: new Map(),
  });
  assert.equal(plan.ok, true, "an unread chapter with no counterpart does not refuse");
  await applyMigration({ store, plan: plan.plan, target: TARGET, at: 1 });
  assert.equal(await store.getPosition(SERIES), undefined, "a bookmark into a chapter we no longer hold is cleared");
});

test("history for a chapter the target does not have is kept, not rewritten onto another", async () => {
  const store = new LibraryStore(memoryDatabase());
  await store.addSeries({ id: SERIES, provider: "dalvik", title: "Berserk" });
  const from = [chapter("dalvik:ch:1:a1", SERIES, 1), chapter("dalvik:ch:1:a2", SERIES, 2)];
  await store.putChapters(SERIES, from);
  await store.recordHistory(SERIES, "dalvik:ch:1:a2", 1_700_000_000_000);
  const plan = planMigration({
    seriesId: SERIES,
    target: TARGET,
    from,
    to: [chapter("dalvik:ch:2:b1", TARGET.seriesId, 1, 20), chapter("dalvik:ch:2:b4", TARGET.seriesId, 4, 20)],
    read: new Set(),
    pages: new Map(),
  });
  await applyMigration({ store, plan: plan.plan, target: TARGET, at: 1 });
  const history = await store.listHistory();
  assert.deepEqual(history.map((row) => row.chapterId), ["dalvik:ch:1:a2"], "a true fact about the old source stays true");
});

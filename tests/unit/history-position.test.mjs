import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";

function store() {
  return new LibraryStore(memoryDatabase());
}

test("history is newest first, one row per chapter", async () => {
  const s = store();
  await s.recordHistory("dalvik:1:/manga/a", "dalvik:ch:1:/chapter/a", 100);
  await s.recordHistory("dalvik:1:/manga/a", "dalvik:ch:1:/chapter/b", 200);
  // Reopening a chapter moves it up instead of adding a second row for it.
  await s.recordHistory("dalvik:1:/manga/a", "dalvik:ch:1:/chapter/a", 300);

  const rows = await s.listHistory();
  assert.deepEqual(
    rows.map((row) => [row.chapterId.split("/").pop(), row.at]),
    [
      ["a", 300],
      ["b", 200],
    ],
  );
  assert.equal(rows[0].seriesId, "dalvik:1:/manga/a");
});

test("history keeps the limit it is asked for", async () => {
  const s = store();
  for (let i = 0; i < 8; i += 1) await s.recordHistory("s", `ch${i}`, 1000 + i);
  assert.equal((await s.listHistory(3)).length, 3);
  assert.equal((await s.listHistory(3))[0].chapterId, "ch7");
});

test("position is one row per series, so continue is a lookup and not a scan", async () => {
  const s = store();
  await s.setPosition("series:a", "ch:1", 3, 100);
  await s.setPosition("series:a", "ch:2", 0, 200);
  await s.setPosition("series:b", "ch:9", 7, 150);

  const a = await s.getPosition("series:a");
  assert.deepEqual(a, { seriesId: "series:a", chapterId: "ch:2", page: 0, at: 200 });

  const all = await s.listPositions();
  assert.deepEqual(all.map((row) => row.seriesId), ["series:a", "series:b"], "newest first");
});

test("position and progress are separate rows and neither overwrites the other", async () => {
  const s = store();
  await s.setProgress("ch:1", 4, 20);
  await s.setPosition("series:a", "ch:1", 4, 500);
  assert.deepEqual(await s.getProgress("ch:1"), {
    chapterId: "ch:1",
    page: 4,
    total: 20,
    at: (await s.getProgress("ch:1")).at,
    completed: false,
  });
  assert.equal((await s.getPosition("series:a")).page, 4);
});

test("completion sticks: reaching the last page marks it, re-reading does not clear it", async () => {
  const s = store();
  await s.setProgress("ch:9", 0, 10);
  assert.equal((await s.getProgress("ch:9")).completed, false);
  await s.setProgress("ch:9", 9, 10);
  assert.equal((await s.getProgress("ch:9")).completed, true);
  await s.setProgress("ch:9", 2, 10);
  const row = await s.getProgress("ch:9");
  assert.equal(row.page, 2, "the bookmark moves back");
  assert.equal(row.completed, true, "but the chapter stays read");
});

test("a session records its data model: source, pages read, seconds and completion", async () => {
  const s = store();
  const id = await s.beginSession({ seriesId: "series:a", sourceId: "2499283573021220255", chapterId: "ch:1", startPage: 3 }, 1000);
  const open = (await s.listSessions())[0];
  assert.equal(open.endedAt, undefined, "an open session has no end");
  assert.equal(open.sourceId, "2499283573021220255");
  assert.equal(open.pagesRead, 1);
  await s.endSession(id, { endPage: 11, completed: true, at: 1000 + 90_000 });
  const [row] = await s.listSessions();
  assert.equal(row.endPage, 11);
  assert.equal(row.pagesRead, 9);
  assert.equal(row.durationSeconds, 90);
  assert.equal(row.completedChapter, true);
  assert.equal((await s.sessionsFor("series:a")).length, 1);
  assert.equal((await s.sessionsFor("series:b")).length, 0);
});

test("closing a session twice does not double-count the time", async () => {
  const s = store();
  const id = await s.beginSession({ seriesId: "s", chapterId: "ch", startPage: 0 }, 0);
  await s.endSession(id, { endPage: 4, at: 60_000 });
  await s.endSession(id, { endPage: 9, at: 600_000 });
  const [row] = await s.listSessions();
  assert.equal(row.endPage, 4, "the first close wins");
  assert.equal(row.durationSeconds, 60);
});

test("a backward re-read counts its pages and never goes negative", async () => {
  const s = store();
  const id = await s.beginSession({ seriesId: "s", chapterId: "ch", startPage: 30 }, 0);
  await s.endSession(id, { endPage: 25, at: 1000 });
  assert.equal((await s.listSessions())[0].pagesRead, 6);
});

test("retention prunes only old closed sessions, never open ones", async () => {
  const s = store();
  const now = 10_000 * 86_400_000;
  const old = await s.beginSession({ seriesId: "s", chapterId: "old", startPage: 0 }, now - 100 * 86_400_000);
  await s.endSession(old, { endPage: 3, at: now - 100 * 86_400_000 + 60_000 });
  const fresh = await s.beginSession({ seriesId: "s", chapterId: "fresh", startPage: 0 }, now - 86_400_000);
  await s.endSession(fresh, { endPage: 3, at: now - 86_400_000 + 60_000 });
  await s.beginSession({ seriesId: "s", chapterId: "open", startPage: 0 }, now - 200 * 86_400_000);

  const removed = await s.pruneSessions(90, now);
  assert.equal(removed, 1);
  const left = (await s.listSessions()).map((row) => row.chapterId).sort();
  assert.deepEqual(left, ["fresh", "open"], "an open session is not history yet");
  assert.equal((await s.listTombstones()).filter((row) => row.kind === "session").length, 1);
});

test("retention never ages out reading history, only the sessions", async () => {
  // History is the record of what was read and when — the thing stats are built from — so it has no
  // retention window. Only the timed sessions age out.
  const s = store();
  const now = 10_000 * 86_400_000;
  const ancient = now - 900 * 86_400_000;
  await s.recordHistory("s", "read-long-ago", ancient);
  const id = await s.beginSession({ seriesId: "s", chapterId: "read-long-ago", startPage: 0 }, ancient);
  await s.endSession(id, { endPage: 3, at: ancient + 60_000 });

  assert.equal(await s.pruneSessions(30, now), 1, "the session aged out");
  assert.equal((await s.listSessions()).length, 0);
  const history = await s.listHistory(10);
  assert.equal(history.length, 1, "the history row is still there");
  assert.equal(history[0].chapterId, "read-long-ago");
  assert.equal(history[0].at, ancient, "and it still carries the day it was read");
});

test("retention of zero keeps everything", async () => {
  const s = store();
  const id = await s.beginSession({ seriesId: "s", chapterId: "ch", startPage: 0 }, 0);
  await s.endSession(id, { endPage: 1, at: 1000 });
  assert.equal(await s.pruneSessions(0), 0);
  assert.equal((await s.listSessions()).length, 1);
});

test("a range clear deletes only that window and leaves a tombstone per row", async () => {
  const s = store();
  const day = 86_400_000;
  const now = 10_000 * day;
  for (const [chapterId, startedAt] of [["old", now - 40 * day], ["recent", now - 2 * day]]) {
    const id = await s.beginSession({ seriesId: "s", chapterId, startPage: 0 }, startedAt);
    await s.endSession(id, { endPage: 4, at: startedAt + 60_000 });
    await s.recordHistory("s", chapterId, startedAt);
  }
  // "Last 30 days" means the records inside that window — the older ones are left alone.
  const removed = await s.clearHistory({ since: now - 30 * day });
  assert.deepEqual(removed, { sessions: 1, history: 1 });
  assert.deepEqual((await s.listSessions()).map((row) => row.chapterId), ["old"]);
  assert.deepEqual((await s.listHistory()).map((row) => row.chapterId), ["old"]);
  const kinds = (await s.listTombstones()).map((row) => row.kind).sort();
  assert.deepEqual(kinds, ["history", "session"]);
});

test("clearing history keeps progress, position and read marks", async () => {
  const s = store();
  await s.setProgress("ch:1", 7, 20);
  await s.setPosition("series:a", "ch:1", 7);
  await s.recordHistory("series:a", "ch:1");
  await s.beginSession("series:a", "ch:1", 7, 1000);
  await s.clearHistory();
  assert.equal((await s.listHistory()).length, 0);
  assert.equal((await s.listSessions()).length, 0);
  assert.equal((await s.getProgress("ch:1")).page, 7, "the bookmark survives");
  assert.equal((await s.getPosition("series:a")).page, 7);
});

test("view state is remembered per collection, and the unfiltered library is its own key", async () => {
  const s = store();
  await s.setViewState({ collectionId: "all", sort: "recent", view: "compact", coverSize: 112, onlyUnread: true, scroll: 480 });
  await s.setViewState({ collectionId: "c:2", sort: "title", onlyUnread: false, scroll: 0 });
  const all = await s.getViewState("all");
  const reading = await s.getViewState("c:2");
  assert.equal(all.sort, "recent");
  assert.equal(all.onlyUnread, true);
  assert.equal(all.scroll, 480);
  assert.equal(reading.sort, "title", "one collection does not inherit another's filters");
  assert.equal(reading.onlyUnread, false);
});

test("extension preferences are scoped by extension, and sync metadata is local", async () => {
  const s = store();
  await s.setExtensionPref("ext:a", "lang", "en");
  await s.setExtensionPref("ext:b", "lang", "ja");
  assert.equal(await s.getExtensionPref("ext:a", "lang"), "en");
  assert.equal(await s.getExtensionPref("ext:b", "lang"), "ja");
  assert.equal(await s.getExtensionPref("ext:c", "lang"), undefined);
  await s.setSyncMeta("lastSyncedAt", 1234);
  assert.equal(await s.getSyncMeta("lastSyncedAt"), 1234);
});

test("a source mapping keeps the real source id and the package when known", async () => {
  const s = store();
  await s.putMapping({
    seriesId: "dalvik:2499283573021220255:/manga/x",
    provider: "dalvik",
    sourceId: "2499283573021220255",
    packageId: "eu.kanade.tachiyomi.extension.all.mangadex",
    at: 42,
  });
  const row = await s.getMapping("dalvik:2499283573021220255:/manga/x");
  assert.equal(row.sourceId, "2499283573021220255", "a 19-digit id stays a string");
  assert.equal(row.packageId, "eu.kanade.tachiyomi.extension.all.mangadex");
  assert.deepEqual((await s.listMappings()).map((m) => m.provider), ["dalvik"]);
});

test("removing a series leaves history and position alone", async () => {
  const s = store();
  await s.addSeries({ id: "local:1", provider: "local", title: "One" });
  await s.setPosition("local:1", "local:ch:1", 2);
  await s.recordHistory("local:1", "local:ch:1");
  await s.removeSeries("local:1");

  assert.equal(await s.getSeries("local:1"), undefined);
  assert.equal((await s.getPosition("local:1")).page, 2, "a removed series still knows where you were, in case it returns");
  assert.equal((await s.listHistory()).length, 1);
});

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
  assert.deepEqual(await s.getProgress("ch:1"), { chapterId: "ch:1", page: 4, total: 20, at: (await s.getProgress("ch:1")).at });
  assert.equal((await s.getPosition("series:a")).page, 4);
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

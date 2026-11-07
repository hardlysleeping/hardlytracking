/**
 * Filing a title must not re-add it.
 *
 * `setSeriesCategories` used to write `addedAt: Date.now()` with the category ids, and the library
 * sorts by `addedAt`: every title you filed into a category jumped to the front of the shelf, which
 * is the "it doesn't work" feeling the owner reported. The cover path already had this rule; this
 * test pins it for categories, on the real store over the in-memory database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";

const row = (id, title) => ({ id, provider: "local", title, categoryIds: [] });

async function seeded() {
  const store = new LibraryStore(memoryDatabase());
  for (const entry of [row("s1", "First"), row("s2", "Second"), row("s3", "Third")]) {
    await store.addSeries(entry);
    // Distinct stamps, so "the order changed" is visible and not a tie in the sort.
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  return store;
}

test("filing a title writes its categories", async () => {
  const store = await seeded();
  await store.setSeriesCategories("s2", ["c1", "c2"]);
  assert.deepEqual((await store.getSeries("s2"))?.categoryIds, ["c1", "c2"]);
});

test("filing a title keeps its place in the library", async () => {
  const store = await seeded();
  const before = (await store.listSeries()).map((entry) => entry.id);
  const stamp = (await store.database.all("series")).find((entry) => entry.id === "s3")?.addedAt;
  await store.setSeriesCategories("s3", ["c1"]);
  const after = (await store.listSeries()).map((entry) => entry.id);
  assert.deepEqual(after, before, "filing moved the title in the shelf");
  assert.equal((await store.database.all("series")).find((entry) => entry.id === "s3")?.addedAt, stamp, "filing restamped addedAt");
});

test("unfiling returns the title to no categories and keeps it in the library", async () => {
  const store = await seeded();
  await store.setSeriesCategories("s1", ["c1"]);
  await store.setSeriesCategories("s1", []);
  assert.deepEqual((await store.getSeries("s1"))?.categoryIds, []);
  assert.equal((await store.listSeries()).length, 3);
  assert.deepEqual(await store.seriesInCategory("c1"), []);
});

test("a shelf lists exactly the titles filed into it", async () => {
  const store = await seeded();
  await store.setSeriesCategories("s1", ["c1"]);
  await store.setSeriesCategories("s2", ["c1", "c2"]);
  assert.deepEqual((await store.seriesInCategory("c1")).map((entry) => entry.id).sort(), ["s1", "s2"]);
  assert.deepEqual((await store.seriesInCategory("c2")).map((entry) => entry.id), ["s2"]);
});

test("filing a title that is not in the library refuses instead of inventing a row", async () => {
  const store = await seeded();
  await assert.rejects(() => store.setSeriesCategories("nope", ["c1"]), /not in the library/);
  assert.equal(await store.getSeries("nope"), undefined);
});

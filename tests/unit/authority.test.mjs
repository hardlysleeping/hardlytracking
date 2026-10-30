import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import { createLocalProvider } from "../../src/api/local.ts";
import { createMihonProvider } from "../../src/api/mihon.ts";
import { openLibraryProfile, progressWriter } from "../../src/api/profile.ts";
import { providerFor } from "../../src/api/registry.ts";

const series = { id: "local:1", provider: "local", title: "A Book" };

function store() {
  return new LibraryStore(memoryDatabase());
}

test("the local provider owns progress; a Mihon runtime owns its own", () => {
  const local = createLocalProvider(store());
  const mihon = createMihonProvider({ asset: (p) => p, gql: async () => ({}) });
  assert.equal(local.ownsProgress, true);
  assert.equal(mihon.ownsProgress, false);
  assert.equal(progressWriter(local), "device");
  assert.equal(progressWriter(mihon), "server");
});

test("the local library answers search, details and chapters from our own rows", async () => {
  const s = store();
  await s.addSeries(series);
  await s.addSeries({ id: "local:2", provider: "local", title: "Another Book" });
  await s.putChapters("local:1", [
    { id: "local:ch:1", seriesId: "local:1", name: "One", number: 1, pageCount: 20, read: false },
    { id: "local:ch:2", seriesId: "local:1", name: "Two", number: 2, pageCount: 22, read: false },
  ]);
  const provider = createLocalProvider(s);

  const hits = await provider.search("local:src:library", "another", 1);
  assert.deepEqual(hits.items.map((x) => x.id), ["local:2"]);

  const detail = await provider.details("local:1");
  assert.equal(detail.title, "A Book");

  const chapters = await provider.chapters("local:1");
  assert.deepEqual(chapters.map((c) => c.number), [2, 1], "newest chapter first");

  await provider.setRead("local:ch:2", true);
  const after = await provider.chapters("local:1");
  assert.equal(after.find((c) => c.id === "local:ch:2").read, true);
  assert.equal(after.find((c) => c.id === "local:ch:1").read, false);
});

test("a local provider refuses a mihon id", async () => {
  const provider = createLocalProvider(store());
  await assert.rejects(() => provider.details("mihon:12"), /not a local id/);
});

test("a profile registers local always and mihon only when configured", async () => {
  const withRuntime = await openLibraryProfile({ database: memoryDatabase(), dalvikBase: null });
  // archive.org is public, so it is registered whether or not any other host is configured.
  assert.deepEqual(withRuntime.providers.map((p) => p.kind), ["mihon", "local", "archive"]);
  assert.equal(providerFor(withRuntime.providers, "mihon:12").kind, "mihon");
  assert.equal(providerFor(withRuntime.providers, "local:1").kind, "local");
  assert.equal(withRuntime.dalvik, null, "no dalvik host was configured");

  const offline = await openLibraryProfile({ database: memoryDatabase(), mihonBase: null, dalvikBase: null });
  assert.deepEqual(offline.providers.map((p) => p.kind), ["local", "archive"]);
  assert.throws(() => providerFor(offline.providers, "mihon:12"), /no mihon provider/);
});

test("progress is stored per chapter and survives a reopen", async () => {
  const database = memoryDatabase();
  const first = await openLibraryProfile({ database });
  await first.store.setProgress("mihon:ch:1", 7, 20);
  const second = await openLibraryProfile({ database });
  const row = await second.store.getProgress("mihon:ch:1");
  assert.equal(row.page, 7);
  assert.equal(row.total, 20);
});

test("the library lists newest-added first and forgets a removed series", async () => {
  const s = store();
  await s.addSeries(series);
  await new Promise((r) => setTimeout(r, 2));
  await s.addSeries({ id: "local:2", provider: "local", title: "Later" });
  assert.deepEqual((await s.listSeries()).map((x) => x.id), ["local:2", "local:1"]);
  await s.removeSeries("local:2");
  assert.deepEqual((await s.listSeries()).map((x) => x.id), ["local:1"]);
});

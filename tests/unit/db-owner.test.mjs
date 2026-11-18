/**
 * A series' chapters, without reading the library (`STAB-11`, #32).
 *
 * The old `listChapters` read every chapter row on the device and filtered in JavaScript — 48 000
 * rows, 129 ms, on every pane pick (measured by `npm run perf:sqlite`, #29). The owner of a chapter
 * is a field on the row, so both engines now keep that field as a projection: an IndexedDB index, a
 * SQLite column written in the same INSERT as the document. This file pins the three things that
 * make that safe —
 *
 * - `listChapters` goes through `byOwner` and never calls `all("chapters")` (the scan cannot return),
 * - a row's owner is updated with the row, so an edited chapter cannot keep a stale one,
 * - a library written before the column existed still lists its chapters (the backfill).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryDatabase, ownerPathOf, OWNER_INDEX } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";

const { SqliteDatabase } = await import("../../src/lib/db/sqlite.ts");

/** `$n` → `?`, in the order the placeholders appear. Same connector the other engine tests use. */
function connector(directory, handles = []) {
  return async (name) => {
    const db = new DatabaseSync(join(directory, name));
    handles.push(db);
    const order = (query) => [...query.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]) - 1);
    const bound = (query, values = []) => order(query).map((at) => values[at]);
    return {
      async execute(query, values = []) {
        db.prepare(query.replace(/\$\d+/g, "?")).run(...bound(query, values));
      },
      async select(query, values = []) {
        return db.prepare(query.replace(/\$\d+/g, "?")).all(...bound(query, values));
      },
      async close() {
        db.close();
        return true;
      },
    };
  };
}

function chapter(seriesId, number) {
  return { id: `${seriesId}:ch:${number}`, seriesId, name: `Chapter ${number}`, number, pageCount: 10, read: false };
}

/** A store whose engine refuses the two calls this card is about removing. */
function scansForbidden(db) {
  const touched = [];
  return {
    touched,
    db: {
      ...db,
      get: (store, key) => (touched.push(`get ${store}`), db.get(store, key)),
      put: (store, value) => (touched.push(`put ${store}`), db.put(store, value)),
      prefix: (store, prefix) => (touched.push(`prefix ${store}`), db.prefix(store, prefix)),
      byOwner: (store, owner) => (touched.push(`byOwner ${store}`), db.byOwner(store, owner)),
      remove: (store, key) => db.remove(store, key),
      all: (store) => {
        throw new Error(`a full read of ${store} is the scan this card removed`);
      },
    },
  };
}

test("the owner of a chapter row is its series, and no other store has one", () => {
  assert.equal(ownerPathOf("chapters"), "seriesId");
  assert.equal(ownerPathOf("downloadPages"), undefined, "a store without an owner field would silently answer []");
  assert.equal(OWNER_INDEX, "owner");
});

test("listChapters reads one series by owner, and never the whole chapters store", async () => {
  const { db, touched } = scansForbidden(memoryDatabase());
  const store = new LibraryStore(db);
  await store.putChapters("s1", [chapter("s1", 1), chapter("s1", 2)]);
  await store.putChapters("s2", [chapter("s2", 1)]);
  touched.length = 0;

  const rows = await store.listChapters("s1");
  assert.deepEqual(rows.map((row) => row.number), [2, 1], "chapters are not newest-number-first");
  assert.ok(rows.every((row) => row.seriesId === "s1"), "another series' chapter came back");
  assert.deepEqual(touched, ["byOwner chapters"], `the read touched ${touched.join(", ")}`);
  assert.deepEqual((await store.listChapters("s9")).length, 0);
});

test("the in-memory engine answers by owner and refuses a store that has none", async () => {
  const db = memoryDatabase();
  await db.put("chapters", chapter("s1", 1));
  await db.put("chapters", chapter("s2", 1));
  assert.deepEqual((await db.byOwner("chapters", "s1")).map((row) => row.id), ["s1:ch:1"]);
  await assert.rejects(db.byOwner("series", "s1"), /no owner/);
});

test("a real SQLite file answers by owner, and follows the row when it changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ht-owner-"));
  const handles = [];
  try {
    const db = await SqliteDatabase.open("owner.db", connector(directory, handles));
    const store = new LibraryStore(db);
    await store.putChapters("s1", [chapter("s1", 1), chapter("s1", 2)]);
    await store.putChapters("s2", [chapter("s2", 1)]);
    assert.deepEqual((await store.listChapters("s1")).map((row) => row.number), [2, 1]);
    assert.equal((await store.listChapters("s2")).length, 1);

    // Moving a chapter to another series must move its index entry with it — the owner is written
    // by the same statement as the document.
    const moved = { ...chapter("s1", 2), seriesId: "s2" };
    await db.put("chapters", moved);
    assert.deepEqual((await store.listChapters("s1")).map((row) => row.number), [1]);
    assert.deepEqual((await store.listChapters("s2")).map((row) => row.number), [2, 1]);

    // The column is a real column, indexed: a library this size is what made the scan expensive.
    const index = handles[0].prepare("PRAGMA index_list(records)").all().find((row) => row.name === "records_owner");
    assert.ok(index !== undefined, "the owner column is not indexed");
    const stored = handles[0].prepare("SELECT owner FROM records WHERE key = ?").get("s2:ch:1");
    assert.equal(stored.owner, "s2");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a library written before the owner column existed still lists its chapters", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ht-owner-legacy-"));
  try {
    // The shape v17 wrote: no owner column, documents already in the table.
    const legacy = new DatabaseSync(join(directory, "owner.db"));
    legacy.exec("CREATE TABLE records (store TEXT NOT NULL, key TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (store, key))");
    const insert = legacy.prepare("INSERT INTO records (store, key, doc) VALUES (?, ?, ?)");
    for (const number of [1, 2, 3]) {
      const row = chapter("s1", number);
      insert.run("chapters", row.id, JSON.stringify(row));
    }
    const other = chapter("s2", 1);
    insert.run("chapters", other.id, JSON.stringify(other));
    const series = { id: "s1", provider: "local", title: "Legacy" };
    insert.run("series", "s1", JSON.stringify(series));

    // Opening it is the upgrade; the rows were never rewritten by the app.
    const db = await SqliteDatabase.open("owner.db", connector(directory));
    const store = new LibraryStore(db);
    assert.deepEqual((await store.listChapters("s1")).map((row) => row.number), [3, 2, 1], "the backfill lost a legacy chapter");
    assert.equal((await store.listChapters("s2")).length, 1);
    assert.equal((await store.getSeries("s1"))?.title, "Legacy", "the upgrade disturbed a row it should not touch");
    legacy.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
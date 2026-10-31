/**
 * The desktop engine, against a real SQLite file.
 *
 * The statements this test runs are the ones `src/lib/db/sqlite.ts` ships — the connector below is
 * only the transport (`node:sqlite` instead of the Tauri plugin), so the SQL, the JSON documents and
 * the blob encoding are all under test without launching an app.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { SqliteDatabase } = await import("../../src/lib/db/sqlite.ts");

/**
 * `$1, $2, …` (sqlx, the plugin) translated to node:sqlite's positional `?`. Every statement in the
 * engine names each argument once, in order, which is what makes the substitution faithful.
 */
function connector(directory) {
  return async (name) => {
    const db = new DatabaseSync(join(directory, name));
    const bind = (query) => db.prepare(query.replace(/\$\d+/g, "?"));
    return {
      async execute(query, values = []) {
        bind(query).run(...values);
      },
      async select(query, values = []) {
        return bind(query).all(...values);
      },
      async close() {
        db.close();
        return true;
      },
    };
  };
}

async function withDatabase(run) {
  const directory = mkdtempSync(join(tmpdir(), "ht-sqlite-"));
  try {
    const db = await SqliteDatabase.open("library.db", connector(directory));
    await run(db, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a document survives the trip through SQLite", async () => {
  await withDatabase(async (db) => {
    const series = { id: "mihon:1", title: "Berserk", unread: 3, tags: ["seinen", "dark"] };
    await db.put("series", series);
    assert.deepEqual(await db.get("series", "mihon:1"), series);
  });
});

test("the same key in two stores is two rows", async () => {
  await withDatabase(async (db) => {
    await db.put("series", { id: "shared", title: "a series" });
    await db.put("knownSeries", { id: "shared", title: "a known series" });
    assert.equal((await db.get("series", "shared")).title, "a series");
    assert.equal((await db.get("knownSeries", "shared")).title, "a known series");
    assert.equal((await db.all("series")).length, 1);
  });
});

test("put is an upsert, not an insert", async () => {
  await withDatabase(async (db) => {
    await db.put("progress", { chapterId: "c1", page: 1 });
    await db.put("progress", { chapterId: "c1", page: 9 });
    assert.equal((await db.get("progress", "c1")).page, 9);
    assert.equal((await db.all("progress")).length, 1);
  });
});

test("remove deletes only its own row", async () => {
  await withDatabase(async (db) => {
    await db.put("prefs", { key: "theme", value: "dark" });
    await db.put("prefs", { key: "zoom", value: 2 });
    await db.remove("prefs", "theme");
    assert.equal(await db.get("prefs", "theme"), undefined);
    assert.equal((await db.get("prefs", "zoom")).value, 2);
  });
});

test("a Blob comes back a Blob, with its type and its bytes", async () => {
  await withDatabase(async (db) => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    await db.put("imageCache", { key: "https://example.test/a.png", blob: new Blob([bytes], { type: "image/png" }), bytes: bytes.length });
    const row = await db.get("imageCache", "https://example.test/a.png");
    assert.equal(row.blob instanceof Blob, true);
    assert.equal(row.blob.type, "image/png");
    assert.deepEqual(new Uint8Array(await row.blob.arrayBuffer()), bytes);
  });
});

test("a nested Blob (a download page row) also survives", async () => {
  await withDatabase(async (db) => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await db.put("downloadPages", { id: "c1:3", chapterId: "c1", index: 3, blob: new Blob([bytes], { type: "image/jpeg" }) });
    const row = await db.get("downloadPages", "c1:3");
    assert.equal(row.index, 3);
    assert.deepEqual(new Uint8Array(await row.blob.arrayBuffer()), bytes);
  });
});

test("a row with no key is refused instead of becoming unfindable", async () => {
  await withDatabase(async (db) => {
    await assert.rejects(() => db.put("series", { title: "no id" }), /has no id to key it by/);
    assert.equal((await db.all("series")).length, 0);
  });
});

test("writes issued together all land", async () => {
  await withDatabase(async (db) => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => db.put("history", { chapterId: `c${index}`, at: index })),
    );
    const rows = await db.all("history");
    assert.equal(rows.length, 20);
    assert.deepEqual(
      rows.map((row) => row.chapterId).sort(),
      Array.from({ length: 20 }, (_, index) => `c${index}`).sort(),
    );
  });
});

test("the library is still there when the app opens it again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ht-sqlite-"));
  try {
    const first = await SqliteDatabase.open("library.db", connector(directory));
    await first.put("series", { id: "mihon:2", title: "Vagabond" });
    const second = await SqliteDatabase.open("library.db", connector(directory));
    assert.equal((await second.get("series", "mihon:2")).title, "Vagabond");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

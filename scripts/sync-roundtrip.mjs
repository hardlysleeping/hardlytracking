#!/usr/bin/env node
/**
 * The S1 gate, as a command: build a document from a real store, write it to a file,
 * read it back, and compare bytes.
 *
 *   npm run sync:roundtrip
 *
 * It uses the in-memory database, so it never touches his library, and it prints both
 * hashes so a mismatch says *where* the bytes diverged rather than just "failed".
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { memoryDatabase } from "../src/lib/db/open.ts";
import { LibraryStore } from "../src/lib/db/store.ts";
import { documentFromStore } from "../src/lib/sync/from-store.ts";
import { parseSync, serializeSync } from "../src/lib/sync/document.ts";

const sha = (text) => createHash("sha256").update(text).digest("hex");

const db = memoryDatabase();
const store = new LibraryStore(db);
const at = 1_700_000_000_000;

await store.addSeries({ id: "mihon:1", provider: "mihon", title: "First", categoryIds: ["c1"] });
await store.addSeries({ id: "mihon:2", provider: "mihon", title: "Second", categoryIds: [] });
await store.putCategory({ id: "c1", name: "Comics", order: 0, hidden: false, pinned: true });
await store.putCategory({ id: "c2", name: "Manga", order: 1, hidden: true, pinned: false });
await store.putChapters("mihon:1", [
  { id: "mihon:ch:1", seriesId: "mihon:1", name: "Chapter 1", number: 1, pageCount: 20, read: false },
]);
await store.setProgress("mihon:ch:1", 3, 20);
await store.setRead("mihon:ch:1", true);
await store.setPref("reader.mode", "paged");

const doc = await documentFromStore(store, { device: "dev-roundtrip", at });
const written = serializeSync(doc);
const path = join(tmpdir(), "hardlytracking-sync-roundtrip.json");
await writeFile(path, written, "utf8");
const readBack = await readFile(path, "utf8");
const rewritten = serializeSync(parseSync(readBack));

const rows = [
  ["file", path],
  ["bytes", String(written.length)],
  ["series", String(doc.series.length)],
  ["categories", String(doc.categories.length)],
  ["progress", String(doc.progress.length)],
  ["readState", String(doc.readState.length)],
  ["preferences", String(doc.preferences.length)],
  ["sha256 written", sha(written)],
  ["sha256 rewritten", sha(rewritten)],
];
for (const [name, value] of rows) console.log(`${name.padEnd(16)} ${value}`);

const same = written === rewritten;
console.log(same ? "PASS  serialize(parse(x)) === x" : "FAIL  bytes diverged on round-trip");
process.exit(same ? 0 : 1);

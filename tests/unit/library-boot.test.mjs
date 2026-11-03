/**
 * A device whose storage does not open must still answer.
 *
 * The iPhone failure was not "the database threw" — it was "the database never settled", so boot
 * waited on a promise for the whole session and the screen said "Opening the library…" forever.
 * `library.svelte.ts` now catches the open and retries on the memory engine; that retry is only
 * reachable because `openDatabase` *rejects*, with a sentence a person can read. Both halves of
 * that are pinned here: the missing global, and the blocked upgrade.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../src/lib/db/open.ts";

test("a webview with no IndexedDB rejects in a sentence, not a ReferenceError", async () => {
  delete globalThis.indexedDB;
  assert.equal(typeof indexedDB, "undefined", "this test needs a host without IndexedDB");

  const error = await openDatabase().then(
    () => assert.fail("a device with no IndexedDB opened a database"),
    (cause) => cause,
  );
  // The exact sentence matters: it is the reason `library.open` puts inside its own message, and a
  // ReferenceError's "indexedDB is not defined" is what the user would otherwise be shown.
  assert.equal(error.message, "this webview has no local database to open");
  assert.equal(error.name, "Error", "the guard's own Error was not what reached the caller");
});

test("an upgrade blocked by another connection rejects instead of waiting forever", async () => {
  // A pending request is the dead screen; `onblocked` is the only notice there is, so it is turned
  // into a rejection. Nothing here ever answers on success — that is the case being tested.
  globalThis.indexedDB = {
    open() {
      const request = {};
      setTimeout(() => request.onblocked?.(new Event("blocked")), 0);
      return request;
    },
  };
  try {
    const settled = await Promise.race([
      openDatabase().then(
        () => assert.fail("a blocked upgrade was reported as an open database"),
        (cause) => cause,
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error("the open never settled")), 2_000)),
    ]);
    assert.equal(settled.message, "another window is holding this device's library database open");
  } finally {
    delete globalThis.indexedDB;
  }
});

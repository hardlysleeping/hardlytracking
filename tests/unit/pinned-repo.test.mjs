/**
 * The pinned repository: seeded on every boot, undeletable, and still just a repository.
 *
 * A pinned row is the app's own provider list. The two failure modes it exists to prevent are "the
 * user deleted it and their sources vanished with a switch still saying on" and "a boot re-added it
 * a second time, so the list grows on every launch".
 */
import assert from "node:assert/strict";
import test from "node:test";

import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import {
  OFFICIAL_REPO_INDEX_URL,
  OFFICIAL_REPO_NAME,
  OFFICIAL_REPO_URL,
  ensurePinnedRepo,
  isPinnedRepo,
} from "../../src/lib/extensions/pinned-repo.ts";

function store() {
  return new LibraryStore(memoryDatabase());
}

test("a fresh install gains the official repository exactly once", async () => {
  const library = store();
  assert.deepEqual(await library.listRepos(), []);
  await ensurePinnedRepo(library);
  const rows = await library.listRepos();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, OFFICIAL_REPO_URL);
  assert.equal(rows[0].indexUrl, OFFICIAL_REPO_INDEX_URL);
  assert.equal(rows[0].name, OFFICIAL_REPO_NAME);
  assert.equal(rows[0].pinned, true);
  assert.equal(isPinnedRepo(rows[0].url), true);
});

test("a second boot does not add a second copy", async () => {
  const library = store();
  await ensurePinnedRepo(library);
  const first = await library.listRepos();
  await ensurePinnedRepo(library);
  const second = await library.listRepos();
  assert.equal(second.length, 1);
  // The position is the user's list order: a repair must not shuffle it to the front.
  assert.equal(second[0].at, first[0].at);
});

test("it cannot be removed, and the refusal names it", async () => {
  const library = store();
  await ensurePinnedRepo(library);
  await assert.rejects(() => library.removeRepo(OFFICIAL_REPO_URL), /cannot be removed/);
  assert.equal((await library.listRepos()).length, 1);
});

test("a row from an older build is pinned in place, without moving or duplicating it", async () => {
  const library = store();
  await library.putRepo({ url: OFFICIAL_REPO_URL, indexUrl: "https://example.test/index.json", name: OFFICIAL_REPO_NAME, at: 1234 });
  await ensurePinnedRepo(library);
  const rows = await library.listRepos();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pinned, true);
  assert.equal(rows[0].indexUrl, OFFICIAL_REPO_INDEX_URL, "an old index address is repaired, not kept");
  assert.equal(rows[0].at, 1234, "the user's ordering survives a repair");
});

test("the user's own repositories are untouched and still removable", async () => {
  const library = store();
  await library.putRepo({ url: "https://keiyoushi.example/index.min.json", indexUrl: "https://keiyoushi.example/index.min.json", name: "Keiyoushi", at: 1 });
  await ensurePinnedRepo(library);
  const rows = await library.listRepos();
  assert.deepEqual(rows.map((row) => row.name), ["Keiyoushi", OFFICIAL_REPO_NAME]);
  await library.removeRepo("https://keiyoushi.example/index.min.json");
  assert.deepEqual((await library.listRepos()).map((row) => row.name), [OFFICIAL_REPO_NAME]);
});

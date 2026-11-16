/**
 * A backup this app writes has to be a backup this app can read.
 *
 * `from-store` sends `seriesId: ""` for a progress row whose chapter is no longer on the device —
 * a chapter list that changed, a title that was removed while its position stayed. `serializeSync`
 * validates the document it is handed, so Export threw `progress[0] has no seriesId` and no file
 * was ever written: "backup doesn't work" with a row the writer had just produced itself.
 *
 * The series is a hint, not the identity. Progress is keyed by chapterId in `keyOf`, in
 * `identityOf` and in `apply`, so an empty hint costs nothing and keeps the position for a chapter
 * that comes back.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { documentFromStore } from "../../src/lib/sync/from-store.ts";
import { parseSync, serializeSync } from "../../src/lib/sync/document.ts";

/** The narrowest store `documentFromStore` can be handed: one series, no chapters, one position. */
function storeWith(progress) {
  return {
    listSeries: async () => [{ id: "archive:a", provider: "archive", title: "A", categoryIds: [] }],
    listChapters: async () => [],
    listProgress: async () => progress,
    listCategories: async () => [],
    listPrefs: async () => [],
    listSessions: async () => [],
    listTombstones: async () => [],
    listPositions: async () => [],
    listMappings: async () => [],
    listRepos: async () => [],
    listHistory: async () => [],
  };
}

test("a position whose chapter is gone still exports, and reads back", async () => {
  const store = storeWith([{ chapterId: "archive:a/1", page: 7, total: 20, at: 1_700_000_000_000 }]);
  const doc = await documentFromStore(store, { device: "test" });
  assert.equal(doc.progress[0].seriesId, "", "the writer cannot know the series, and says so");

  // The bug: this threw `progress[0] has no seriesId` before a single byte was written.
  const text = serializeSync(doc);
  const back = parseSync(text);
  assert.equal(back.progress.length, 1);
  assert.equal(back.progress[0].chapterId, "archive:a/1");
  assert.equal(back.progress[0].page, 7);
});

test("an entry that cannot be identified is refused by name", () => {
  const body = {
    meta: { format: "hardlytracking.sync", version: 3, device: "test", updatedAt: new Date(0).toISOString(), revision: 1 },
    series: [], chapters: [], categories: [],
    progress: [{ seriesId: "archive:a", page: 1 }],
    readState: [], positions: [], history: [], sessions: [], bookmarks: [],
    sourceMappings: [], extensions: [], preferences: [], trackers: [], repos: [], tombstones: [],
  };
  // The identity is still required: only the hint became optional.
  assert.throws(() => parseSync(JSON.stringify(body)), /progress\[0\] has no chapterId/);
});

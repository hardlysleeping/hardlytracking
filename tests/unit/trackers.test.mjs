/**
 * The tracker rules that keep a reading list from being wrecked.
 *
 * Every case here is a real way a sync corrupts a list: pushing backwards, pushing twice, letting a
 * pull lower local progress, sending a score the service rejects. The adapters are HTTP; this file is
 * the part that has to be right.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  SCORE_SCALE,
  needsRefresh,
  planPush,
  reconcile,
  splitTrackerId,
  toServiceScore,
  toUiScore,
  trackerId,
} from "../../src/lib/trackers/types.ts";
import { bindSeries, flushPending, pullSeries, pushChapter } from "../../src/lib/trackers/host.ts";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";

function store() {
  return new LibraryStore(memoryDatabase());
}

/** An adapter that records what it was asked to do and can be told to fail. */
function fakeTracker(service, options = {}) {
  const calls = [];
  let failing = options.failing ?? false;
  let remote = { lastChapter: options.remoteChapter ?? 0, status: "reading" };
  return {
    service,
    calls,
    set failing(value) {
      failing = value;
    },
    async search(title) {
      return [{ remoteId: "42", title }];
    },
    async pull() {
      if (failing) throw new Error("service is down");
      return { ...remote };
    },
    async push(_remoteId, chapter) {
      if (failing) throw new Error("service is down");
      calls.push(chapter);
      remote = { ...remote, lastChapter: chapter };
      return { ...remote };
    },
    async setScore() {},
    async setStatus() {},
  };
}

test("ids round-trip, and an unknown service is not an id", () => {
  assert.equal(trackerId("anilist", "mihon:12"), "anilist:mihon:12");
  assert.deepEqual(splitTrackerId("anilist:mihon:12"), { service: "anilist", seriesId: "mihon:12" });
  assert.equal(splitTrackerId("myspace:12"), null);
  assert.equal(splitTrackerId("nocolon"), null);
});

test("a push never goes backwards, twice, or nowhere", () => {
  assert.deepEqual(planPush({ lastChapter: 12 }, 13), { send: 13 });
  assert.deepEqual(planPush({ lastChapter: 12 }, 12), { skip: "not-forward" });
  assert.deepEqual(planPush({ lastChapter: 40 }, 3), { skip: "not-forward" });
  assert.deepEqual(planPush({ lastChapter: 0 }, 0), { skip: "no-chapter" });
  assert.deepEqual(planPush({ lastChapter: 0, pending: { chapter: 9, at: 1 } }, 9), { skip: "already-sent" });
  assert.deepEqual(planPush({ lastChapter: 0, pending: { chapter: 9, at: 1 } }, 10), { send: 10 });
});

test("a pull never lowers local progress, and says when the service disagrees", () => {
  const behind = reconcile({ chapter: 40 }, { lastChapter: 12, status: "reading" });
  assert.equal(behind.chapter, 40);
  assert.equal(behind.disagreement, true);

  const ahead = reconcile({ chapter: 12 }, { lastChapter: 40, status: "completed" });
  assert.equal(ahead.chapter, 40);
  assert.equal(ahead.disagreement, false);

  const silent = reconcile({ chapter: 7 }, {});
  assert.equal(silent.chapter, 7);
  assert.equal(silent.disagreement, true, "a service that reports nothing is behind, not equal");
});

test("scores convert to each service's own scale and snap to its step", () => {
  assert.equal(toServiceScore("mal", 7), 7);
  assert.equal(toServiceScore("mal", 7.5), 8, "MAL takes integers");
  assert.equal(toServiceScore("anilist", 7), 70);
  assert.equal(toServiceScore("kitsu", 7.5), 4, "Kitsu is 0-5 in halves");
  assert.equal(toServiceScore("mal", 42), 10, "clamped");
  assert.equal(toServiceScore("mal", -3), 0);
  assert.equal(toUiScore("anilist", 70), 7);
  assert.equal(toUiScore("kitsu", 4.5), 9);
  assert.equal(SCORE_SCALE.mal.max, 10);
});

test("a token about to expire is refreshed before the call", () => {
  const now = 1_000_000;
  assert.equal(needsRefresh({ expiresAt: now + 30_000 }, now), true);
  assert.equal(needsRefresh({ expiresAt: now + 600_000 }, now), false);
  assert.equal(needsRefresh({}, now), false, "no expiry known is not an expiry");
});

test("binding seeds the row, and a device ahead of the service owes it a push", async () => {
  const library = store();
  const tracker = fakeTracker("anilist", { remoteChapter: 5 });
  const row = await bindSeries(
    { store: library, trackers: { anilist: tracker } },
    { seriesId: "mihon:12", service: "anilist", remoteId: "42", remoteTitle: "Berserk", localChapter: 40 },
  );
  assert.equal(row.id, "anilist:mihon:12");
  assert.equal(row.lastChapter, 40, "local progress is not thrown away");
  assert.deepEqual(row.pending, { chapter: 40, at: row.pending.at });
  assert.equal((await library.listTrackersForSeries("mihon:12")).length, 1);
});

test("a read pushes once, and a repeated read pushes nothing", async () => {
  const library = store();
  const tracker = fakeTracker("anilist");
  const host = { store: library, trackers: { anilist: tracker } };
  await bindSeries(host, { seriesId: "mihon:12", service: "anilist", remoteId: "42" });

  const first = await pushChapter(host, "mihon:12", 1);
  assert.deepEqual(first, [{ pushed: true }]);
  const again = await pushChapter(host, "mihon:12", 1);
  assert.deepEqual(again, [{ pushed: false, reason: "not-forward" }]);
  assert.deepEqual(tracker.calls, [1]);
});

test("a service that is down costs a retry, not the chapter", async () => {
  const library = store();
  const tracker = fakeTracker("anilist");
  const host = { store: library, trackers: { anilist: tracker } };
  await bindSeries(host, { seriesId: "mihon:12", service: "anilist", remoteId: "42" });

  tracker.failing = true;
  const failed = await pushChapter(host, "mihon:12", 7);
  assert.equal(failed[0].pushed, false);
  assert.equal(failed[0].reason, "failed");
  const [row] = await library.listTrackers();
  assert.equal(row.pending.chapter, 7, "what it owes survives as a column");
  assert.match(row.pending.error, /service is down/);

  tracker.failing = false;
  const flushed = await flushPending(host);
  assert.deepEqual(flushed, { flushed: 1, failed: 0 });
  const [after] = await library.listTrackers();
  assert.equal(after.pending, undefined);
  assert.equal(after.lastChapter, 7);
});

test("a pull reports the disagreement and keeps the higher chapter", async () => {
  const library = store();
  const tracker = fakeTracker("anilist", { remoteChapter: 3 });
  const host = { store: library, trackers: { anilist: tracker } };
  await bindSeries(host, { seriesId: "mihon:12", service: "anilist", remoteId: "42", localChapter: 20 });
  // clear the owed push so this is only about the pull
  const [row] = await library.listTrackers();
  await library.putTracker({ ...row, pending: undefined });

  const pulled = await pullSeries(host, "mihon:12");
  assert.equal(pulled.length, 1);
  assert.equal(pulled[0].disagreement, true);
  assert.equal(pulled[0].row.lastChapter, 20, "the service being behind does not undo local reading");
});

test("an unbound series pushes nothing and costs nothing", async () => {
  const library = store();
  const outcomes = await pushChapter({ store: library, trackers: {} }, "mihon:99", 5);
  assert.deepEqual(outcomes, []);
});

test("a bound series with no adapter is reported, not silently skipped", async () => {
  const library = store();
  await library.putTracker({ id: "kitsu:mihon:12", seriesId: "mihon:12", service: "kitsu", remoteId: "9", lastChapter: 0 });
  const outcomes = await pushChapter({ store: library, trackers: {} }, "mihon:12", 4);
  assert.deepEqual(outcomes, [{ pushed: false, reason: "no-adapter" }]);
});

test("a backup never carries a tracker token", async () => {
  const { travelsInBackup } = await import("../../src/lib/sync/from-store.ts");
  assert.equal(travelsInBackup("trackerAccounts"), false);
  assert.equal(travelsInBackup("trackers"), true, "the binds travel; only the secrets stay home");
  assert.equal(travelsInBackup("series"), true);
});

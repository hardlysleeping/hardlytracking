/**
 * The push queue: when a failed push may be tried again, and what the reader is allowed to feel.
 *
 * The cases here are the ones a real phone produces — a service that is down while a chapter is
 * finished, an app relaunched before the ladder has run out, a row that already knows more than the
 * debt it carries. The rule under all of them: the chapter is read either way.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { BACKOFF_MS, backoffDelay, isDue, nextChapter } from "../../src/lib/trackers/queue.ts";
import { bindSeries, flushPending, pushChapter } from "../../src/lib/trackers/host.ts";
import { installTrackerSync, registerTracker } from "../../src/lib/trackers/sync.ts";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";

function store() {
  return new LibraryStore(memoryDatabase());
}

/** An adapter that records what it was asked to do and can be told to fail, with either error. */
function fakeTracker(service, options = {}) {
  const calls = [];
  let failing = options.failing ?? false;
  let error = options.error ?? new Error("service is down");
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
      if (failing) throw error;
      return { ...remote };
    },
    async push(_remoteId, chapter) {
      if (failing) throw error;
      calls.push(chapter);
      remote = { ...remote, lastChapter: chapter };
      return { ...remote };
    },
    async setScore() {},
    async setStatus() {},
  };
}

/** The hook is fire-and-forget, so a test has to wait for it rather than for a return value. */
async function waitFor(check, timeoutMs = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the queue");
}

function chapter(number) {
  return { id: `mihon:ch:${number}`, seriesId: "mihon:12", name: `Chapter ${number}`, number, pageCount: 20, read: false };
}

test("the ladder is a minute, then hours, and a chapter never tried is due now", () => {
  assert.equal(backoffDelay(0), 0, "a fresh debt is not made to wait");
  assert.equal(backoffDelay(1), BACKOFF_MS[0]);
  assert.equal(backoffDelay(2), BACKOFF_MS[1]);
  assert.equal(backoffDelay(3), BACKOFF_MS[2]);
  assert.equal(backoffDelay(4), BACKOFF_MS[3]);
  assert.equal(backoffDelay(5), BACKOFF_MS[4]);
  assert.equal(backoffDelay(40), BACKOFF_MS[4], "the cap is the last rung, not a bigger wait");
  assert.equal(backoffDelay(-3), 0, "a nonsense count is not a long wait");

  const now = 1_000_000;
  assert.equal(isDue({ at: now, attempt: 0 }, now), true);
  assert.equal(isDue({ at: now, attempt: undefined }, now), true, "absent attempt is zero");
  assert.equal(isDue({ at: now - 30_000, attempt: 1 }, now), false, "thirty seconds is inside the first rung");
  assert.equal(isDue({ at: now - 61_000, attempt: 1 }, now), true);
  assert.equal(isDue({ at: now - 61_000, attempt: 2 }, now), false, "the second rung is five minutes");
});

test("a chapter is never walked backwards, whatever either side says", () => {
  assert.equal(nextChapter(40, 3), 40);
  assert.equal(nextChapter(3, 40), 40);
  assert.equal(nextChapter(undefined, 7), 7);
  assert.equal(nextChapter(7, undefined), 7);
  assert.equal(nextChapter(undefined, undefined), 0);
  assert.equal(nextChapter(NaN, 5), 5);
});

test("a failed push keeps the chapter, counts the failure, and the read mark still stands", async () => {
  const library = store();
  await library.putChapters("mihon:12", [chapter(7)]);
  const tracker = fakeTracker("anilist");
  registerTracker(tracker);
  const sync = installTrackerSync(library, { now: () => 1_000_000 });
  try {
    await bindSeries({ store: library, trackers: { anilist: tracker } }, { seriesId: "mihon:12", service: "anilist", remoteId: "42" });
    tracker.failing = true;

    await library.setRead("mihon:ch:7", true);

    assert.equal(await library.isRead("mihon:ch:7"), true, "the read happened regardless");
    await waitFor(async () => (await library.listTrackers())[0].pending !== undefined);
    const [row] = await library.listTrackers();
    assert.equal(row.pending.chapter, 7, "what it owes survives as a column");
    assert.equal(row.pending.attempt, 1, "the ladder starts at one failure");
    assert.match(row.pending.error, /service is down/);
  } finally {
    sync.dispose();
  }
});

test("the next attempt waits out the rung, then lands and clears the debt", async () => {
  const library = store();
  const tracker = fakeTracker("anilist");
  const host = { store: library, trackers: { anilist: tracker }, now: () => 0 };
  await bindSeries(host, { seriesId: "mihon:12", service: "anilist", remoteId: "42" });
  tracker.failing = true;
  await pushChapter(host, "mihon:12", 9);

  const early = await flushPending({ ...host, now: () => 30_000 });
  assert.deepEqual(early, { flushed: 0, failed: 0 }, "inside the first rung nothing is asked again");
  assert.deepEqual(tracker.calls, []);

  tracker.failing = false;
  const late = await flushPending({ ...host, now: () => 61_000 });
  assert.deepEqual(late, { flushed: 1, failed: 0 });
  assert.deepEqual(tracker.calls, [9]);
  const [row] = await library.listTrackers();
  assert.equal(row.pending, undefined, "a landed push is no longer owed");
  assert.equal(row.lastChapter, 9);
});

test("a debt the row has outgrown is dropped, never pushed backwards", async () => {
  const library = store();
  const tracker = fakeTracker("anilist");
  await library.putTracker({
    id: "anilist:mihon:12",
    seriesId: "mihon:12",
    service: "anilist",
    remoteId: "42",
    lastChapter: 40,
    pending: { chapter: 3, at: 0, attempt: 1 },
  });

  const result = await flushPending({ store: library, trackers: { anilist: tracker }, now: () => 10 * 60_000 });
  assert.deepEqual(result, { flushed: 0, failed: 0 });
  assert.deepEqual(tracker.calls, [], "chapter 3 was never sent over chapter 40");
  const [row] = await library.listTrackers();
  assert.equal(row.pending, undefined);
  assert.equal(row.lastChapter, 40);
});

test("offline looks exactly like a service that is down", async () => {
  const library = store();
  const tracker = fakeTracker("anilist", { failing: true, error: new TypeError("Failed to fetch") });
  const host = { store: library, trackers: { anilist: tracker }, now: () => 5_000 };
  await bindSeries(host, { seriesId: "mihon:12", service: "anilist", remoteId: "42" });
  const [outcome] = await pushChapter(host, "mihon:12", 2);
  assert.equal(outcome.pushed, false);
  assert.equal(outcome.reason, "failed");
  const [row] = await library.listTrackers();
  assert.equal(row.pending.attempt, 1, "being offline is a retry, not a different kind of failure");
  assert.match(row.pending.error, /Failed to fetch/);
});

test("syncAll ignores the ladder because the user asked", async () => {
  const library = store();
  const tracker = fakeTracker("anilist");
  const clock = 1_000;
  const host = { store: library, trackers: { anilist: tracker }, now: () => clock };
  await bindSeries(host, { seriesId: "mihon:12", service: "anilist", remoteId: "42" });
  tracker.failing = true;
  await pushChapter(host, "mihon:12", 4);

  tracker.failing = false;
  // Not due for another minute, and the button still drains it.
  const manual = await flushPending({ ...host }, { force: true });
  assert.deepEqual(manual, { flushed: 1, failed: 0 });
  assert.deepEqual(tracker.calls, [4]);
});

test("unreading never pushes: a list is a high-water mark", async () => {
  const library = store();
  await library.putChapters("mihon:12", [chapter(3)]);
  const tracker = fakeTracker("anilist");
  registerTracker(tracker);
  const sync = installTrackerSync(library, { now: () => 0 });
  try {
    await bindSeries({ store: library, trackers: { anilist: tracker } }, { seriesId: "mihon:12", service: "anilist", remoteId: "42" });
    await library.setRead("mihon:ch:3", true);
    await waitFor(async () => tracker.calls.length === 1);
    await library.setRead("mihon:ch:3", false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(tracker.calls, [3], "unreading sent nothing");
    assert.equal(await library.isRead("mihon:ch:3"), false, "the local unread still happened");
  } finally {
    sync.dispose();
  }
});

test("with no adapter connected the hook is inert, not broken", async () => {
  const library = store();
  await library.putChapters("mihon:12", [chapter(1)]);
  const sync = installTrackerSync(library);
  try {
    await library.setRead("mihon:ch:1", true);
    assert.equal(await library.isRead("mihon:ch:1"), true);
    assert.deepEqual(await library.listTrackers(), [], "nothing was bound, so nothing is owed");
  } finally {
    sync.dispose();
  }
});

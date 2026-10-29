import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKGROUND_GRACE_MS,
  INACTIVITY_TIMEOUT_MS,
  RETENTION_DAYS,
  durationSeconds,
  pagesRead,
  shouldEndForBackground,
  shouldEndForIdle,
  dayKey,
  durationLabel,
  groupByDay,
  isComplete,
  pruneSessions,
  summarize,
  viewStateKey,
} from "../../src/lib/history.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-10-29T12:00:00Z").getTime();

function session(over = {}) {
  return {
    id: "c1@1",
    seriesId: "s1",
    chapterId: "c1",
    startedAt: NOW - 10 * 60_000,
    endedAt: NOW - 4 * 60_000,
    startPage: 0,
    endPage: 9,
    pagesRead: 10,
    durationSeconds: 6 * 60,
    completedChapter: false,
    sourceId: "src:1",
    ...over,
  };
}

test("summarize counts closed sessions, minutes and pages, and reports open ones separately", () => {
  const summary = summarize([
    session(),
    session({ id: "c2@1", chapterId: "c2", startPage: 4, endPage: 7, pagesRead: 4, durationSeconds: 3 * 60 }),
    session({ id: "c1@2", chapterId: "c1", endedAt: undefined, durationSeconds: undefined, completedChapter: true }),
  ]);
  assert.equal(summary.sessions, 2);
  assert.equal(summary.chapters, 2); // c1 twice is one chapter
  assert.equal(summary.minutes, 9);
  assert.equal(summary.pages, 10 + 4);
  assert.equal(summary.open, 1);
  assert.equal(summary.completed, 0, "an open session's completion is not counted yet");
});

test("a session with no duration falls back to its wall-clock span", () => {
  const summary = summarize([session({ durationSeconds: undefined, startedAt: NOW - 20 * 60_000, endedAt: NOW })]);
  assert.equal(summary.minutes, 20);
});

test("groups by local day, newest first, with today and yesterday named", () => {
  const rows = [
    session({ id: "a", startedAt: NOW - 60_000 }),
    session({ id: "b", startedAt: NOW - DAY }),
    session({ id: "c", startedAt: NOW - 5 * DAY }),
  ];
  const groups = groupByDay(rows, NOW);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].day, "today");
  assert.equal(groups[1].day, "yesterday");
  assert.match(groups[2].day, /^\d{4}-\d{2}-\d{2}$/);
});

test("retention keeps recent closed sessions and every open one", () => {
  const rows = [
    session({ id: "recent" }),
    session({ id: "old", startedAt: NOW - (RETENTION_DAYS + 2) * DAY, endedAt: NOW - (RETENTION_DAYS + 2) * DAY + 60000 }),
    session({ id: "open-old", startedAt: NOW - (RETENTION_DAYS + 2) * DAY, endedAt: undefined }),
  ];
  const kept = pruneSessions(rows, RETENTION_DAYS, NOW).map((row) => row.id);
  assert.deepEqual(kept, ["recent", "open-old"]);
});

test("a retention of zero keeps everything", () => {
  const rows = [session({ id: "a", startedAt: NOW - 5000 * DAY })];
  assert.equal(pruneSessions(rows, 0, NOW).length, 1);
});

test("completion is sticky: re-reading from page 1 does not unread a finished chapter", () => {
  assert.equal(isComplete(undefined), false);
  assert.equal(isComplete({ chapterId: "c", page: 3, total: 10, at: NOW }), false);
  assert.equal(isComplete({ chapterId: "c", page: 9, total: 10, at: NOW }), true);
  assert.equal(isComplete({ chapterId: "c", page: 9, total: 10, at: NOW, completed: true }), true);
  assert.equal(isComplete({ chapterId: "c", page: 1, total: 10, at: NOW, completed: true }), true);
});

test("a session ends on inactivity, not on a glance at another app", () => {
  assert.equal(shouldEndForIdle(INACTIVITY_TIMEOUT_MS - 1), false);
  assert.equal(shouldEndForIdle(INACTIVITY_TIMEOUT_MS), true);
  assert.equal(shouldEndForBackground(BACKGROUND_GRACE_MS - 1), false);
  assert.equal(shouldEndForBackground(BACKGROUND_GRACE_MS), true);
  // The grace is much shorter than the idle timeout: coming back from a notification continues the
  // same sitting, while a chapter left open is not eight hours of reading.
  assert.ok(BACKGROUND_GRACE_MS < INACTIVITY_TIMEOUT_MS);
});

test("pages read and duration are honest in both directions", () => {
  assert.equal(pagesRead(0, 9), 10);
  assert.equal(pagesRead(30, 25), 6);
  assert.equal(pagesRead(7, 7), 1);
  assert.equal(durationSeconds(1000, 91_000), 90);
  assert.equal(durationSeconds(91_000, 1000), 0);
});

test("the unfiltered library is its own view-state key", () => {
  assert.equal(viewStateKey(null), "all");
  assert.equal(viewStateKey(undefined), "all");
  assert.equal(viewStateKey("  "), "all");
  assert.equal(viewStateKey("c:2"), "c:2");
});

test("durations read the way a person says them", () => {
  assert.equal(durationLabel(20_000), "<1m");
  assert.equal(durationLabel(4 * 60_000), "4m");
  assert.equal(durationLabel(72 * 60_000), "1h 12m");
  assert.equal(durationLabel(120 * 60_000), "2h");
});

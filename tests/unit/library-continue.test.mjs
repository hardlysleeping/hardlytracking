import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONTINUE_RULES,
  clampMax,
  eligible,
  nextUnread,
  showsContinue,
} from "../../src/lib/library/continue.ts";

function chapter(id, read = false, number = 1) {
  return { id, seriesId: "s", name: `Chapter ${number}`, number, pageCount: 20, read };
}

function row(seriesId, over = {}) {
  return { seriesId, chapterId: `${seriesId}:ch:1`, page: 0, title: seriesId, ...over };
}

test("nextUnread returns the next unread chapter after the current one", () => {
  const chapters = [chapter("c1", true), chapter("c2", false), chapter("c3", false)];
  assert.equal(nextUnread(chapters, "c1")?.id, "c2");
});

test("nextUnread skips chapters that are already read", () => {
  const chapters = [chapter("c1", true), chapter("c2", true), chapter("c3", false)];
  assert.equal(nextUnread(chapters, "c1")?.id, "c3");
});

test("nextUnread is null at the end of the list, and never wraps", () => {
  const chapters = [chapter("c1", true), chapter("c2", true)];
  assert.equal(nextUnread(chapters, "c2"), null);
  const one = [chapter("only", true)];
  assert.equal(nextUnread(one, "only"), null);
});

test("nextUnread never returns the current chapter, even when it is unread", () => {
  const chapters = [chapter("c1", false), chapter("c2", false)];
  assert.equal(nextUnread(chapters, "c1")?.id, "c2");
});

test("nextUnread is null for an id that is not in the list", () => {
  assert.equal(nextUnread([chapter("c1")], "nope"), null);
  assert.equal(nextUnread([], "c1"), null);
});

test("eligible drops dismissed series and keeps the order", () => {
  const rows = [row("a"), row("b"), row("c")];
  assert.deepEqual(eligible(rows, new Set(["b"])).map((r) => r.seriesId), ["a", "c"]);
});

test("max truncates without reordering, and is clamped to 1–20", () => {
  const rows = [row("a"), row("b"), row("c"), row("d")];
  assert.deepEqual(eligible(rows, new Set(), 2).map((r) => r.seriesId), ["a", "b"]);
  assert.equal(eligible(rows, new Set(), 0).length, 1);
  assert.equal(clampMax(400), 20);
  assert.equal(clampMax(Number.NaN), DEFAULT_CONTINUE_RULES.max);
});

test("the strip is drawn only when it is switched on and has rows", () => {
  assert.equal(showsContinue(true, [row("a")]), true);
  assert.equal(showsContinue(false, [row("a")]), false);
  assert.equal(showsContinue(true, []), false);
});

test("the default rules are the spec's: next unread, 10, small, above", () => {
  assert.deepEqual(DEFAULT_CONTINUE_RULES, { afterFinish: "next-unread", max: 10, size: "small", position: "above" });
});

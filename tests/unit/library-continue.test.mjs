import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONTINUE_COLLAPSED,
  DEFAULT_CONTINUE_RULES,
  clampMax,
  continueCollapsedOf,
  eligible,
  nextUnread,
  seriesOfPosition,
  showsContinue,
} from "../../src/lib/library/continue.ts";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";

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

test("a continue row points at the series that owns its chapter, whatever the row stored", () => {
  // The position row is written from whatever series id the reader was opened under, and a stale
  // link can name another one — `#read/None/<chapter>` is what a bad URL looked like. The chapter
  // mirror knows the truth, so the resume link still carries a series that exists.
  assert.equal(seriesOfPosition("None", { seriesId: "local:file:plastic-man-001-se8t" }), "local:file:plastic-man-001-se8t");
  assert.equal(seriesOfPosition("local:file:old", { seriesId: "local:file:new" }), "local:file:new");
});

test("without a chapter row the stored series id stands", () => {
  // A chapter this device has never mirrored is no reason to blank the link.
  assert.equal(seriesOfPosition("mihon:12", undefined), "mihon:12");
  assert.equal(seriesOfPosition("mihon:12", { seriesId: "" }), "mihon:12");
  assert.equal(seriesOfPosition("mihon:12", {}), "mihon:12");
});

test("the strip starts open, and only the literal true folds it", () => {
  // The pref is new: an older export has no row, and a restored or hand-edited value must not
  // hide the reader's Continue strip on launch.
  assert.equal(DEFAULT_CONTINUE_COLLAPSED, false);
  assert.equal(continueCollapsedOf(undefined), false);
  assert.equal(continueCollapsedOf(null), false);
  assert.equal(continueCollapsedOf("true"), false);
  assert.equal(continueCollapsedOf(1), false);
  assert.equal(continueCollapsedOf(true), true);
});

test("continueCollapsed round-trips through the prefs store under settings.continueCollapsed", async () => {
  const store = new LibraryStore(memoryDatabase());
  // The default is a missing row, not a written false — the same fallback `Settings.load` uses.
  assert.equal(continueCollapsedOf(await store.getPref("settings.continueCollapsed")), DEFAULT_CONTINUE_COLLAPSED);
  await store.setPref("settings.continueCollapsed", true);
  assert.equal(continueCollapsedOf(await store.getPref("settings.continueCollapsed")), true);
  await store.setPref("settings.continueCollapsed", false);
  assert.equal(continueCollapsedOf(await store.getPref("settings.continueCollapsed")), false);
});

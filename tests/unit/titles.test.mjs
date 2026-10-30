import { test } from "node:test";
import assert from "node:assert/strict";
import { chapterLabel, looksLikeId, readableName, seriesLabel } from "../../src/lib/titles.ts";

test("a provider id is recognised as an id, not a name", () => {
  assert.equal(looksLikeId("dalvik:2131019126180322627:/series/01J76XYB8HNWARAQ67A4GAWG5Y/Black-Clover"), true);
  assert.equal(looksLikeId("mihon:12"), true);
  assert.equal(looksLikeId("Black Clover"), false);
  assert.equal(looksLikeId("Chapter 12"), false);
});

test("history never prints a raw id where a title belongs", () => {
  const id = "dalvik:2131019126180322627:/series/01J76XYB8HNWARAQ67A4GAWG5Y/Black-Clover";
  assert.equal(seriesLabel(id), "Unknown title");
  assert.equal(chapterLabel(id), "Chapter");
  assert.equal(seriesLabel(undefined), "Unknown title");
  assert.equal(seriesLabel("   "), "Unknown title");
});

test("a real name passes through untouched", () => {
  assert.equal(seriesLabel("Black Clover"), "Black Clover");
  assert.equal(chapterLabel("Page 392.5"), "Page 392.5");
  assert.equal(readableName("  One Piece  ", "x"), "One Piece");
});

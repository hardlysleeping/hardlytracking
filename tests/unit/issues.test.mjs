import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeReadMarks, stillWanted } from "../../src/lib/issues.ts";
import { chapterTitle } from "../../src/lib/titles.ts";

/** A chapter as the seam hands it over; only the fields these rules read. */
function chapter(id, { name = "", number = -1, read = false } = {}) {
  return { id, seriesId: "s-1", name, number, pageCount: 0, read };
}

test("a read mark from the source and one from this device both count", () => {
  const rows = mergeReadMarks(
    [chapter("a", { read: true }), chapter("b"), chapter("c")],
    [
      { key: "read:b", value: true },
      { key: "read:c", value: false },
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.read),
    [true, true, false],
    "the server's tick survives, this device's tick is added, an explicit false is not a tick",
  );
});

test("only `read:` prefs that are actually true are read marks", () => {
  const rows = mergeReadMarks(
    [chapter("a"), chapter("b"), chapter("c")],
    [
      { key: "sortOrder", value: true },
      { key: "read:", value: true },
      { key: "read:b", value: "true" },
      { key: "read:c", value: 1 },
      { key: undefined, value: true },
    ],
  );
  assert.deepEqual(rows.map((row) => row.read), [false, false, false]);
});

test("merging keeps the order the source sent and does not rewrite rows nobody asked about", () => {
  const original = [chapter("x"), chapter("y")];
  const rows = mergeReadMarks(original, [{ key: "read:y", value: true }]);
  assert.deepEqual(rows.map((row) => row.id), ["x", "y"]);
  assert.equal(rows[0], original[0], "an untouched row is the same object, not a copy");
  assert.equal(original[1].read, false, "the argument is not mutated");
});

test("no prefs at all leaves the list exactly as the source sent it", () => {
  const original = [chapter("a", { read: true })];
  assert.equal(mergeReadMarks(original, []), original);
});

test("an answer for a card that has been left behind is not painted", () => {
  // Open A (token 1), open B (token 2), A answers last: only token 2 may paint.
  assert.equal(stillWanted(1, 2), false);
  assert.equal(stillWanted(2, 2), true);
});

test("a chapter shows its own name, and a number only fills in for a missing one", () => {
  assert.equal(chapterTitle({ name: "Berserk v01 (2003)", number: 1 }), "Berserk v01 (2003)");
  assert.equal(chapterTitle({ name: "Chapter 12", number: 12 }), "Chapter 12");
  assert.equal(chapterTitle({ name: "", number: 7 }), "Chapter 7");
  // An id is not a name: the placeholder wins, then the number.
  assert.equal(chapterTitle({ name: "mihon:ch:9", number: 9 }), "Chapter 9");
  assert.equal(chapterTitle({ name: "", number: 0 }), "Chapter");
  assert.equal(chapterTitle({ name: null, number: null }), "Chapter");
});

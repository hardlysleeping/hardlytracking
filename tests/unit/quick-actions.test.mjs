import { test } from "node:test";
import assert from "node:assert/strict";

import {
  UNCATEGORIZED_ID,
  assignmentLabel,
  DOWNLOAD_LIMIT,
  downloadCandidates,
  downloadLabel,
  pickerModel,
  CHAPTER_TIMEOUT_MS,
  readTarget,
  toggleAssignment,
  withTimeout,
} from "../../src/lib/library/quick-actions.ts";

const categories = [
  { id: "b", name: "Manhwa", order: 1, hidden: false, pinned: false },
  { id: "a", name: "Reading", order: 0, hidden: false, pinned: false },
];

test("a fresh title is uncategorized, and the picker says so", () => {
  const model = pickerModel(categories, {}, [{}, { categoryIds: ["a"] }]);
  assert.equal(model.uncategorized.checked, true, "nothing chosen means uncategorized");
  assert.equal(model.uncategorized.count, 1, "only the title in no category counts");
  assert.deepEqual(
    model.rows.map((row) => [row.name, row.count, row.checked]),
    [
      ["Reading", 1, false],
      ["Manhwa", 0, false],
    ],
    "the user's own order, and no tick anywhere",
  );
});

test("counts are the whole library's, including the title being filed", () => {
  const library = [{ categoryIds: ["a"] }, { categoryIds: ["a", "b"] }, {}];
  const model = pickerModel(categories, { categoryIds: ["a"] }, library);
  assert.equal(model.rows[0].count, 2);
  assert.equal(model.rows[0].checked, true);
  assert.equal(model.rows[1].count, 1);
  assert.equal(model.uncategorized.checked, false, "a title in a shelf is not uncategorized");
  assert.equal(model.uncategorized.count, 1);
});

test("choosing a shelf clears uncategorized, and clearing the last shelf brings it back", () => {
  let selected = [];
  assert.deepEqual(toggleAssignment(selected, "a"), ["a"], "picking a category");
  selected = ["a"];
  assert.deepEqual(toggleAssignment(selected, "b"), ["a", "b"], "categories overlap");
  selected = ["a", "b"];
  assert.deepEqual(toggleAssignment(selected, "a"), ["b"], "unticking one keeps the other");
  selected = ["b"];
  assert.deepEqual(toggleAssignment(selected, "b"), [], "the last one off is uncategorized again");
  // Uncategorized is a state, not a member: asking for it clears everything.
  assert.deepEqual(toggleAssignment(["a", "b"], UNCATEGORIZED_ID), []);
});

test("the subtitle names the shelves, and never counts without a word", () => {
  assert.equal(assignmentLabel([]), "Uncategorized");
  assert.equal(assignmentLabel(["Reading"]), "Reading");
  assert.equal(assignmentLabel(["Reading", "Manhwa"]), "Reading, Manhwa");
  assert.equal(assignmentLabel(["Reading", "Manhwa", "Favourites"]), "3 categories");
});

test("download queues what the device does not hold, and says how much", () => {
  const chapters = [{ id: "1" }, { id: "2" }, { id: "3" }];
  assert.deepEqual(
    downloadCandidates(chapters, (id) => id === "2").map((chapter) => chapter.id),
    ["1", "3"],
  );
  assert.deepEqual(downloadCandidates(chapters, () => true), [], "nothing to do is not a queue");
  assert.equal(downloadLabel(0, false), "Already on this device");
  assert.equal(downloadLabel(1, false), "1 chapter to fetch");
  assert.equal(downloadLabel(4, false), "4 chapters to fetch");
  assert.equal(downloadLabel(4, true), "Checking chapters…");
  // Before the list is in hand the row must not claim the series is already on the device, and the
  // subtitle must never be the row's own title.
  assert.equal(downloadLabel(0, false, false), "For offline reading");
  assert.equal(downloadLabel(0, false, true, true), "Downloading…", "queued is not downloaded");
  for (const line of [downloadLabel(0, false, false), downloadLabel(0, false), downloadLabel(3, false)]) {
    assert.notEqual(line.toLowerCase(), "download", "the subtitle repeats the title otherwise");
  }
});

test("one tap queues a slice, not a 556-chapter series", () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ id: String(index) }));
  assert.equal(downloadCandidates(many, () => false).length, DOWNLOAD_LIMIT, "capped by default");
  assert.equal(downloadCandidates(many, () => false)[0].id, "0", "and it takes from the front");
  assert.equal(downloadCandidates(many, () => false, 3).length, 3, "the caller can ask for a slice");
  assert.equal(downloadCandidates(many, () => false, 0).length, 0, "zero is a valid limit, not 'all'");
});

test("read opens the chapter being read, else the first unread, else the first", () => {
  const chapters = [
    { id: "c1", read: true },
    { id: "c2", read: false },
    { id: "c3", read: false },
  ];
  assert.equal(readTarget(chapters, "c3")?.id, "c3", "resume wins");
  assert.equal(readTarget(chapters, null)?.id, "c2", "first unread, not the first row");
  assert.equal(readTarget(chapters, "gone")?.id, "c2", "a stale position falls back, never throws");
  assert.equal(readTarget([{ id: "x", read: true }], null)?.id, "x", "everything read starts over");
  assert.equal(readTarget([], null), null, "no chapters is the series page, not an empty reader");
});

test("a host that never answers does not leave the tap hanging", async () => {
  const never = new Promise(() => {});
  const started = Date.now();
  const answer = await withTimeout(never, 40, []);
  assert.deepEqual(answer, []);
  assert.ok(Date.now() - started < 1000, "settled on the fallback, not on the promise");

  assert.deepEqual(await withTimeout(Promise.resolve(["a"]), 40, []), ["a"], "a fast answer wins");
  assert.deepEqual(await withTimeout(Promise.reject(new Error("host down")), 40, []), [], "a throw is empty, not fatal");
  assert.equal(CHAPTER_TIMEOUT_MS, 6000, "six seconds, so a slow host is not cut off");
});

import assert from "node:assert/strict";
import test from "node:test";

import { applyCollection, collectionState, hiddenBy, selectAll } from "../../src/lib/library/selection.ts";

const ROWS = [
  { id: "a", categoryIds: ["manga"] },
  { id: "b", categoryIds: ["manga", "fav"] },
  { id: "c", categoryIds: ["fav"] },
  { id: "d", categoryIds: [] },
];

test("select all takes exactly the rows on screen", () => {
  const picked = selectAll([ROWS[0], ROWS[2]]);
  assert.equal(picked.size, 2);
  assert.deepEqual([...picked], ["a", "c"]);
  assert.equal(selectAll([]).size, 0);
});

test("a collection says all, some or none about the titles it is asked about", () => {
  assert.equal(collectionState([], "manga"), "none", "nothing selected is not all");
  assert.equal(collectionState([ROWS[0]], "manga"), "all");
  assert.equal(collectionState([ROWS[0], ROWS[1]], "manga"), "all");
  assert.equal(collectionState([ROWS[0], ROWS[2]], "manga"), "some");
  assert.equal(collectionState([ROWS[2], ROWS[3]], "manga"), "none");
});

test("ticking adds the collection once, unticking removes it", () => {
  assert.deepEqual(applyCollection([], "manga", true), ["manga"]);
  assert.deepEqual(applyCollection(["manga"], "manga", true), ["manga"], "never twice");
  assert.deepEqual(applyCollection(["manga", "fav"], "manga", false), ["fav"]);
  assert.deepEqual(applyCollection(["fav"], "manga", false), ["fav"], "removing what is not there changes nothing");
});

test("the order of a title's collections is kept", () => {
  assert.deepEqual(applyCollection(["fav", "manga"], "fav", false), ["manga"]);
  assert.deepEqual(applyCollection(["fav"], "manga", true), ["fav", "manga"]);
});

test("a change that hides part of a selection names exactly those ids", () => {
  assert.deepEqual(hiddenBy(new Set(["a", "c"]), [ROWS[0]]), ["c"]);
  assert.deepEqual(hiddenBy(new Set(["a"]), ROWS), []);
});

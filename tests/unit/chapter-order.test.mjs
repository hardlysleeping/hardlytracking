import { test } from "node:test";
import assert from "node:assert/strict";
import { flipOrder, orderChapters, orderLabel } from "../../src/lib/chapter-order.ts";

const chapters = [
  { number: 3, name: "Ch. 3" },
  { number: 1, name: "Ch. 1" },
  { number: 2, name: "Ch. 2" },
];

test("newest first really reverses, whatever order the host sent", () => {
  assert.deepEqual(orderChapters(chapters, "newest").map((c) => c.number), [3, 2, 1]);
  assert.deepEqual(orderChapters(chapters, "oldest").map((c) => c.number), [1, 2, 3]);
});

test("a host that already sends ascending still flips to descending", () => {
  const ascending = [
    { number: 1, name: "Ch. 1" },
    { number: 2, name: "Ch. 2" },
  ];
  assert.deepEqual(orderChapters(ascending, "newest").map((c) => c.number), [2, 1]);
});

test("unnumbered chapters go last in both directions", () => {
  const withSpecial = [...chapters, { number: 0, name: "Bonus" }];
  assert.equal(orderChapters(withSpecial, "oldest").at(-1).name, "Bonus");
  assert.equal(orderChapters(withSpecial, "newest").at(-1).name, "Bonus");
});

test("the control's label and its effect agree", () => {
  assert.equal(orderLabel("oldest"), "Oldest first");
  assert.equal(orderLabel(flipOrder("oldest")), "Newest first");
  assert.equal(flipOrder(flipOrder("oldest")), "oldest");
});

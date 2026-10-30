import assert from "node:assert/strict";
import test from "node:test";

import { cleanOrder, moveItem, orderAfterMove } from "../../src/lib/library/order.ts";

test("moving forward puts the item after its target", () => {
  assert.deepEqual(moveItem(["a", "b", "c", "d"], 0, 2), ["b", "c", "a", "d"]);
});

test("moving backward puts the item before its target", () => {
  assert.deepEqual(moveItem(["a", "b", "c", "d"], 3, 1), ["a", "d", "b", "c"]);
});

test("moving onto itself changes nothing, and still returns a new array", () => {
  const list = ["a", "b", "c"];
  const same = moveItem(list, 1, 1);
  assert.deepEqual(same, list);
  assert.notEqual(same, list, "a caller may mutate the result");
});

test("out-of-range indices clamp instead of throwing mid-gesture", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 0, 99), ["b", "c", "a"]);
  assert.deepEqual(moveItem(["a", "b", "c"], -5, 1), ["b", "a", "c"]);
  assert.deepEqual(moveItem([], 0, 3), []);
});

test("a move is a permutation: nothing duplicated, nothing lost", () => {
  const list = ["a", "b", "c", "d", "e"];
  for (let from = 0; from < list.length; from += 1) {
    for (let to = 0; to < list.length; to += 1) {
      const moved = moveItem(list, from, to);
      assert.equal(moved.length, list.length);
      assert.deepEqual([...moved].sort(), [...list].sort());
      assert.equal(new Set(moved).size, moved.length);
    }
  }
});

test("a drag names two ids and the order is what the shelf was drawing", () => {
  assert.deepEqual(orderAfterMove(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(orderAfterMove(["a", "b", "c"], "a", "zzz"), ["a", "b", "c"], "an unknown target is a no-op");
  assert.deepEqual(orderAfterMove(["a"], "gone", "a"), ["a"]);
});

test("a stored order is de-duplicated, so no title can sit on the shelf twice", () => {
  assert.deepEqual(cleanOrder(["a", "b", "a", "", "c", "b"]), ["a", "b", "c"]);
  assert.deepEqual(cleanOrder(undefined), []);
});

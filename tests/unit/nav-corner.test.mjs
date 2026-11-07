/**
 * The floating Back/Forward corner.
 *
 * Bottom right is the default because that is where a thumb already is on a phone held in one hand;
 * the other three exist because that is not true for every hand. A stored value that is not one of
 * the four is the default, not a broken layout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { NAV_CORNER_CHOICES, isNavCorner } = await import("../../src/lib/view-options.ts");

test("there are exactly four corners and every one is offered", () => {
  assert.deepEqual(
    NAV_CORNER_CHOICES.map((choice) => choice.id),
    ["bottom-right", "bottom-left", "top-left", "top-right"],
  );
  for (const choice of NAV_CORNER_CHOICES) {
    assert.equal(isNavCorner(choice.id), true);
    assert.ok(choice.label.trim() !== "", "every corner has a name");
  }
});

test("anything else is not a corner", () => {
  for (const value of ["", "bottom", "RIGHT", "bottom-middle", null, undefined, 3, {}]) {
    assert.equal(isNavCorner(value), false);
  }
});

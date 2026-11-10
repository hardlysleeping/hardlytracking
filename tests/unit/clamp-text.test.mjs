import { test } from "node:test";
import assert from "node:assert/strict";

import { clampToLines } from "../../src/lib/clamp-text.ts";

/** A stand-in for the browser: "fits" means the candidate is no longer than `room` characters. */
const measure = (room) => (candidate) => candidate.length <= room;

test("a title that fits is returned untouched, with no ellipsis", () => {
  assert.equal(clampToLines("Berserk", measure(40)), "Berserk");
});

test("a title that does not fit is cut to the longest prefix that fits, plus an ellipsis", () => {
  const text = "Absolute Superman vs The Black Lantern Corps Annual Deluxe Edition";
  const out = clampToLines(text, measure(30));
  assert.ok(out.length <= 30, `${out.length} chars is over the room`);
  assert.ok(out.endsWith("…"), `no ellipsis: ${out}`);
  assert.equal(out, "Absolute Superman vs The Blac…");
  assert.ok(text.startsWith(out.slice(0, -1)), "the visible text is not a prefix of the real title");
});

test("the cut never leaves a separator dangling before the ellipsis", () => {
  // A comma or a space right before "…" reads as a typo; a half word does not (every browser cuts
  // mid-word when the room runs out), so only the separator is stripped.
  const out = clampToLines("Dragon, Magazine: The Complete Run", measure(12));
  assert.equal(out, "Dragon, Mag…");
  assert.doesNotMatch(out, /[\s,;:.\-–—]…$/, `dangling separator: ${out}`);
  // Land exactly on the separator and it is dropped instead of shown.
  assert.equal(clampToLines("Dragon, Magazine", measure(7)), "Dragon…");
});

test("an unbreakable title still gets an ellipsis rather than a chopped cell", () => {
  // No spaces at all: the loop can only cut inside the word, which is the honest outcome.
  const out = clampToLines("Supercalifragilisticexpialidocious", measure(10));
  assert.ok(out.endsWith("…"), out);
  assert.ok(out.length <= 10, out);
});

test("a box too small for anything still says it is truncated", () => {
  assert.equal(clampToLines("Plastic Man", measure(0)), "…");
});

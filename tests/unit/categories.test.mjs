import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HIDDEN_VIEW_LABELS,
  PIN_VIEW_LABELS,
  PIN_WORDS,
  applyView,
  categoriesOf,
  isHiddenView,
  isPinView,
  nextHiddenView,
  nextPinView,
  normaliseCategories,
  orderedCategories,
  viewSummary,
  visibleCategories,
} from "../../src/lib/categories.ts";

const cats = [
  { id: "c1", name: "Comics", order: 0, hidden: false, pinned: false },
  { id: "c2", name: "Manga", order: 1, hidden: true, pinned: false },
  { id: "c3", name: "Webtoons", order: 2, hidden: false, pinned: true },
  { id: "c4", name: "Doujin", order: 3, hidden: true, pinned: true },
];

const rows = [
  { id: "s1", title: "Uncategorised", categoryIds: [] },
  { id: "s2", title: "In comics", categoryIds: ["c1"] },
  { id: "s3", title: "In hidden manga", categoryIds: ["c2"] },
  { id: "s4", title: "In pinned webtoons", categoryIds: ["c3"] },
  { id: "s5", title: "In hidden+pinned doujin", categoryIds: ["c4"] },
];

test("the eye cycles Hidden -> Revealed -> Only, in the extension's words", () => {
  assert.equal(nextHiddenView("hidden"), "revealed");
  assert.equal(nextHiddenView("revealed"), "only");
  assert.equal(nextHiddenView("only"), "hidden");
  assert.deepEqual(HIDDEN_VIEW_LABELS, { hidden: "Hidden", revealed: "Revealed", only: "Only" });
});

test("the pin cycles Active -> Only -> Hidden, and the words are fixed", () => {
  assert.equal(nextPinView("all"), "only");
  assert.equal(nextPinView("only"), "without");
  assert.equal(nextPinView("without"), "all");
  assert.deepEqual(PIN_VIEW_LABELS, { all: "Active", only: "Only", without: "Hidden" });
  assert.deepEqual(PIN_WORDS, { count: "Pinned", add: "Pin", remove: "Unpin" });
});

test("stored views are validated, so an old or hand-edited value cannot break the rail", () => {
  assert.equal(isHiddenView("only"), true);
  assert.equal(isHiddenView("hidden "), false);
  assert.equal(isPinView("without"), true);
  assert.equal(isPinView("nope"), false);
});

test("pinned categories sort to the top and keep the user's order inside each group", () => {
  assert.deepEqual(
    orderedCategories(cats).map((c) => c.id),
    ["c3", "c4", "c1", "c2"],
  );
  // Unpinning c3 drops it back to its own order (2), behind c1 (0) and c2 (1) — its
  // position is remembered, so unpinning never appends to the end.
  const unpinned = cats.map((c) => (c.id === "c3" ? { ...c, pinned: false } : c));
  assert.deepEqual(
    orderedCategories(unpinned).map((c) => c.id),
    ["c4", "c1", "c2", "c3"],
  );
});

test("the eye decides which categories the rail draws", () => {
  assert.deepEqual(visibleCategories(cats, "hidden").map((c) => c.id), ["c3", "c1"]);
  assert.deepEqual(visibleCategories(cats, "revealed").map((c) => c.id), ["c3", "c4", "c1", "c2"]);
  assert.deepEqual(visibleCategories(cats, "only").map((c) => c.id), ["c4", "c2"]);
});

test("only pinned narrows the category list itself, and the pin outranks the eye", () => {
  // Eye hidden: c1 and c3 are on screen, c3 is pinned, so only pinned leaves just c3.
  assert.deepEqual(visibleCategories(cats, "hidden", "only").map((c) => c.id), ["c3"]);
  // Eye revealed + pin only: the pinned hidden shelf c4 stays and every unpinned one goes — "only
  // pinned" is the narrower request, so it wins where the two marks cross.
  assert.deepEqual(visibleCategories(cats, "revealed", "only").map((c) => c.id), ["c3", "c4"]);
  // Without pinned is the mirror image, in the user's order.
  assert.deepEqual(visibleCategories(cats, "revealed", "without").map((c) => c.id), ["c1", "c2"]);
  // All is the eye alone, and the default keeps every old caller honest.
  assert.deepEqual(visibleCategories(cats, "revealed", "all").map((c) => c.id), ["c3", "c4", "c1", "c2"]);
  assert.deepEqual(visibleCategories(cats, "revealed").map((c) => c.id), ["c3", "c4", "c1", "c2"]);
});

test("hidden categories take their rows out of the library, and put them back when revealed", () => {
  const hidden = applyView(rows, cats, { hiddenView: "hidden", pinView: "all" }).map((r) => r.id);
  assert.deepEqual(hidden, ["s4", "s1", "s2"], "hidden rows out, pinned first, rest in order");

  const revealed = applyView(rows, cats, { hiddenView: "revealed", pinView: "all" }).map((r) => r.id);
  assert.deepEqual(revealed, ["s4", "s5", "s1", "s2", "s3"]);

  const only = applyView(rows, cats, { hiddenView: "only", pinView: "all" }).map((r) => r.id);
  assert.deepEqual(only, ["s5", "s3"], "only the hidden shelf, pinned first");
});

test("a row filed under a hidden and a visible category stays visible", () => {
  const mixed = [...rows, { id: "s6", title: "In manga and webtoons", categoryIds: ["c2", "c3"] }];
  const hidden = applyView(mixed, cats, { hiddenView: "hidden", pinView: "all" }).map((r) => r.id);
  assert.ok(hidden.includes("s6"), "one visible category is enough to stay in the library");
  assert.ok(!hidden.includes("s3"));
  const only = applyView(mixed, cats, { hiddenView: "only", pinView: "all" }).map((r) => r.id);
  assert.ok(!only.includes("s6"), "and it is not on the hidden shelf either");
});

test("an uncategorised row is never hidden by the eye, and is not part of the hidden shelf", () => {
  const hidden = applyView(rows, cats, { hiddenView: "hidden", pinView: "all" }).map((r) => r.id);
  assert.ok(hidden.includes("s1"));
  const only = applyView(rows, cats, { hiddenView: "only", pinView: "all" }).map((r) => r.id);
  assert.ok(!only.includes("s1"));
});

test("the pin view keeps, or drops, rows in pinned categories", () => {
  assert.deepEqual(
    applyView(rows, cats, { hiddenView: "revealed", pinView: "only" }).map((r) => r.id),
    ["s4", "s5"],
  );
  assert.deepEqual(
    applyView(rows, cats, { hiddenView: "revealed", pinView: "without" }).map((r) => r.id),
    ["s1", "s2", "s3"],
  );
});

test("both marks at once: a hidden+pinned row obeys the eye first, the pin second", () => {
  assert.deepEqual(
    applyView(rows, cats, { hiddenView: "hidden", pinView: "only" }).map((r) => r.id),
    ["s4"],
  );
  // The hidden shelf minus pinned leaves the hidden-but-unpinned row.
  assert.deepEqual(
    applyView(rows, cats, { hiddenView: "only", pinView: "without" }).map((r) => r.id),
    ["s3"],
  );
});

test("a row's categories resolve in rail order, pinned first", () => {
  const both = { id: "s9", categoryIds: ["c1", "c3"] };
  assert.deepEqual(categoriesOf(both, cats).map((c) => c.id), ["c3", "c1"]);
});

test("normaliseCategories drops broken rows and keeps order", () => {
  const raw = [
    { id: "b", name: " Second ", order: 1, pinned: true },
    { id: "a", name: "First", order: 0 },
    { id: "a", name: "Duplicate", order: 5 },
    { id: "", name: "No id" },
    { id: "c", name: "   " },
    null,
  ];
  const out = normaliseCategories(raw);
  assert.deepEqual(out.map((c) => [c.id, c.name, c.pinned]), [
    ["a", "First", false],
    ["b", "Second", true],
  ]);
});

test("the summary line is words, not bare numbers", () => {
  assert.equal(viewSummary("hidden", "all", 2, 1), "Hidden 2 · Pinned 1");
  assert.equal(viewSummary("only", "without", 2, 1), "Only 2 · Without pinned 1");
});

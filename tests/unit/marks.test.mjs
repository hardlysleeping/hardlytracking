/**
 * The hide/pin rule, on sources as well as categories.
 *
 * These are the tests that decide whether the owner's requirement is met: hiding a source hides its
 * titles, hiding a category hides its titles, and a title that is only *partly* in a hidden category
 * stays visible (which is what hiding one shelf has always meant here).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { applyMarks, isHidden, isPinned, contextOf, sourceKeyOf, visibleSources, normaliseSourceMarks } = await import(
  "../../src/lib/marks.ts"
);

const categories = [
  { id: "cat:keep", name: "Keep", order: 0, hidden: false, pinned: false },
  { id: "cat:gone", name: "Gone", order: 1, hidden: true, pinned: false },
  { id: "cat:pin", name: "Pinned shelf", order: 2, hidden: false, pinned: true },
];

const marks = [
  { id: "dalvik:src:1", hidden: true, pinned: false },
  { id: "dalvik:src:2", hidden: false, pinned: true },
];

const sourceOf = (seriesId) => sourceKeyOf(seriesId);

function context(overrides = {}) {
  return contextOf({ categories, sources: marks, sourceOf, ...overrides });
}

const rows = [
  { id: "dalvik:1:a", categoryIds: ["cat:keep"] },
  { id: "dalvik:1:b", categoryIds: ["cat:keep"] },
  { id: "dalvik:2:c", categoryIds: [] },
  { id: "dalvik:3:d", categoryIds: ["cat:gone"] },
  { id: "dalvik:3:e", categoryIds: ["cat:gone", "cat:keep"] },
  { id: "dalvik:3:f", categoryIds: [] },
  { id: "mihon:9", categoryIds: [] },
];

test("a hidden source hides its titles, whatever their categories say", () => {
  const kept = applyMarks(rows, context(), { hiddenView: "hidden", pinView: "all" }).map((row) => row.id);
  // dalvik:1 is marked hidden even though its titles sit in a visible category.
  assert.deepEqual(kept, ["dalvik:2:c", "dalvik:3:e", "dalvik:3:f", "mihon:9"]);
});

test("a title only partly in a hidden category stays visible", () => {
  const kept = applyMarks(rows, context(), { hiddenView: "hidden", pinView: "all" }).map((row) => row.id);
  assert.equal(kept.includes("dalvik:3:e"), true);
  assert.equal(kept.includes("dalvik:3:d"), false);
});

test("a title in no category is never hidden by the eye", () => {
  const kept = applyMarks(rows, context(), { hiddenView: "hidden", pinView: "all" }).map((row) => row.id);
  assert.equal(kept.includes("dalvik:3:f"), true);
});

test("revealed shows everything, only shows only what is hidden", () => {
  const revealed = applyMarks(rows, context(), { hiddenView: "revealed", pinView: "all" });
  assert.equal(revealed.length, rows.length);
  const only = applyMarks(rows, context(), { hiddenView: "only", pinView: "all" }).map((row) => row.id);
  assert.deepEqual(only, ["dalvik:1:a", "dalvik:1:b", "dalvik:3:d"]);
});

test("pinned floats to the top, keeping the order it arrived in", () => {
  const kept = applyMarks(rows, context(), { hiddenView: "revealed", pinView: "all" }).map((row) => row.id);
  // dalvik:2 is a pinned source; cat:pin has no members in this fixture.
  assert.deepEqual(kept, ["dalvik:2:c", "dalvik:1:a", "dalvik:1:b", "dalvik:3:d", "dalvik:3:e", "dalvik:3:f", "mihon:9"]);
});

test("the pin view filters: only pinned, and without pinned", () => {
  const only = applyMarks(rows, context(), { hiddenView: "revealed", pinView: "only" }).map((row) => row.id);
  assert.deepEqual(only, ["dalvik:2:c"]);
  const without = applyMarks(rows, context(), { hiddenView: "revealed", pinView: "without" }).map((row) => row.id);
  assert.equal(without.includes("dalvik:2:c"), false);
  assert.equal(without.length, rows.length - 1);
});

test("a category pin floats its titles too", () => {
  const pinned = [{ id: "dalvik:3:f", categoryIds: ["cat:pin"] }, { id: "dalvik:3:d", categoryIds: [] }];
  const kept = applyMarks(pinned, context(), { hiddenView: "revealed", pinView: "all" }).map((row) => row.id);
  assert.deepEqual(kept, ["dalvik:3:f", "dalvik:3:d"]);
});

test("a mihon title is attributed by its mapping, and left alone without one", () => {
  const withMapping = contextOf({
    categories,
    sources: [{ id: "mihon:src:7", hidden: true, pinned: false }],
    sourceOf: (id) => sourceKeyOf(id, "7"),
  });
  assert.equal(isHidden({ id: "mihon:9" }, withMapping), true);
  // No mapping: not attributable, so not hidden — guessing would hide titles for no reason.
  assert.equal(isHidden({ id: "mihon:9" }, context()), false);
});

test("sourceKeyOf reads the app's own id shapes", () => {
  assert.equal(sourceKeyOf("dalvik:42:https://x/y"), "dalvik:src:42");
  assert.equal(sourceKeyOf("dalvik:42:https://x/y", "9"), "dalvik:src:42");
  assert.equal(sourceKeyOf("mihon:12"), undefined);
  assert.equal(sourceKeyOf("mihon:12", "7"), "mihon:src:7");
  assert.equal(sourceKeyOf("local:src:library"), "local:src:library");
  assert.equal(sourceKeyOf("komga:5"), "komga");
  assert.equal(sourceKeyOf(""), undefined);
});

test("pinned is true when the source is pinned, even with no categories", () => {
  assert.equal(isPinned({ id: "dalvik:2:z" }, context()), true);
  assert.equal(isPinned({ id: "dalvik:3:z" }, context()), false);
});

test("the source rail obeys the same three-state eye and pin", () => {
  const sources = [
    { id: "dalvik:src:1" },
    { id: "dalvik:src:2" },
    { id: "dalvik:src:3" },
  ];
  const ids = (view) => visibleSources(sources, marks, view).map((source) => source.id);
  assert.deepEqual(ids({ hiddenView: "hidden", pinView: "all" }), ["dalvik:src:2", "dalvik:src:3"]);
  assert.deepEqual(ids({ hiddenView: "revealed", pinView: "all" }), ["dalvik:src:2", "dalvik:src:1", "dalvik:src:3"]);
  assert.deepEqual(ids({ hiddenView: "only", pinView: "all" }), ["dalvik:src:1"]);
  assert.deepEqual(ids({ hiddenView: "revealed", pinView: "only" }), ["dalvik:src:2"]);
  assert.deepEqual(ids({ hiddenView: "revealed", pinView: "without" }), ["dalvik:src:1", "dalvik:src:3"]);
});

test("a stored mark is read defensively", () => {
  assert.deepEqual(normaliseSourceMarks(null), []);
  assert.deepEqual(normaliseSourceMarks([{ id: "a" }, { id: "a", hidden: true }, { id: "" }, "junk"]), [
    { id: "a", hidden: false, pinned: false },
  ]);
});

test("a migrated title is governed by the source it reads from now, not the one its id spells", async () => {
  const { sourceKeyOfMapping } = await import("../../src/lib/marks.ts");
  const oldSource = sourceKeyOfMapping("dalvik", "1");
  const newSource = sourceKeyOfMapping("dalvik", "2");
  assert.equal(oldSource, "dalvik:src:1");
  assert.equal(newSource, "dalvik:src:2");

  const migrated = { provider: "dalvik", sourceId: "2" };
  // The id still says source 1; the mapping says 2. The mark that applies is 2's.
  assert.equal(sourceKeyOf("dalvik:1:x", migrated), "dalvik:src:2");
  assert.equal(sourceKeyOf("dalvik:1:x"), "dalvik:src:1");

  // Hidden source 1, pinned source 2: the migrated title is pinned and visible, not hidden.
  const marks = [
    { id: "dalvik:src:1", hidden: true, pinned: false },
    { id: "dalvik:src:2", hidden: false, pinned: true },
  ];
  const row = { id: "dalvik:1:x", categoryIds: [] };
  const context = contextOf({ categories, sources: marks, sourceOf: (id) => sourceKeyOf(id, migrated) });
  assert.equal(isHidden(row, context), false);
  assert.equal(isPinned(row, context), true);
});

test("a title migrated onto this device is attributed to this device's own source", async () => {
  const { sourceKeyOfMapping } = await import("../../src/lib/marks.ts");
  // The device source's own id already carries `src:`.
  assert.equal(sourceKeyOfMapping("local", "src:library"), "local:src:library");
  assert.equal(sourceKeyOfMapping("local", ""), "local:src:library");
  assert.equal(sourceKeyOf("mihon:12", { provider: "local", sourceId: "src:library" }), "local:src:library");
});

test("an HT-Server title is attributed to its own source, like a dalvik one", async () => {
  const { sourceKeyOfMapping } = await import("../../src/lib/marks.ts");
  assert.equal(sourceKeyOf("htserver:7:https://pc/manga/x"), "htserver:src:7");
  assert.equal(sourceKeyOfMapping("htserver", "7"), "htserver:src:7");
});

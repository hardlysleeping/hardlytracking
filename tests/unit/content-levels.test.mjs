import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTENT_LEVELS,
  allows,
  effectiveLevel,
  filterByLevel,
  hiddenNotice,
  levelOfSource,
  levelOfWarning,
  levelOr,
} from "../../src/lib/content/levels.ts";

test("the three levels are named the way the review asks for", () => {
  assert.deepEqual(
    CONTENT_LEVELS.map((l) => l.label),
    ["Restricted", "Mature", "Adult"],
  );
  assert.equal(levelOr("nonsense"), "mature", "a stored value from another build falls back");
  assert.equal(levelOr(undefined, "restricted"), "restricted");
  assert.equal(levelOr("adult"), "adult");
});

test("a package's own words decide its level", () => {
  assert.equal(levelOfWarning("SAFE"), "restricted");
  assert.equal(levelOfWarning("MIXED"), "mature");
  assert.equal(levelOfWarning("NSFW"), "adult");
  // Unlabelled is mature: not hidden from Mature, never shown to Restricted.
  assert.equal(levelOfWarning("UNKNOWN"), "mature");
  assert.equal(levelOfWarning(undefined), "mature");
  assert.equal(levelOfSource(true), "adult");
  assert.equal(levelOfSource(false), "mature");
  assert.equal(levelOfSource(undefined), "mature");
});

test("Restricted shows only safe, whatever was declared", () => {
  assert.equal(allows("restricted", "restricted", false), true);
  assert.equal(allows("restricted", "mature", false), false);
  assert.equal(allows("restricted", "adult", true), false);
});

test("Mature adds mixed and unlabelled, never adult", () => {
  assert.equal(allows("mature", "restricted", false), true);
  assert.equal(allows("mature", "mature", false), true);
  assert.equal(allows("mature", "adult", false), false);
});

test("Adult without a declared age behaves as Mature", () => {
  assert.equal(effectiveLevel("adult", false), "mature");
  assert.equal(effectiveLevel("adult", true), "adult");
  assert.equal(effectiveLevel("mature", true), "mature");
  assert.equal(allows("adult", "adult", false), false, "a restored setting is not a declaration");
  assert.equal(allows("adult", "adult", true), true);
});

test("filtering keeps order and drops only what the level hides", () => {
  const items = [
    { name: "a", warning: "SAFE" },
    { name: "b", warning: "NSFW" },
    { name: "c", warning: "MIXED" },
    { name: "d", warning: "UNKNOWN" },
  ];
  const names = (level, declared) =>
    filterByLevel(items, (i) => levelOfWarning(i.warning), level, declared).map((i) => i.name);

  assert.deepEqual(names("restricted", false), ["a"]);
  assert.deepEqual(names("mature", false), ["a", "c", "d"]);
  assert.deepEqual(names("adult", false), ["a", "c", "d"]);
  assert.deepEqual(names("adult", true), ["a", "b", "c", "d"]);
});

test("a filtered list says how much it left out, and where the setting is", () => {
  assert.equal(hiddenNotice(0, "mature"), null);
  assert.equal(hiddenNotice(1, "mature"), "1 adult package hidden — raise Content to Adult in Settings.");
  assert.equal(hiddenNotice(4, "restricted"), "4 packages hidden — they are mixed or adult.");
});

test("the declaration stays home; the level travels", async () => {
  const { default: fs } = await import("node:fs/promises");
  const source = await fs.readFile(new URL("../../src/lib/sync/from-store.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /LOCAL_ONLY_PREFIXES = \[[^\]]*"settings\.adultDeclared"/,
    "a backup must not carry an age declaration to another device",
  );
  assert.doesNotMatch(source, /"settings\.contentLevel"/, "the level itself is a preference and travels");
});

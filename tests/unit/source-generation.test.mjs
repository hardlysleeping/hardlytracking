import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { generations } from "../../src/lib/latest.ts";

const source = readFileSync(new URL("../../src/views/Source.svelte", import.meta.url), "utf8");

test("a newer request makes the older one stale", () => {
  const runs = generations();
  const first = runs.begin();
  assert.equal(runs.isCurrent(first), true);
  const second = runs.begin();
  assert.equal(runs.isCurrent(first), false, "the superseded request still believes it may paint");
  assert.equal(runs.isCurrent(second), true);
});

test("cancelling invalidates everything already in flight without starting anything", () => {
  const runs = generations();
  const inFlight = runs.begin();
  runs.cancel();
  assert.equal(runs.isCurrent(inFlight), false);
  runs.cancel();
  assert.equal(runs.isCurrent(inFlight), false);
});

test("Source claims a generation before its guards, not after", () => {
  const body = /async function run\(next = 1\): Promise<void> \{([\s\S]*?)\n  \}/.exec(source)?.[1] ?? "";
  const claim = body.indexOf("listingRuns.begin()");
  assert.ok(claim !== -1, "run() never claims a generation");
  for (const guard of ["visibility.sourceAllowed(sourceId)", "privacy.revision", "library.profile === null"]) {
    const at = body.indexOf(guard);
    assert.ok(at !== -1, `run() lost its ${guard} guard`);
    assert.ok(claim < at, `run() claims after the ${guard} guard, so an early return leaves the old request live`);
  }
});

test("a stale answer cannot write rows, an error, or the spinner", () => {
  const body = /async function run\(next = 1\): Promise<void> \{([\s\S]*?)\n  \}/.exec(source)?.[1] ?? "";
  const writes = ["items =", "error =", "busy = false"].map((write) => body.indexOf(write));
  assert.ok(writes.every((at) => at !== -1), "a write disappeared from run()");
  const checks = [...body.matchAll(/if \(!current\(\)\) return;/g)].length;
  assert.ok(checks >= 2, `only ${checks} stale check(s): the success path and the catch must both check`);
  assert.match(body, /if \(current\(\)\) busy = false;/, "an older run can still clear the newer run's spinner");
});
test("an empty grid says which emptiness it is", () => {
  // `visibleItems` drops the titles a privacy mark hides while the curtain is on, so a source that
  // answered completely still drew "This source returned nothing" — a statement about the source
  // when the truth was about the curtain.
  assert.match(source, /items\.length === 0[\s\S]{0,320}hidden by your local screen privacy/);
  assert.match(source, /empty=\{emptyText\}/);
});

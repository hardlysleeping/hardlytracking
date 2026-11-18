/**
 * A burst of taps is one decision.
 *
 * Flicking through a pane used to start a detail fetch and a chapter fetch for every title the
 * finger crossed — four round trips thrown away on arrival, each one already paid for on a phone
 * connection or through a Dalvik extension's scraper. The pane now waits for the selection to settle
 * before the remote half starts, and asks twice whether the selection is still the one it was asked
 * about: once before the timer, once after.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SELECTION_SETTLE_MS, settleSelection } from "../../src/lib/selection.ts";

test("a full page does not wait: opening a series is a decision, not a gesture", async () => {
  const started = Date.now();
  assert.equal(await settleSelection(0, () => true), true);
  assert.ok(Date.now() - started < 40, "the zero-wait path actually waited");
});

test("the settle is the documented ~150 ms, not a guess", () => {
  assert.ok(SELECTION_SETTLE_MS >= 100 && SELECTION_SETTLE_MS <= 250, `${SELECTION_SETTLE_MS} ms`);
});

test("a selection that stops moving is the one that loads", async () => {
  let wanted = true;
  assert.equal(await settleSelection(20, () => wanted), true);
});

test("a selection that moves while waiting is dropped without any work", async () => {
  let generation = 1;
  const stillWanted = () => generation === 1;
  const pending = settleSelection(30, stillWanted);
  generation = 2;
  assert.equal(await pending, false);
});

test("a selection that has already moved is dropped before the timer starts", async () => {
  const started = Date.now();
  assert.equal(await settleSelection(200, () => false), false);
  assert.ok(Date.now() - started < 40, "a stale selection still waited");
});

test("five quick picks produce one load, for the last one", async () => {
  let generation = 0;
  const loaded = [];
  const pick = (id) => {
    const mine = ++generation;
    return settleSelection(20, () => mine === generation).then((ok) => {
      if (ok) loaded.push(id);
    });
  };
  await Promise.all(["a", "b", "c", "d", "e"].map(pick));
  assert.deepEqual(loaded, ["e"], `loaded ${JSON.stringify(loaded)}`);
});
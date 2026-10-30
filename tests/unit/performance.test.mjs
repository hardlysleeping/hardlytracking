import { test } from "node:test";
import assert from "node:assert/strict";
import { CPU_LEVELS, DEFAULT_CPU_LEVEL, describeLevel, isCpuLevel, pace, workBudget } from "../../src/lib/performance.ts";

test("levels step the work down, never up", () => {
  const order = ["unrestricted", "balanced", "quiet", "background"];
  const pages = order.map((level) => workBudget(level).downloadConcurrency);
  assert.deepEqual(pages, [4, 3, 2, 1]);
  const warm = order.map((level) => workBudget(level).imageWarmBatch);
  assert.deepEqual(warm, [24, 12, 8, 4]);
});

test("the bottom two levels pace the queue; the top two do not", () => {
  assert.equal(workBudget("unrestricted").pagePacingMs, 0);
  assert.equal(workBudget("balanced").pagePacingMs, 0);
  assert.ok(workBudget("quiet").pagePacingMs > 0);
  assert.ok(workBudget("background").pagePacingMs > workBudget("quiet").pagePacingMs);
});

test("the default is bounded, not unrestricted", () => {
  assert.equal(DEFAULT_CPU_LEVEL, "balanced");
  assert.ok(workBudget(DEFAULT_CPU_LEVEL).downloadConcurrency < workBudget("unrestricted").downloadConcurrency);
});

test("an unknown value from an old export falls back instead of throwing", () => {
  assert.equal(isCpuLevel("balanced"), true);
  assert.equal(isCpuLevel("turbo"), false);
  assert.equal(isCpuLevel(undefined), false);
  assert.equal(workBudget("nonsense").downloadConcurrency, 3);
});

test("every level has a sentence with a number in it", () => {
  for (const level of CPU_LEVELS) {
    assert.match(describeLevel(level.id), /\d+ pages? at a time/);
  }
});

test("pace resolves immediately when the level asks for none", async () => {
  const started = Date.now();
  await pace("unrestricted");
  assert.ok(Date.now() - started < 50);
});

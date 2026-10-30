import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_POLICY_DEFAULT,
  describeCache,
  formatBytes,
  measureCache,
  overLimit,
  planEviction,
} from "../../src/lib/cache/policy.ts";

const MB = 1024 * 1024;
const policy = { ...CACHE_POLICY_DEFAULT, limitBytes: 10 * MB };
const entry = (key, bytes, at, extra = {}) => ({ key, bytes, at, usedAt: at, ...extra });

test("nothing is evicted while the copies fit", () => {
  assert.deepEqual(planEviction([entry("a", 2 * MB, 1), entry("b", 3 * MB, 2)], policy), []);
});

test("the oldest copies go first, and only until the ceiling is met", () => {
  // 12 MB against a 10 MB ceiling: dropping the oldest 4 MB is enough, so the plan stops there.
  const fits = [entry("new", 4 * MB, 30), entry("old", 4 * MB, 10), entry("mid", 4 * MB, 20)];
  assert.deepEqual(planEviction(fits, policy), ["old"]);

  // 18 MB needs two drops before it is under the ceiling.
  const needsTwo = [entry("a", 6 * MB, 10), entry("b", 6 * MB, 20), entry("c", 6 * MB, 30)];
  assert.deepEqual(planEviction(needsTwo, policy), ["a", "b"]);
});

test("unread copies go first when the reader asked to keep only what they have read", () => {
  const rows = [
    entry("read-old", 6 * MB, 10, { usedAt: 90 }),
    entry("unread-new", 6 * MB, 40, { usedAt: 40 }),
  ];
  assert.deepEqual(planEviction(rows, { ...policy, keepRead: false }), ["unread-new"]);
  assert.deepEqual(planEviction(rows, { ...policy, keepRead: true }), ["read-old"]);
});

test("pinned copies are never evicted, and the report says when they alone are over the limit", () => {
  const rows = [entry("pinned", 20 * MB, 1, { pinned: true }), entry("loose", 1 * MB, 2)];
  assert.deepEqual(planEviction(rows, policy), ["loose"]);
  assert.equal(overLimit(rows, policy), true);
  assert.match(describeCache(rows, policy), /pinned/);
});

test("sizes read the way the rest of the app prints them", () => {
  assert.equal(formatBytes(0), "0 KB");
  assert.equal(formatBytes(812 * 1024), "812 KB");
  assert.equal(formatBytes(1.4 * MB), "1.4 MB");
  assert.equal(formatBytes(2 * 1024 * MB), "2.00 GB");
  assert.equal(measureCache([entry("a", 10), entry("b", 5)]), 15);
});

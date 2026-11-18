import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  NEAR_MARGIN,
  observersOpen,
  resetNearViewport,
  watchNear,
  watchedCount,
} from "../../src/lib/near-viewport.ts";

const cover = readFileSync(new URL("../../src/components/Cover.svelte", import.meta.url), "utf8");

let instances = [];

/** The browser's observer, as much of it as the module uses. */
function installFakeObserver() {
  instances = [];
  const margins = [];
  class Fake {
    constructor(callback, options) {
      margins.push(options?.rootMargin);
      this.callback = callback;
      this.targets = new Set();
      instances.push(this);
    }
    observe(target) {
      this.targets.add(target);
    }
    unobserve(target) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
    /** Pretend the browser just reported these entries. */
    report(entries) {
      this.callback(entries, this);
    }
  }
  globalThis.IntersectionObserver = Fake;
  return margins;
}

function target(name) {
  return { name, isIntersecting: false };
}

function cleanup() {
  resetNearViewport();
  delete globalThis.IntersectionObserver;
}

test("a hundred covers share one observer, not a hundred", () => {
  resetNearViewport();
  const margins = installFakeObserver();
  const stops = [];
  for (let index = 0; index < 100; index += 1) stops.push(watchNear(target(index), () => {}));
  assert.equal(instances.length, 1, `${instances.length} observers for 100 covers`);
  assert.equal(observersOpen(), 1);
  assert.equal(watchedCount(), 100);
  assert.deepEqual(margins, [NEAR_MARGIN], "the shared observer invented its own margin");
  for (const stop of stops) stop();
  cleanup();
});

test("only the cover that came into view is told, and only once", () => {
  resetNearViewport();
  installFakeObserver();
  const seen = [];
  const first = target("a");
  const second = target("b");
  watchNear(first, () => seen.push("a"));
  watchNear(second, () => seen.push("b"));
  const shared = instances.at(-1);
  shared.report([{ target: first, isIntersecting: true }]);
  assert.deepEqual(seen, ["a"]);
  shared.report([{ target: first, isIntersecting: true }]);
  assert.deepEqual(seen, ["a"], "a cover that has been seen was told again");
  assert.equal(watchedCount(), 1, "the seen target was left in the watch list");
  assert.equal(shared.targets.has(first), false, "the seen target is still observed");
  cleanup();
});

test("an entry that is not intersecting is not a reason to fetch", () => {
  resetNearViewport();
  installFakeObserver();
  const seen = [];
  const only = target("c");
  watchNear(only, () => seen.push("c"));
  instances.at(-1).report([{ target: only, isIntersecting: false }]);
  assert.deepEqual(seen, []);
  assert.equal(watchedCount(), 1);
  cleanup();
});

test("stopping before or after the callback is safe and removes the watch", () => {
  resetNearViewport();
  installFakeObserver();
  const seen = [];
  const only = target("d");
  const stop = watchNear(only, () => seen.push("d"));
  stop();
  stop();
  assert.equal(watchedCount(), 0);
  instances.at(-1).report([{ target: only, isIntersecting: true }]);
  assert.deepEqual(seen, []);
  cleanup();
});

test("without an observer there is no endless blank rectangle", () => {
  resetNearViewport();
  delete globalThis.IntersectionObserver;
  let called = 0;
  const stop = watchNear(target("e"), () => (called += 1));
  assert.equal(called, 1, "a webview with no observer hid every cover instead of loading it");
  stop();
});

test("Cover does not build observers of its own", () => {
  assert.doesNotMatch(cover, /new IntersectionObserver/, "a per-cover observer is still constructed");
  assert.match(cover, /watchNear\(target,/, "Cover does not use the shared watch");
  assert.match(cover, /stop\(\)/, "Cover never stops watching");
});
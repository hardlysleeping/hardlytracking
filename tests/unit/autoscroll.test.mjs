/**
 * Autoscroll: off until started, honest pace, and it gives up when it should.
 *
 * The pace is a function of elapsed time, not of frames — the bug this prevents is a page that
 * scrolls twice as fast on a 120 Hz panel, or half as fast in a throttled webview. The curves are a
 * multiplier on that pace near the bottom, and the view must stop the loop on every exit a reader can
 * take: touching the page, the app going away, a mode change, a new chapter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  advancePx,
  AUTOSCROLL_CURVES,
  AUTOSCROLL_SPEEDS,
  autoscrollCurveOf,
  autoscrollSpeedOf,
  curveFactor,
  DEFAULT_AUTOSCROLL_CURVE,
  DEFAULT_AUTOSCROLL_SPEED,
  progressOf,
  pxPerSecondOf,
} from "../../src/lib/autoscroll.ts";

const reader = readFileSync(new URL("../../src/views/Reader.svelte", import.meta.url), "utf8");
const settings = readFileSync(new URL("../../src/state/settings.svelte.ts", import.meta.url), "utf8");
const flat = (text) => text.replace(/\s+/g, " ");

test("the pace is the number the setting names, whatever the frame rate", () => {
  // One second of 60 Hz frames and one second of 120 Hz frames must move the same distance.
  let sixty = 0;
  for (let i = 0; i < 60; i += 1) sixty += advancePx(1000 / 60, "steady", "linear", 0);
  let oneTwenty = 0;
  for (let i = 0; i < 120; i += 1) oneTwenty += advancePx(1000 / 120, "steady", "linear", 0);
  const perSecond = pxPerSecondOf("steady");
  assert.ok(Math.abs(sixty - perSecond) < 0.01, `${sixty} ≈ ${perSecond}`);
  assert.ok(Math.abs(oneTwenty - perSecond) < 0.01, `${oneTwenty} ≈ ${perSecond}`);
  // …and the reader spends the fraction rather than dropping it, which is what makes that true.
  assert.match(flat(reader), /autoCarry \+= advancePx\(elapsed, settings\.autoscrollSpeed, settings\.autoscrollCurve, progress\)/);
  assert.match(flat(reader), /const whole = Math\.floor\(autoCarry\);/);
  // A throttled frame is a long frame, not a lost one.
  assert.ok(advancePx(500, "steady", "linear", 0) > 15);
});

test("a clock that goes backwards never scrolls the page back up", () => {
  assert.equal(advancePx(-40, "fast", "linear", 0), 0);
  assert.equal(advancePx(0, "fast", "linear", 0), 0);
  assert.equal(advancePx(Number.NaN, "fast", "linear", 0), 0);
  assert.ok(advancePx(16, "slow", "linear", 0) >= 0);
});

test("the curves only change the last quarter, and each in its own direction", () => {
  assert.equal(curveFactor("linear", 0.4), 1);
  assert.equal(curveFactor("slow-bottom", 0.4), 1);
  assert.equal(curveFactor("fast-bottom", 0.4), 1);
  assert.ok(curveFactor("slow-bottom", 1) < 0.6, "easing out arrives slower");
  assert.ok(curveFactor("fast-bottom", 1) > 2, "speeding up leaves quicker");
  // A progress outside 0..1 is clamped, never compounded.
  assert.equal(curveFactor("slow-bottom", -3), 1);
  assert.equal(curveFactor("fast-bottom", 9), curveFactor("fast-bottom", 1));
});

test("progress is a fraction of what is left to scroll", () => {
  assert.equal(progressOf(0, 4000, 1000), 0);
  assert.equal(progressOf(3000, 4000, 1000), 1);
  assert.equal(progressOf(1500, 4000, 1000), 0.5);
  // A page shorter than the screen is already at the end: there is nothing to autoscroll.
  assert.equal(progressOf(0, 900, 1000), 1);
});

test("a stored or unknown value falls back to the defaults instead of stopping the loop", () => {
  assert.equal(autoscrollSpeedOf("fast"), "fast");
  assert.equal(autoscrollSpeedOf("warp"), DEFAULT_AUTOSCROLL_SPEED);
  assert.equal(autoscrollSpeedOf(undefined), DEFAULT_AUTOSCROLL_SPEED);
  assert.equal(autoscrollCurveOf("slow-bottom"), "slow-bottom");
  assert.equal(autoscrollCurveOf(null), DEFAULT_AUTOSCROLL_CURVE);
  assert.equal(AUTOSCROLL_SPEEDS.length, 4);
  assert.equal(AUTOSCROLL_CURVES.length, 3);
  // Every choice is a real pace: no zero-speed option pretending to be "off".
  for (const option of AUTOSCROLL_SPEEDS) assert.ok(option.pxPerSecond >= 10);
});

test("the preference is validated on load and on every write", () => {
  assert.match(flat(settings), /this\.autoscrollSpeed = autoscrollSpeedOf\(await read<unknown>\("autoscrollSpeed", DEFAULT_AUTOSCROLL_SPEED\)\)/);
  assert.match(flat(settings), /this\.autoscrollCurve = autoscrollCurveOf\(await read<unknown>\("autoscrollCurve", DEFAULT_AUTOSCROLL_CURVE\)\)/);
  assert.match(flat(settings), /key === "autoscrollSpeed" \? autoscrollSpeedOf\(value\)/);
  assert.match(flat(settings), /key === "autoscrollCurve" \? autoscrollCurveOf\(value\)/);
});

test("the reader starts it only on request, and stops it on every exit", () => {
  // Off until started: the state begins false and nothing calls startAuto() on mount.
  assert.match(flat(reader), /let autoRunning = \$state\(false\);/);
  assert.doesNotMatch(flat(reader), /onMount\([^)]*startAuto/);
  // Touching the page takes the wheel back.
  const surface = flat(reader.slice(reader.indexOf("onpointerdown={(event) => {"), reader.indexOf("onpointermove={(event) => tap.move")));
  assert.match(surface, /stopAuto\(\);/);
  // The app going away, and the reader itself closing.
  assert.match(flat(reader), /document\.visibilityState === "hidden"[\s\S]{0,200}stopAuto\(\)/);
  assert.match(flat(reader), /return \(\) => \{ document\.removeEventListener\("visibilitychange", onVisibility\); stopAuto\(\); closeSession\("away"\); \}/);
  // A different reading mode ends the run.
  assert.match(flat(reader), /\$effect\(\(\) => \{ void settings\.readerMode; return \(\) => stopAuto\(\); \}\)/);
  // Reaching the last page stops it: there is nothing left to advance.
  assert.match(flat(reader), /if \(progress >= 1\) \{ stopAuto\(\); return; \}/);
});

test("the control is a button with a pressed state, offered only where it can work", () => {
  assert.match(flat(reader), /const canAutoscroll = \$derived\(settings\.readerMode === "vertical"\)/);
  assert.match(flat(reader), /\{#if canAutoscroll\} <div class="autoline"> <button class="btn" class:on=\{autoRunning\} aria-pressed=\{autoRunning\} onclick=\{toggleAuto\}>/);
  assert.match(flat(reader), /autoRunning \? "Pause autoscroll" : "Autoscroll"/);
  // Speed and curve live in the reader's own sheet, next to the other reading preferences.
  assert.match(flat(reader), /aria-label="Autoscroll speed"/);
  assert.match(flat(reader), /aria-label="How the pace changes near the end"/);
});

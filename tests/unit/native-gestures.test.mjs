import { test } from "node:test";
import assert from "node:assert/strict";

import { DOUBLE_TAP_MS, DOUBLE_TAP_SLOP, installNativeGestures, isDoubleTap, tapOf } from "../../src/lib/native-gestures.ts";

test("a second tap in the same spot, inside the window, is a double tap", () => {
  const at = (time, x = 100, y = 200) => ({ time, x, y });
  assert.equal(isDoubleTap(at(1000), at(1000 + DOUBLE_TAP_MS)), true);
  assert.equal(isDoubleTap(at(1000), at(1000 + DOUBLE_TAP_MS + 1)), false, "past the window");
  // Same time is still a double tap (two events delivered in one frame).
  assert.equal(isDoubleTap(at(1000), at(1000)), true);
  // A tap that moved is a different gesture: another row, or a swipe that ended.
  assert.equal(isDoubleTap(at(1000, 100, 200), at(1100, 100 + DOUBLE_TAP_SLOP + 1, 200)), false);
  assert.equal(isDoubleTap(at(1000, 100, 200), at(1100, 100, 200 + DOUBLE_TAP_SLOP + 1)), false);
  // The first tap is never a double tap.
  assert.equal(isDoubleTap(null, at(1000)), false);
  // Time cannot run backwards.
  assert.equal(isDoubleTap(at(2000), at(1000)), false);
});

test("the tap reader takes a touch point, and falls back to a pointer", () => {
  const touch = { changedTouches: [{ clientX: 12, clientY: 34 }] };
  assert.deepEqual(tapOf(touch, 5), { time: 5, x: 12, y: 34 });
  const pointer = { clientX: 7, clientY: 8 };
  assert.deepEqual(tapOf(pointer, 6), { time: 6, x: 7, y: 8 });
  assert.deepEqual(tapOf({}, 9), { time: 9, x: 0, y: 0 });
});

/** A stand-in for `document`: records listeners and lets a test fire one. */
function fakeTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    fire(type, event) {
      const fn = listeners.get(type);
      if (fn) fn(event);
    },
  };
}

function fakeEvent(point = {}) {
  const event = { ...point, prevented: false, preventDefault() { event.prevented = true; } };
  return event;
}

test("installing cancels a double tap and leaves a single tap alone", () => {
  const target = fakeTarget();
  let clock = 1000;
  const dispose = installNativeGestures(target, { now: () => clock });

  // First tap: nothing to cancel.
  const first = fakeEvent({ clientX: 50, clientY: 60 });
  target.fire("touchend", first);
  assert.equal(first.prevented, false);

  // Second tap 120 ms later, same place: that is the zoom, and it is cancelled.
  clock = 1120;
  const second = fakeEvent({ clientX: 50, clientY: 60 });
  target.fire("touchend", second);
  assert.equal(second.prevented, true);

  // A third tap right after starts a fresh pair rather than being read as another double.
  clock = 1200;
  const third = fakeEvent({ clientX: 50, clientY: 60 });
  target.fire("touchend", third);
  assert.equal(third.prevented, false);

  dispose();
  assert.equal(target.listeners.size, 0, "disposing removes every listener it added");
});

test("a slow second tap and a moved second tap are real presses", () => {
  const target = fakeTarget();
  let clock = 1000;
  installNativeGestures(target, { now: () => clock });

  target.fire("touchend", fakeEvent({ clientX: 10, clientY: 10 }));
  clock = 1000 + DOUBLE_TAP_MS + 50;
  const slow = fakeEvent({ clientX: 10, clientY: 10 });
  target.fire("touchend", slow);
  assert.equal(slow.prevented, false);

  clock = 2000;
  target.fire("touchend", fakeEvent({ clientX: 10, clientY: 10 }));
  clock = 2050;
  const elsewhere = fakeEvent({ clientX: 10 + DOUBLE_TAP_SLOP + 20, clientY: 10 });
  target.fire("touchend", elsewhere);
  assert.equal(elsewhere.prevented, false);
});

test("pinch and double-click are cancelled too", () => {
  const target = fakeTarget();
  installNativeGestures(target);
  for (const type of ["gesturestart", "gesturechange", "gestureend", "dblclick"]) {
    const event = fakeEvent();
    target.fire(type, event);
    assert.equal(event.prevented, true, `${type} must not scale the page`);
  }
});

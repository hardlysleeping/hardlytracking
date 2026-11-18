/**
 * A shelf of titles is one measurement system, not one system per title.
 *
 * `clampText` used to build a `ResizeObserver` and a `document.fonts.ready` hook for every tile it
 * decorated, and to re-run a binary search over the title on each. On a windowed shelf that is
 * bounded, but it is still one observer per title and one full re-measure per title per resize — the
 * "per-title measurement loop" this file exists to keep gone.
 *
 * The DOM is faked here rather than driven through a browser: what is being tested is which work is
 * requested, and a fake counts that exactly. Line breaking is approximated by a characters-per-line
 * rule; the real text cutting is covered by the pure `clampToLines` tests next to this file.
 *
 * The cost being counted is one *measurement run* — the pass that reads the style, sets the box and
 * (when the title is too long) searches for the cut. It starts with `getComputedStyle`, so the fake
 * counts that call per node: a run with nothing to decide still reads the style to decide that, but
 * it never touches the box.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { clampText } from "../../src/lib/clamp-text.ts";

/* ---- a browser, as much of one as this module uses ---- */

const LINE_HEIGHT = 20;
const CHARS_PER_LINE = 10;

const dom = {
  /** Every observer this module built. The assertion is that there is only ever one. */
  observers: [],
  observed: new Set(),
  unobserved: [],
  frames: new Map(),
  frame: 0,
  fontReady: null,
  live: [],
};

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
    dom.observers.push(this);
  }
  observe(node) {
    dom.observed.add(node);
  }
  unobserve(node) {
    dom.observed.delete(node);
    dom.unobserved.push(node);
  }
  disconnect() {
    dom.observed.clear();
  }
  /** Deliver one report, the way the browser would for a changed box. */
  report(node, width) {
    this.callback([{ target: node, contentRect: { width, height: 0 } }], this);
  }
}

globalThis.ResizeObserver = FakeResizeObserver;
globalThis.requestAnimationFrame = (run) => {
  const id = ++dom.frame;
  dom.frames.set(id, run);
  return id;
};
globalThis.cancelAnimationFrame = (id) => dom.frames.delete(id);
globalThis.getComputedStyle = (el) => {
  if (el?.computed !== undefined) el.computed += 1;
  return {
    fontSize: "14px",
    lineHeight: `${LINE_HEIGHT}px`,
    paddingTop: "0px",
    paddingBottom: "0px",
    boxSizing: "content-box",
  };
};

/* The module installs its single `fonts.ready` hook on the first call, so the document exists from
   the start and the promise is resolved by the font test. */
const fontGate = { resolve: () => {} };
globalThis.document = {
  fonts: { ready: new Promise((resolve) => (fontGate.resolve = resolve)) },
};

function flush() {
  const queued = [...dom.frames.values()];
  dom.frames.clear();
  for (const run of queued) run();
}

function node(text, width = 100) {
  const el = {
    textContent: text,
    clientWidth: width,
    style: {},
    /** Measurements run against this node. One per pass. */
    computed: 0,
    /** Text probes inside a measurement. Zero when the title is already known to fit. */
    reads: 0,
    get scrollHeight() {
      this.reads += 1;
      return Math.max(1, Math.ceil((this.textContent.length || 1) / CHARS_PER_LINE)) * LINE_HEIGHT;
    },
    get clientHeight() {
      return Math.min(this.scrollHeight, Number.parseFloat(this.style.maxHeight) || Infinity);
    },
  };
  return el;
}

/** Decorate one title, and remember it so a test leaves no registration behind. */
function decorate(text, lines = 2) {
  const el = node(text);
  const action = clampText(el, { lines, text });
  dom.live.push(action);
  return { el, action };
}

/** Every test starts with an empty registry: a destroyed tile is not measured by anything. */
function cleanup() {
  while (dom.live.length > 0) dom.live.pop().destroy();
  flush();
}

const TITLE = "Absolute Superman vs The Black Labyrinth of Krypton Rising";

/* ---- one observer, one font hook, one pass ---- */

test("a shelf of titles shares one observer instead of building one each", () => {
  try {
    const titles = Array.from({ length: 8 }, () => decorate(TITLE));
    assert.equal(dom.observers.length, 1, `${dom.observers.length} observers were built for 8 titles`);
    for (const { el } of titles) assert.ok(dom.observed.has(el), "a title was not watched");
  } finally {
    cleanup();
  }
});

test("each title is cut once, to the lines it was given", () => {
  try {
    const { el } = decorate(TITLE);
    assert.ok(el.textContent.endsWith("…"), `no ellipsis: ${el.textContent}`);
    assert.ok(el.textContent.length <= CHARS_PER_LINE * 2, "the title is longer than its two lines");
    assert.equal(el.style.maxHeight, `${LINE_HEIGHT * 2}px`);
    assert.equal(el.style.overflow, "hidden");
  } finally {
    cleanup();
  }
});

test("a height-only resize is the module's own doing, so it does not measure again", () => {
  try {
    const { el } = decorate(TITLE);
    const before = el.computed;

    // `max-height` is set by this module, so every title reports a box change after it runs.
    // Reacting to that is the loop this file exists to not have.
    dom.observers[0].report(el, el.clientWidth);
    flush();

    assert.equal(el.computed, before, "a height change re-ran the measurement");
  } finally {
    cleanup();
  }
});

test("a width change is a new line break, so it measures again — once", () => {
  try {
    const { el } = decorate(TITLE);
    const before = el.computed;

    el.clientWidth = 50;
    dom.observers[0].report(el, 50);
    flush();
    assert.ok(el.computed > before, "a re-wrap did not measure the text again");

    const afterWrap = el.computed;
    // The same width reported again is the same answer.
    dom.observers[0].report(el, 50);
    flush();
    assert.equal(el.computed, afterWrap, "an unchanged width measured the text again");
  } finally {
    cleanup();
  }
});

test("the same text at the same width is not searched for twice", () => {
  try {
    const { el, action } = decorate("Berserk");
    const before = el.reads;
    action.update({ lines: 2, text: "Berserk" });
    flush();
    assert.equal(el.reads, before, "an unchanged title was searched again");
    assert.equal(el.textContent, "Berserk");
  } finally {
    cleanup();
  }
});

test("a new title is measured once and shows the new text", () => {
  try {
    const { el, action } = decorate("Berserk");
    const before = el.computed;
    action.update({ lines: 2, text: TITLE });
    flush();
    assert.ok(el.computed > before);
    assert.ok(el.textContent.endsWith("…"), el.textContent);
  } finally {
    cleanup();
  }
});

test("the webfont swap re-measures every live title, and nothing that is gone", () => {
  const live = [decorate(TITLE), decorate(TITLE)];
  const gone = decorate(TITLE);
  gone.action.destroy();
  const before = live.map(({ el }) => el.computed);
  const goneBefore = gone.el.computed;

  fontGate.resolve();
  return document.fonts.ready.then(() => {
    flush();
    for (const [index, { el }] of live.entries()) {
      assert.equal(el.computed, before[index] + 1, "the font swap did not measure this title exactly once");
    }
    assert.equal(gone.el.computed, goneBefore, "a destroyed tile was measured by the font swap");
    cleanup();
  });
});

test("a destroyed tile stops being watched and is no longer measured", () => {
  try {
    const { el, action } = decorate(TITLE);
    const measuredAtDestroy = el.computed;
    action.destroy();
    assert.equal(dom.observed.has(el), false, "a removed tile is still watched");
    assert.ok(dom.unobserved.includes(el));

    dom.observers[0].report(el, 40);
    flush();
    assert.equal(el.computed, measuredAtDestroy, "a destroyed tile was measured");
  } finally {
    cleanup();
  }
});
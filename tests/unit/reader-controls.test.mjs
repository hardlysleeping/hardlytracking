/**
 * The screen the reader actually uses: holding the backlight, and copying a link that can be copied.
 *
 * Both were controls that answered "yes" without doing anything. `keepAwake` was a stored boolean
 * nothing read, so a phone locked mid-page while the switch said on; the copy buttons fired an
 * optional clipboard call and then said "Copied" whether or not anything was written. These tests
 * pin the mechanism, not the wording.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createWakeLock, wakeLockAvailable } from "../../src/lib/wake-lock.ts";
import { copyText } from "../../src/lib/clipboard.ts";

/** A `navigator.wakeLock` that records what was asked of it. */
function fakeApi(answer = "grant") {
  const requests = [];
  const released = [];
  return {
    requests,
    released,
    request(type) {
      requests.push(type);
      if (answer === "refuse") return Promise.reject(new Error("NotAllowedError"));
      let done = false;
      return Promise.resolve({
        get released() {
          return done;
        },
        release() {
          done = true;
          released.push(type);
          return Promise.resolve();
        },
      });
    },
  };
}

function fakeVisibility(initial = "visible") {
  const listeners = new Set();
  let state = initial;
  return {
    listeners,
    get visibilityState() {
      return state;
    },
    set(next) {
      state = next;
      if (next === "visible") for (const listener of listeners) listener();
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("holding asks the platform for a screen lock, and releasing gives it back", async () => {
  const api = fakeApi();
  const lock = createWakeLock({ api, visibility: fakeVisibility() });
  lock.hold();
  await tick();
  assert.deepEqual(api.requests, ["screen"]);
  assert.equal(lock.held, true);
  lock.release();
  assert.deepEqual(api.released, ["screen"]);
  assert.equal(lock.held, false);
});

test("an app that comes back to the foreground asks again, because the platform dropped the lock", async () => {
  const api = fakeApi();
  const visibility = fakeVisibility("hidden");
  const lock = createWakeLock({ api, visibility });
  lock.hold();
  await tick();
  // Hidden: the request is deferred, and asking the platform here would be refused.
  assert.deepEqual(api.requests, []);
  visibility.set("visible");
  await tick();
  assert.deepEqual(api.requests, ["screen"]);
  lock.release();
});

test("a refusal leaves the reader alone instead of throwing", async () => {
  const api = fakeApi("refuse");
  const refusals = [];
  const lock = createWakeLock({ api, visibility: fakeVisibility(), onrefused: (error) => refusals.push(error) });
  lock.hold();
  await tick();
  assert.equal(refusals.length, 1);
  assert.equal(lock.held, false);
  lock.release(); // must stay safe with nothing held
});

test("a lock released while the request was in flight is handed straight back", async () => {
  const api = fakeApi();
  const lock = createWakeLock({ api, visibility: fakeVisibility() });
  lock.hold();
  lock.release();
  await tick();
  assert.deepEqual(api.released, ["screen"], "the granted lock was not left held");
  assert.equal(lock.held, false);
});

test("a shell without the API says so, and holding is a no-op rather than a crash", () => {
  const lock = createWakeLock({ api: null, visibility: null });
  assert.equal(lock.supported, false);
  assert.equal(wakeLockAvailable(null), false);
  lock.hold();
  lock.release();
  assert.equal(lock.held, false);
});

test("copying reports success only when the clipboard took the text", async () => {
  const previous = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => undefined } },
  });
  try {
    assert.deepEqual(await copyText("hello"), { copied: true, via: "clipboard" });
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previous });
  }
});

test("a clipboard that refuses is not a copy", async () => {
  const previous = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async () => {
          throw new Error("NotAllowedError");
        },
      },
    },
  });
  try {
    // No DOM in this runner, so the execCommand fallback cannot help either.
    const result = await copyText("hello");
    assert.equal(result.copied, false);
    assert.equal(result.via, "none");
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previous });
  }
});

test("an empty string is not silently 'copied'", async () => {
  assert.deepEqual(await copyText(""), { copied: false, via: "none" });
});

/**
 * The screens, checked where behaviour cannot be imported: a Svelte component's wiring is only
 * visible in its source, and a control that stops calling the mechanism reads as working.
 */
const reader = readFileSync(new URL("../../src/views/Reader.svelte", import.meta.url), "utf8");
const settings = readFileSync(new URL("../../src/views/Settings.svelte", import.meta.url), "utf8");
const series = readFileSync(new URL("../../src/views/Series.svelte", import.meta.url), "utf8");
const software = readFileSync(new URL("../../src/views/Software.svelte", import.meta.url), "utf8");
const rail = readFileSync(new URL("../../src/components/ContinueRail.svelte", import.meta.url), "utf8");
const pane = readFileSync(new URL("../../src/state/reader-pane.svelte.ts", import.meta.url), "utf8");

test("the reader holds the screen on while a chapter is open", () => {
  assert.match(reader, /createWakeLock\(\)/, "the reader never asks for a wake lock");
  assert.match(reader, /wakeLock\.hold\(\)/, "the reader has no hold call");
  assert.match(reader, /return \(\) => wakeLock\.release\(\)/, "the lock is not released with the chapter");
  assert.match(reader, /settings\.keepAwake && pages\.length > 0/, "the setting and the open chapter are both required");
});

test("a shell that cannot hold the screen says so instead of showing a dead switch", () => {
  assert.match(reader, /wakeLockSupported/, "the reader settings do not mention support");
  assert.match(settings, /wakeLockSupported/, "the settings page does not mention support");
  assert.match(settings, /disabled=\{!wakeLockSupported\}/);
});

test("Restart chapter clears the saved page before it opens the chapter", () => {
  assert.match(pane, /export async function restartChapter/, "there is no restart path");
  assert.match(pane, /setProgress\(chapterId, 0, 0\)/, "the restart does not reset the page");
  assert.match(pane, /setPosition\(seriesId, chapterId, 0\)/, "the restart leaves the remembered position");
  const reset = pane.indexOf("setProgress(chapterId, 0, 0)");
  const open = pane.indexOf("startReading(seriesId, chapterId, allowPane)", reset);
  assert.ok(reset > 0 && open > reset, "the chapter is opened before the page is cleared");
  assert.match(reader, /void readerPane\.reloads/, "a restart of the open chapter would not reload");
  assert.match(rail, /void restartChapter\(seriesId, chapterId\)/, "the menu calls the restart path");
  // The row is `{@const}` over `menuRow`: reading it after the sheet is cleared throws on null.
  const restartAt = rail.indexOf("void restartChapter(seriesId, chapterId)");
  const destructureAt = rail.lastIndexOf("const { seriesId, chapterId } = row;", restartAt);
  assert.ok(destructureAt > 0 && destructureAt < restartAt, "the restart reads the row before clearing the menu");
  assert.doesNotMatch(rail, /menuRow = null;\s*void restartChapter\(row\./, "the null-row restart is back");
});

test("the series copy link reports what the clipboard did", () => {
  assert.match(series, /await copyText\(url\)/, "the series page does not use the copy seam");
  assert.match(series, /result\.copied \? "Link copied\."/, "the series page does not report a refusal");
});

test("the package page offers no link to a host that does not answer", () => {
  // `https://hardlytracking.app` has never resolved. The row and its Copy button are gone; the
  // deep-link parser stays, because that is how a link that does exist would arrive.
  assert.doesNotMatch(software, /canonicalSoftwareUrl/, "the dead canonical link is back on the page");
  assert.doesNotMatch(software, /class="linkrow"/, "the link row is back");
});
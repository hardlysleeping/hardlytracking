/**
 * The short-screen overflow guard runs on WebKit shells only.
 *
 * `main` is a scroll container even when its content fits, and WebKit rubber-bands every scroll
 * container it is handed — an empty Library could be dragged up and down. The guard that flips
 * `overflow-y` to `hidden` for a short screen is therefore a WebKit fix, and it used to run
 * everywhere: a whole-subtree `MutationObserver` plus a measurement pass per mutation on a Linux or
 * Windows webview that never rubber-bands.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isWebKitShell } from "../../src/lib/shell-scroll.ts";

const shell = readFileSync(new URL("../../src/components/AppShell.svelte", import.meta.url), "utf8");

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

test("an iPhone or a Mac shell needs the guard, because WebKit rubber-bands there", () => {
  assert.equal(isWebKitShell("capacitor", IPHONE), true);
  assert.equal(isWebKitShell("capacitor", IPAD), true);
  assert.equal(isWebKitShell("tauri", MAC), true);
});

test("a browser tab, Chromium Android and a Linux or Windows webview do not", () => {
  assert.equal(isWebKitShell("browser", IPHONE), false, "a browser tab owns its own scrolling");
  assert.equal(isWebKitShell("capacitor", ANDROID), false);
  assert.equal(isWebKitShell("tauri", LINUX), false);
  assert.equal(isWebKitShell("tauri", WINDOWS), false);
});

test("the frame no longer carries a whole-subtree mutation observer", () => {
  assert.doesNotMatch(shell, /new MutationObserver/, "the shell still watches every mutation in the frame");
  assert.match(shell, /if \(!isWebKitShell\(detectPlatform\(\), navigator\.userAgent\)\) return;/, "the guard is not gated on the shell");
  assert.match(shell, /new ResizeObserver\(schedule\)/, "the frame no longer watches its own size");
});

test("the guard hands the frame back to CSS when it is torn down", () => {
  assert.match(shell, /el\.style\.removeProperty\("overflow-y"\)/, "a removed guard left overflow-y on the frame");
});
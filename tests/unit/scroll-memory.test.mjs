/**
 * A screen remembers where it was left.
 *
 * The reader is its own route, so opening a chapter unmounts the shell — and with it the list, its
 * scroll position and the page the reader was reading. Back rebuilt the list at the top. The offsets
 * live outside the component now, keyed by the route the shell is given.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { forgetScroll, rememberScroll, scrollFor } from "../../src/lib/scroll-memory.ts";

test("a screen keeps its own place, and a route never left starts at the top", () => {
  forgetScroll();
  assert.equal(scrollFor("#/search:berserk"), 0);
  rememberScroll("#/search:berserk", 1240);
  rememberScroll("#/library", 300);
  assert.equal(scrollFor("#/search:berserk"), 1240);
  assert.equal(scrollFor("#/library"), 300);
  // A different title is a different place.
  assert.equal(scrollFor("#/search:claymore"), 0);
});

test("nothing worth remembering is remembered", () => {
  forgetScroll();
  rememberScroll("", 500);
  rememberScroll("#/library", Number.NaN);
  rememberScroll("#/library", -20);
  assert.equal(scrollFor("#/library"), 0);
  rememberScroll("#/library", 120);
  assert.equal(scrollFor("#/library"), 120);
  forgetScroll();
  assert.equal(scrollFor("#/library"), 0);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const view = readFileSync(new URL("../../src/views/Library.svelte", import.meta.url), "utf8");

test("a failed refresh is a note, word for word", () => {
  assert.match(
    view,
    /const OFFLINE_NOTE = "Your Library is available offline\. Some source updates could not be checked\.";/,
  );
});

test("the refresh catches, and nothing else on the screen depends on it", () => {
  // The rows, covers, collections, progress, unread marks and download badges all come from the
  // local store. Being offline must change exactly one line of text.
  assert.match(view, /async function refreshLibrary\(\): Promise<void> \{\s*try \{/);
  assert.match(view, /\} catch \{\s*offline = true;\s*\}/);
  // A provider that reports instead of throwing is the same situation.
  assert.match(view, /if \(library\.error !== null\) offline = true;/);
  // No path in here clears the shelf.
  const body = view.slice(view.indexOf("async function refreshLibrary"), view.indexOf("const sortSpec"));
  assert.doesNotMatch(body, /library\.library\s*=\s*\[\]/);
});

test("the note is drawn in place, and only when it is true", () => {
  assert.match(view, /\{#if offline\}\s*<p class="offline" role="status">\{OFFLINE_NOTE\}<\/p>\s*\{\/if\}/);
  // In the flow above the grid, not a dialog and not a replacement for the screen.
  const banner = view.indexOf('<p class="offline"');
  const body = view.indexOf('<div class="body">');
  assert.ok(banner > 0 && banner < body);
  assert.doesNotMatch(view, /<dialog[^>]*offline/);
});

test("a successful refresh clears the note", () => {
  assert.match(view, /await recount\(\);\s*offline = false;/);
});

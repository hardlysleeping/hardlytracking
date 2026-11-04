import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const memory = read("src/state/libraryview.svelte.ts");
const view = read("src/views/Library.svelte");
/** Code without comments: a comment may name a bug it is describing without being the bug. */
const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the shelf's memory is module state, not component state", () => {
  // A route change destroys the view; Svelte keeps the module. Component `$state` reset the
  // collection, the query and the search toggle on every Library -> Series -> back.
  assert.match(memory, /export const libraryMemory = \$state<LibraryMemory>\(/);
  assert.match(view, /import \{ libraryMemory \} from "\.\.\/state\/libraryview\.svelte"/);
  assert.doesNotMatch(view, /let selected = \$state/);
  assert.doesNotMatch(view, /let query = \$state/);
});

test("the collection is durable, and written through one setter", () => {
  assert.match(view, /const selected = \$derived\(privacy\.locked.*libraryMemory\.collection/);
  assert.match(view, /function setCollection\(id: string \| null\): void \{\s*libraryMemory\.collection = id;\s*settings\.set\("libraryCollection", id\);/);
  // Every way of choosing a collection goes through it, or the durable copy goes stale.
  assert.doesNotMatch(view, /\(selected = /);
  assert.doesNotMatch(view, /selected = id/);
});

test("the query is session-only: it survives a route change and not a reload", () => {
  assert.match(memory, /query: string;/);
  // Capture writes an empty query on purpose — restoring one reads as an empty library.
  assert.match(view, /query: "",/);
  assert.doesNotMatch(view, /query = row\.query/);
});

test("the offset is read and written on the scroller, not the window", () => {
  // The shell scrolls `main`; `window.scrollY` is always 0, which is why the offset never landed.
  assert.match(view, /function scroller\(\): HTMLElement \| null \{[\s\S]{0,120}document\.querySelector\("main"\)/);
  assert.match(view, /scroll: scroller\(\)\?\.scrollTop \?\? 0/);
  assert.doesNotMatch(code, /window\.scrollY/);
  assert.doesNotMatch(code, /window\.scrollTo/);
  assert.match(view, /box\?\.addEventListener\("scroll", onScroll/);
});

test("the offset is applied after the grid has laid out", () => {
  assert.match(view, /async function restoreScroll\(top: number\): Promise<void> \{\s*await tick\(\);/);
  // A remembered offset wins over the stored row: it is the same page, not a relaunch.
  assert.match(view, /const target = libraryMemory\.scroll \|\| row\.scroll \|\| 0;/);
});

test("a relaunch opens the collection it was left on, a route change keeps the screen", () => {
  assert.match(view, /if \(!libraryMemory\.mounted\) \{[\s\S]{0,400}libraryMemory\.collection = settings\.libraryCollection;/);
});

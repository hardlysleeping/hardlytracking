/**
 * Offline policies are opt-in, additive, and never delete.
 *
 * The three cards behind this file are about *when* to fetch, not what to keep: adding a title,
 * reconciling the categories the reader named, and the guarantee that all of it can be turned off
 * without losing a file that is already on the device.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  describeKeepPolicy,
  keepCategoriesOf,
  missingIssues,
  shouldKeepTitle,
} from "../../src/lib/offline/policy.ts";

const read = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
const flat = (text) => text.replace(/\s+/g, " ");
const library = read("state/library.svelte.ts");
const downloads = read("state/downloads.svelte.ts");
const settings = read("state/settings.svelte.ts");
const panel = read("components/KeepOfflinePanel.svelte");
const sink = read("lib/offline/sink.ts");

const off = { keepOnAdd: false, keepCategories: [] };
const chapter = (n) => ({ id: `c${n}`, name: `Issue ${n}`, number: n, pageCount: 20 });

test("nothing is kept unless a switch says so", () => {
  assert.equal(shouldKeepTitle(off, { id: "a", categoryIds: ["x"] }, "add"), false);
  assert.equal(shouldKeepTitle(off, { id: "a" }, "reconcile"), false);
  assert.equal(describeKeepPolicy(off), "Nothing is downloaded unless you ask");
});

test("adding a title is a separate trigger from a watched category", () => {
  const policy = { keepOnAdd: true, keepCategories: ["comics"] };
  assert.equal(shouldKeepTitle(policy, { id: "a" }, "add"), true);
  assert.equal(shouldKeepTitle(policy, { id: "a" }, "reconcile"), false, "a watched category is what reconcile means");
  assert.equal(shouldKeepTitle({ keepOnAdd: false, keepCategories: ["comics"] }, { id: "a", categoryIds: ["comics"] }, "add"), true);
  assert.equal(shouldKeepTitle({ keepOnAdd: false, keepCategories: ["comics"] }, { id: "a", categoryIds: ["news"] }, "add"), false);
});

test("a category id that no longer exists is dropped, not kept as a rule that cannot fire", () => {
  assert.deepEqual(keepCategoriesOf(["a", "b", "a"], ["a", "b"]), ["a", "b"]);
  assert.deepEqual(keepCategoriesOf(["a", "gone"], ["a"]), ["a"]);
  assert.deepEqual(keepCategoriesOf("a"), []);
  assert.deepEqual(keepCategoriesOf([1, null, "a"], []), ["a"]);
  assert.deepEqual(keepCategoriesOf(undefined), []);
});

test("only missing issues are fetched: complete and queued ones are never asked for twice", () => {
  const chapters = [chapter(1), chapter(2), chapter(3), chapter(4)];
  const missing = missingIssues(chapters, {
    keepOnAdd: false,
    keepCategories: [],
    complete: new Set(["c1"]),
    pending: new Set(["c3"]),
  });
  assert.deepEqual(missing.map((row) => row.id), ["c2", "c4"]);
  // Nothing to do is an empty list, not a re-download.
  assert.deepEqual(missingIssues(chapters, { keepOnAdd: false, keepCategories: [], complete: new Set(["c1", "c2", "c3", "c4"]) }), []);
});

test("adding a title is where the policy is consulted, and it cannot fail the add", () => {
  const save = flat(library.slice(library.indexOf("async save("), library.indexOf("async unsave(")));
  assert.match(save, /if \(shouldKeepTitle\(\{ keepOnAdd: settings\.keepOnAdd, keepCategories: settings\.keepCategories \}, series, "add"\)\) \{ requestKeep\(series\.id\); \}/);
  // The request is fire-and-forget behind a sink, so a failed keep never surfaces as a failed save.
  assert.match(flat(sink), /void sink\?\.keep\(seriesId\)\.catch\(\(\) => \{\}\);/);
  assert.ok(save.indexOf("refreshLibrary()") < save.indexOf("requestKeep("), "the title lands first");
});

test("the queue owns the keep sink, because the dependency must not point back at the library", () => {
  assert.match(flat(downloads), /setKeepSink\(\{ keep: async \(seriesId: string\) => \{/);
  assert.match(flat(downloads), /const missing = missingIssues\(chapters, \{/);
  assert.match(flat(downloads), /downloads\.enqueueMany\(seriesId, missing\)/);
  // Completeness is `isComplete(row)` — a row that exists is not a row that finished.
  assert.match(flat(downloads), /complete: new Set\(downloads\.rows\.filter\(isComplete\)\.map\(\(row\) => row\.chapterId\)\)/);
  // The library imports the sink, never the downloads state.
  assert.doesNotMatch(flat(library), /from "\.\/downloads\.svelte"/);
});

test("keeping the library now touches only the chosen categories, and only what is missing", () => {
  const keep = flat(downloads.slice(downloads.indexOf("async keepLibraryOffline("), downloads.indexOf("cancel(chapterId")));
  assert.match(keep, /shouldKeepTitle\(\{ keepOnAdd: false, keepCategories: settings\.keepCategories \}, row, "reconcile"\)/);
  assert.match(keep, /await this\.fetchSeries\(row\.id, "new"\)/);
  // `new` means never-seen-only; no path here deletes anything.
  assert.doesNotMatch(keep, /remove|delete|clear/);
});

test("the switches are off by default and validated against the categories that exist", () => {
  assert.match(flat(settings), /keepOnAdd = \$state\(false\);/);
  assert.match(flat(settings), /keepCategories = \$state<string\[\]>\(\[\]\);/);
  assert.match(flat(settings), /this\.keepOnAdd = \(await read<boolean>\("keepOnAdd", false\)\) === true;/);
  assert.match(flat(settings), /this\.keepCategories = keepCategoriesOf\(await read<unknown>\("keepCategories", \[\]\)\);/);
  assert.match(flat(settings), /key === "keepCategories" \? keepCategoriesOf\(value\)/);
});

test("the panel says what the switches do, and that turning them off deletes nothing", () => {
  assert.match(describeKeepPolicy({ keepOnAdd: true, keepCategories: [] }), /new titles are kept when you add them — turning this off deletes nothing/);
  assert.match(describeKeepPolicy({ keepOnAdd: false, keepCategories: ["a", "b"] }), /2 categories are kept — turning this off deletes nothing/);
  assert.match(flat(panel), /\{describeKeepPolicy\(\{ keepOnAdd: settings\.keepOnAdd, keepCategories: settings\.keepCategories \}\)\}/);
  assert.match(flat(panel), /onclick=\{\(\) => void keepNow\(\)\}/);
  assert.match(flat(panel), /aria-pressed=\{chosen\.has\(category\.id\)\}/);
});

test("a title whose source is down does not end the pass, and the panel says what it reached", () => {
  const keep = flat(downloads.slice(downloads.indexOf("async keepLibraryOffline("), downloads.indexOf("cancel(chapterId")));
  // The throw used to escape the loop: every title after the failing one was never attempted, and
  // the count of what had already been queued was lost with it.
  assert.match(keep, /try \{/);
  assert.match(keep, /failed \+= 1/);
  assert.match(keep, /return \{ queued, titles, failed \}/);
  // Both halves are reported: what was queued, and what could not be asked.
  assert.match(flat(panel), /Queued \$\{result\.queued\} issue/);
  assert.match(flat(panel), /could not be reached/);
});

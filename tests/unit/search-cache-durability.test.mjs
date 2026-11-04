/**
 * What the device already answered stays answerable.
 *
 * A card opened offline must still list its issues, a title must still show its description, and a
 * query whose source has gone quiet must not replace the last result set with an error. These are
 * the seams the Search view is written against: keys are namespaced inside the one search-cache
 * store, age decides freshness and never visibility, and a failed refresh leaves a painted answer in
 * place instead of clearing it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  detailsCacheKey,
  isFresh,
  issueCacheKey,
  issuesAreCurrent,
  searchCacheKey,
  SEARCH_CACHE_TTL_MS,
  ISSUE_CACHE_TTL_MS,
} from "../../src/lib/search/index.ts";

const view = readFileSync(new URL("../../src/views/Search.svelte", import.meta.url), "utf8");
const flat = (text) => text.replace(/\s+/g, " ");

test("issue and detail keys live in their own namespace of the shared store", () => {
  const seriesId = "archive:dragon-magazine";
  const keys = [searchCacheKey("src-1", "dragon"), issueCacheKey(seriesId), detailsCacheKey(seriesId)];
  assert.equal(new Set(keys).size, 3, "three kinds of answer must not share a key");
  for (const key of keys) assert.ok(key.includes(seriesId) || key.includes("dragon"));
  // Same series, same key, every time: a cache a view cannot find again is not a cache.
  assert.equal(issueCacheKey(seriesId), issueCacheKey(seriesId));
  assert.notEqual(issueCacheKey(seriesId), detailsCacheKey(seriesId));
});

test("age marks a stored list as old without hiding it", () => {
  const now = Date.now();
  const issues = { key: "issues\u0000x", seriesId: "x", chapters: [], at: now - 1000 };
  assert.equal(issuesAreCurrent(issues), true);
  const old = { ...issues, at: now - ISSUE_CACHE_TTL_MS - 1 };
  assert.equal(issuesAreCurrent(old), false, "a day-old list is no longer current…");
  // …but the view still paints it: freshness is a sentence, not a gate.
  const effect = flat(view.slice(view.indexOf("const row = await store.getSearchCache<CachedIssues>")));
  assert.match(effect, /row !== undefined && row\.chapters\.length > 0/);
  assert.doesNotMatch(effect, /issuesAreCurrent/);
  assert.ok(ISSUE_CACHE_TTL_MS > SEARCH_CACHE_TTL_MS, "an issue list outlives a search answer");
});

test("the issue list is read from the device before the source is asked", () => {
  const effect = view.slice(view.indexOf("const store = library.profile?.store ?? null"));
  const deviceRead = effect.indexOf("getSearchCache<CachedIssues>");
  const networkRead = effect.indexOf("await library.chapters(id)");
  assert.ok(deviceRead > 0 && networkRead > deviceRead, "the device answers first");
  // And the source's list is stored for the next visit.
  assert.match(flat(effect), /putSearchCache<CachedIssues>\(issueCacheKey\(id\), \{/);
});

test("a failed refresh keeps the list that is already on screen", () => {
  const start = view.indexOf("let fromDevice = false");
  const effect = flat(view.slice(start, view.indexOf("function toggleSelect", start)));
  assert.match(effect, /if \(fromDevice\) return;/, "no error over a list the device supplied");
  assert.match(effect, /issueError = error instanceof Error/, "a first-ever failure still says why");
});

test("a source that cannot answer falls back to the last result set, and says so", () => {
  assert.match(flat(view), /const remembered = new Map<string, CachedSearch>\(\)/);
  assert.match(flat(view), /remembered\.set\(source\.id, cached\)/);
  const branch = flat(view.slice(view.indexOf("const last = remembered.get(source.id)"), view.indexOf("notice = \"Showing the last answer")));
  assert.match(branch, /last === undefined \? \{ \.\.\.block, state: "error", error: message \}/);
  assert.match(branch, /: \{ \.\.\.block, state: "done", items: last\.items, hasNext: false, error: message \}/);
  assert.match(flat(view), /Showing the last answer from this device; the source did not respond\./);
});

test("turning to a later page is stored as part of the answer", () => {
  const more = flat(view.slice(view.indexOf("async function more("), view.indexOf("const found =")));
  assert.match(more, /const merged = \[\.\.\.block\.items, \.\.\.result\.items\];/);
  assert.match(more, /putSearchCache<CachedSearch>\(key, \{ key, sourceId: block\.source\.id, query: query\.trim\(\), items: merged/);
});

test("Try again clears both the memory copy and the stored list", () => {
  const retry = flat(view.slice(flat(view).indexOf('class="moredesc" onclick={() => { if (record !== null)')));
  assert.match(retry, /issueCache\.delete\(record\.id\)/);
  assert.match(retry, /removeSearchCache\(issueCacheKey\(record\.id\)\)/);
});

test("details are stored after a successful answer and painted from the device otherwise", () => {
  const show = flat(view.slice(view.indexOf("function show("), view.indexOf("function close")));
  assert.match(show, /getSearchCache<CachedDetails>\(detailsCacheKey\(wanted\)\)/);
  assert.match(show, /putSearchCache<CachedDetails>\(detailsCacheKey\(wanted\), \{/);
  const cachedBeforeNetwork = show.indexOf("getSearchCache<CachedDetails>") < show.indexOf(".details(wanted)");
  assert.ok(cachedBeforeNetwork, "the stored description is read before the request");
  // A stored answer must not overwrite a fuller one that already arrived.
  assert.match(show, /if \(row === undefined \|\| shown\?\.id !== wanted \|\| detailed !== null\) return;/);
});

test("the stored shapes match what the view writes", () => {
  // The view writes these literals; the keys it writes them under must be findable again.
  assert.match(
    flat(view),
    /putSearchCache<CachedIssues>\(issueCacheKey\(id\), \{ key: issueCacheKey\(id\), seriesId: id, chapters: list, at: Date\.now\(\),? \}/,
  );
  assert.match(
    flat(view),
    /putSearchCache<CachedDetails>\(detailsCacheKey\(wanted\), \{ key: detailsCacheKey\(wanted\), seriesId: wanted, series: full, at: Date\.now\(\),? \}/,
  );
  assert.match(flat(view), /isFresh\(cached\)/, "search answers still use their own short TTL");
});

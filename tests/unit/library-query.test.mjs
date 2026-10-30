import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyFacts, runQuery } from "../../src/lib/library/query.ts";
import { EMPTY_FILTER } from "../../src/lib/library/filter.ts";
import { DEFAULT_SORT } from "../../src/lib/library/sort.ts";

/** A category row, as the store hands them over. */
function category(id, over = {}) {
  return { id, name: id, order: 0, hidden: false, pinned: false, ...over };
}

function series(id, over = {}) {
  return { id, provider: "mihon", title: id, categoryIds: [], ...over };
}

function state(over = {}) {
  return {
    collection: null,
    filter: EMPTY_FILTER,
    search: { text: "", scope: "category" },
    sort: DEFAULT_SORT,
    ...over,
  };
}

const marks = { hiddenView: "hidden", pinView: "all" };

const hidden = category("hidden", { hidden: true });
const reading = category("reading");
const favorites = category("favorites");

// Two collections, one hidden shelf, and a title on each.
const library = [
  series("Alpha", { title: "Alpha", categoryIds: ["reading"] }),
  series("Beta", { title: "Beta", categoryIds: ["favorites"] }),
  series("Gamma", { title: "Gamma", categoryIds: ["hidden"] }),
  series("Delta", { title: "Delta" }),
];

test("applyView runs first: a row on a hidden shelf is not in the collection at all", () => {
  const facts = emptyFacts();
  const rows = runQuery(
    { series: library, categories: [hidden, reading, favorites], marks },
    state({ collection: "hidden" }),
    facts,
  );
  assert.deepEqual(rows.map((row) => row.id), []);
});

test("the collection runs before the filter: a filter never pulls a row out of another collection", () => {
  const facts = emptyFacts();
  facts.unread.set("Beta", 3);
  facts.unread.set("Alpha", 2);
  const rows = runQuery(
    { series: library, categories: [hidden, reading, favorites], marks },
    state({ collection: "reading", filter: { ...EMPTY_FILTER, unread: "unread" } }),
    facts,
  );
  assert.deepEqual(rows.map((row) => row.id), ["Alpha"]);
});

test("the filter runs before the search: text never brings back a filtered-out row", () => {
  const facts = emptyFacts();
  facts.unread.set("Alpha", 0);
  const rows = runQuery(
    { series: library, categories: [hidden, reading, favorites], marks },
    state({ filter: { ...EMPTY_FILTER, unread: "unread" }, search: { text: "Alpha", scope: "category" } }),
    facts,
  );
  assert.deepEqual(rows.map((row) => row.id), []);
});

test("the search runs before the sort: only matches are sorted, and they are in sort order", () => {
  const facts = emptyFacts();
  const rows = runQuery(
    { series: library, categories: [hidden, reading, favorites], marks },
    state({ search: { text: "ta", scope: "category" }, sort: { key: "title", dir: "desc" } }),
    facts,
  );
  // Every match is present, nothing else is, and the order is the requested one.
  assert.deepEqual(rows.map((row) => row.id), ["Delta", "Beta"]);
});

test("a hidden row is not found by its exact title: applyView precedes the search", () => {
  const facts = emptyFacts();
  const rows = runQuery(
    { series: library, categories: [hidden, reading, favorites], marks },
    state({ search: { text: "Gamma", scope: "category" } }),
    facts,
  );
  assert.deepEqual(rows.map((row) => row.id), []);
});

test("a row the filter dropped stays out whatever the sort key is", () => {
  const facts = emptyFacts();
  facts.downloaded.set("Beta", 4);
  for (const key of ["title", "lastRead", "downloaded", "source"]) {
    const rows = runQuery(
      { series: library, categories: [hidden, reading, favorites], marks },
      state({ filter: { ...EMPTY_FILTER, downloaded: true }, sort: { key, dir: "desc" } }),
      facts,
    );
    assert.deepEqual(rows.map((row) => row.id), ["Beta"], `sort ${key}`);
  }
});

test("an empty query returns every visible row, sorted", () => {
  const facts = emptyFacts();
  const rows = runQuery(
    { series: library, categories: [hidden, reading, favorites], marks },
    state({ sort: { key: "title", dir: "asc" } }),
    facts,
  );
  assert.deepEqual(rows.map((row) => row.id), ["Alpha", "Beta", "Delta"]);
});

test("the pinned shelf floats first, ahead of the title order", () => {
  // Gamma's only category is not in this list, so the eye has nothing to hide it with.
  const facts = emptyFacts();
  const categories = [category("reading", { pinned: true }), category("favorites")];
  const rows = runQuery(
    { series: library, categories, marks },
    state({ sort: { key: "title", dir: "asc" } }),
    facts,
  );
  assert.deepEqual(rows.map((row) => row.id), ["Alpha", "Beta", "Delta", "Gamma"]);
});

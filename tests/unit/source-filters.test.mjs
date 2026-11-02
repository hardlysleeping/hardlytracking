import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activeCount,
  changesFor,
  cleanSelection,
  defaultStateOf,
  describeSelection,
  filterSignature,
  indexIn,
  mapFilters,
  sameState,
  stateOf,
  takesState,
  triStateOr,
  wireChanges,
} from "../../src/lib/source-filters.ts";
import { createMihonProvider, stripApiPrefix } from "../../src/api/mihon.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/suwayomi/filters.json", import.meta.url), "utf8"));

// ---- reading the source's own form -----------------------------------------

test("a form is position-aligned: header, rule and unknown entries keep their slot", () => {
  const filters = mapFilters(fixture.sources.album);
  assert.equal(filters.length, 4);
  assert.deepEqual(filters[0], { kind: "header", name: "Text search only combines with sort!" });
  assert.equal(filters[1].kind, "separator");
  assert.equal(filters[2].kind, "select");
  // Positions are what the runtime reads; the index of a row in this array *is* its position.
  assert.equal(filters[3].name, "Sort Order");
});

test("a select keeps its values and its default index", () => {
  const [, , album] = mapFilters(fixture.sources.album);
  assert.deepEqual(album.values, ["All Authors", "Various Authors", "One Studio", "Another Studio"]);
  assert.equal(album.default, 0);
  assert.deepEqual(defaultStateOf(album), { selectState: 0 });
});

test("a sort keeps its default index and direction", () => {
  const [order] = mapFilters(fixture.sources.local);
  assert.equal(order.kind, "sort");
  assert.deepEqual(order.default, { index: 0, ascending: true });
  assert.deepEqual(defaultStateOf(order), { sortState: { index: 0, ascending: true } });
});

test("a sort marked descending is not quietly made ascending", () => {
  const [order] = mapFilters([{ __typename: "SortFilter", name: "Sort", values: ["A", "B"], sortDefault: { index: 3, ascending: false } }]);
  assert.deepEqual(order.default, { index: 1, ascending: false }); // index clamped, direction kept
});

test("checkbox, text and tri-state carry the source's own starting values", () => {
  const [box, text, tri] = mapFilters(fixture._synthetic);
  assert.deepEqual(box, { kind: "checkbox", name: "Has available chapters", default: true });
  assert.deepEqual(text, { kind: "text", name: "Author", default: "miura" });
  assert.deepEqual(tri, { kind: "tristate", name: "Tags", default: "EXCLUDE" });
});

test("a filter class this build cannot draw is unknown, not dropped", () => {
  const filters = mapFilters(fixture._synthetic);
  assert.deepEqual(filters[3], { kind: "unknown", name: "Advanced" });
  assert.equal(takesState(filters[3]), false);
});

test("a select or sort with no values is not a control", () => {
  const filters = mapFilters([
    { __typename: "SelectFilter", name: "Empty", values: [] },
    { __typename: "SortFilter", name: "Also empty", values: null, sortDefault: { index: 0, ascending: true } },
  ]);
  assert.deepEqual(filters, [
    { kind: "unknown", name: "Empty" },
    { kind: "unknown", name: "Also empty" },
  ]);
});

test("a nonsense default does not poison the form", () => {
  assert.equal(indexIn(undefined, ["a", "b"]), 0);
  assert.equal(indexIn(9, ["a", "b"]), 1);
  assert.equal(indexIn(-3, ["a", "b"]), 0);
  assert.equal(indexIn(1, []), 0);
  assert.equal(triStateOr("MAYBE"), "IGNORE");
  assert.equal(triStateOr("INCLUDE"), "INCLUDE");
});

// ---- holding the user's choices --------------------------------------------

const album = mapFilters(fixture.sources.album);
const local = mapFilters(fixture.sources.local);

test("with nothing stored a row shows the source's default", () => {
  assert.deepEqual(stateOf(album[2], 2, {}), { selectState: 0 });
  assert.deepEqual(stateOf(local[0], 0, {}), { sortState: { index: 0, ascending: true } });
});

test("a stored choice wins over the default", () => {
  assert.deepEqual(stateOf(album[3], 3, { "3": { selectState: 2 } }), { selectState: 2 });
});

test("a stored state of the wrong shape is refused, not coerced", () => {
  assert.deepEqual(stateOf(album[2], 2, { "2": { textState: "hello" } }), { selectState: 0 });
});

test("a header and an unknown filter take no state", () => {
  assert.equal(defaultStateOf(album[0]), null);
  assert.equal(takesState(album[0]), false);
});

test("clean drops what is not a change", () => {
  const cleaned = cleanSelection(album, {
    "0": { selectState: 1 }, // a header: not a control
    "1": { selectState: 1 }, // a separator
    "2": { selectState: 0 }, // the default: no change
    "3": { selectState: 2 }, // a real change
    "7": { selectState: 1 }, // a position the source does not have
  });
  assert.deepEqual(cleaned, { "3": { selectState: 2 } });
  assert.equal(activeCount(cleaned), 1);
});

test("the size of a selection is the number the Filters button shows", () => {
  assert.equal(activeCount({}), 0);
  assert.equal(activeCount({ "2": { selectState: 1 }, "3": { selectState: 1 } }), 2);
});

// ---- sending it back -------------------------------------------------------

test("a change is sent by position, in the source's own order", () => {
  const changes = changesFor(album, { "3": { selectState: 2 }, "2": { selectState: 1 } });
  assert.deepEqual(changes, [
    { position: 2, selectState: 1 },
    { position: 3, selectState: 2 },
  ]);
});

test("a sort is sent as {index, ascending}", () => {
  assert.deepEqual(changesFor(local, { "0": { sortState: { index: 1, ascending: false } } }), [
    { position: 0, sortState: { index: 1, ascending: false } },
  ]);
});

test("nothing changed means nothing sent", () => {
  assert.deepEqual(changesFor(album, {}), []);
  assert.deepEqual(changesFor(album, { "2": { selectState: 0 } }), []);
  assert.deepEqual(wireChanges(undefined), []);
});

test("a string key that is not a position never reaches the wire", () => {
  assert.deepEqual(wireChanges({ nope: { selectState: 1 }, "-1": { selectState: 1 }, "1": { selectState: 1 } }), [
    { position: 1, selectState: 1 },
  ]);
});

test("two equal states compare equal, so a no-op is recognised", () => {
  assert.equal(sameState({ selectState: 1 }, { selectState: 1 }), true);
  assert.equal(sameState({ selectState: 1 }, { selectState: 2 }), false);
  assert.equal(sameState({ selectState: 1 }, { checkBoxState: true }), false);
  assert.equal(sameState({ sortState: { index: 1, ascending: true } }, { sortState: { index: 1, ascending: true } }), true);
  assert.equal(sameState({ triState: "INCLUDE" }, { triState: "EXCLUDE" }), false);
});

// ---- the cache key ---------------------------------------------------------

test("a filter signature is stable and order-free, and differs when the choices differ", () => {
  const a = filterSignature({ "2": { selectState: 1 }, "3": { selectState: 2 } });
  const b = filterSignature({ "3": { selectState: 2 }, "2": { selectState: 1 } });
  assert.equal(a, b);
  assert.notEqual(a, filterSignature({ "2": { selectState: 1 } }));
  assert.equal(filterSignature(undefined), "");
  assert.equal(filterSignature({}), "");
});

test("the footer says what the selection does, by the source's own words", () => {
  const line = describeSelection(album, { "3": { selectState: 2 } });
  assert.match(line, /Sort Order: Date/);
  assert.match(describeSelection(local, { "0": { sortState: { index: 1, ascending: false } } }), /Order by: Date desc/);
});

// ---- through the provider, against a recording transport -------------------

const asset = (path) => `/api/mihon${stripApiPrefix(path)}`;

test("filters() asks for one source's form by its native id", async () => {
  const calls = [];
  const provider = createMihonProvider({
    asset,
    async gql(query, variables) {
      calls.push({ query, variables });
      return { source: { filters: fixture.sources.local } };
    },
  });
  const answer = await provider.filters("mihon:src:1802675169972965535");
  assert.equal(calls[0].variables.id, "1802675169972965535"); // a Long, sent as a string
  assert.match(calls[0].query, /source\(id: \$id\)/);
  assert.match(calls[0].query, /selectDefault: default/); // one response key per type, aliased
  assert.deepEqual(answer, [{ kind: "sort", name: "Order by", values: ["Title", "Date"], default: { index: 0, ascending: true } }]);
});

test("filters() answers an empty list for a source that declares none", async () => {
  const provider = createMihonProvider({ asset, async gql() { return { source: { filters: [] } }; } });
  assert.deepEqual(await provider.filters("mihon:src:1"), []);
});

test("filters() is honest when the runtime has no such source", async () => {
  const provider = createMihonProvider({ asset, async gql() { return { source: null }; } });
  assert.deepEqual(await provider.filters("mihon:src:1"), []);
});

test("a search without filters sends null, not an empty list", async () => {
  const calls = [];
  const provider = createMihonProvider({
    asset,
    async gql(query, variables) {
      calls.push({ query, variables });
      return { fetchSourceManga: { mangas: [], hasNextPage: false } };
    },
  });
  await provider.search("mihon:src:9", "batman", 1);
  assert.equal(calls[0].variables.filters, null);
});

test("a search carries the changes by position", async () => {
  const calls = [];
  const provider = createMihonProvider({
    asset,
    async gql(query, variables) {
      calls.push({ query, variables });
      return { fetchSourceManga: { mangas: [{ id: 1, title: "One" }], hasNextPage: false } };
    },
  });
  const result = await provider.search("mihon:src:9", "", 1, { "2": { selectState: 1 }, "3": { selectState: 2 } });
  assert.deepEqual(calls[0].variables.filters, [
    { position: 2, selectState: 1 },
    { position: 3, selectState: 2 },
  ]);
  assert.match(calls[0].query, /\$filters: \[FilterChangeInput!\]/);
  assert.equal(result.items[0].id, "mihon:1");
});

test("popular is never sent filters: a Mihon extension ignores them outside search", async () => {
  const calls = [];
  const provider = createMihonProvider({
    asset,
    async gql(query, variables) {
      calls.push({ query, variables });
      return { fetchSourceManga: { mangas: [], hasNextPage: false } };
    },
  });
  await provider.popular("mihon:src:9", 1);
  assert.equal(calls[0].variables.filters, null);
  assert.equal(calls[0].variables.type, "POPULAR");
});

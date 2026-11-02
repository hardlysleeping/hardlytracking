/**
 * A source's own filters, as the embedded iPhone runtime answers them.
 *
 * The host does not answer a typed tree — it serialises the extension's Java filter objects — so
 * everything here is about reading a dump by the *shape* of its `state`, and writing a change back
 * in the one form its reader understands (names, not positions; a checkbox's state on its first
 * child; group changes nested, and only the children that changed).
 *
 * Pure: no network, no server, no runtime. The host-shaped case is proved end to end in
 * `dalvik-fixture.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { dalvikChanges, dalvikFilters, mapFilters } from "../../src/lib/source-filters.ts";
import { FILTER_FORMS } from "../fixtures/dalvik-mock.mjs";

/** The form of the fixture's `json` source, normalised the way the provider normalises it. */
const jsonForm = () => mapFilters(dalvikFilters(FILTER_FORMS.json));

test("the host's dump is read by the shape of `state`, one row per filter", () => {
  const rows = jsonForm();
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["checkbox", "header", "checkbox", "checkbox", "checkbox", "sort", "select", "header", "tristate", "tristate"],
    "a group is flattened: its name a header, each child a row of its own",
  );
  assert.deepEqual(rows[0], { kind: "checkbox", name: "Has available chapters", default: false });
  assert.deepEqual(rows[1], { kind: "header", name: "Content rating" });
  assert.deepEqual(
    rows.slice(2, 5),
    [
      { kind: "checkbox", name: "Safe", default: true, group: "Content rating" },
      { kind: "checkbox", name: "Suggestive", default: true, group: "Content rating" },
      { kind: "checkbox", name: "Pornographic", default: false, group: "Content rating" },
    ],
  );
  assert.deepEqual(rows[5], {
    kind: "sort",
    name: "Sort",
    values: ["Title", "Number"],
    default: { index: 0, ascending: true },
  });
  assert.deepEqual(rows[6], { kind: "select", name: "Created within last", values: ["Any", "Day", "Week"], default: 0 });
  assert.deepEqual(rows[8], { kind: "tristate", name: "Action", default: "IGNORE", group: "Genre" });
});

test("a select whose labels are the extension's own objects still reads as a select", () => {
  const rows = mapFilters(
    dalvikFilters([
      { name: "Tags mode", state: 1, values: [{ a: "And", b: "AND" }, { a: "Or", b: "OR" }] },
      { name: "Number only", state: 0 },
    ]),
  );
  assert.deepEqual(rows[0], { kind: "select", name: "Tags mode", values: ["And", "Or"], default: 1 });
  assert.deepEqual(rows[1], { kind: "tristate", name: "Number only", default: "IGNORE" }, "a number with no values is a tri-state");
});

test("a sort whose labels live in the extension's own field is still a sort", () => {
  const rows = mapFilters(
    dalvikFilters([{ name: "Sort", state: { index: 1, ascending: false }, a: [{ a: "Relevance", b: "relevance" }, { a: "Year", b: "year" }] }]),
  );
  assert.deepEqual(rows[0], { kind: "sort", name: "Sort", values: ["Relevance", "Year"], default: { index: 1, ascending: false } });
});

test("what cannot be set is kept visible as unknown, never drawn as a control", () => {
  const rows = mapFilters(
    dalvikFilters([
      // A group whose child is text: the host assigns `state = child.name` for those, so nothing
      // sent could ever change it.
      { name: "Words", state: [{ name: "Query", state: "" }] },
      // A group inside a group.
      { name: "Outer", state: [{ name: "Inner", state: [{ name: "Deep", state: false }] }] },
      // A header and a separator are both `{name}`, and cannot be told apart.
      { name: "Narrow it down" },
    ]),
  );
  assert.deepEqual(
    rows.map((row) => `${row.kind}:${row.name}${row.group === undefined ? "" : `@${row.group}`}`),
    ["header:Words", "unknown:Query", "header:Outer", "unknown:Inner", "header:Narrow it down"],
  );
});

test("an answer that is not a list is no form at all", () => {
  assert.deepEqual(mapFilters(dalvikFilters([])), []);
  assert.deepEqual(mapFilters(dalvikFilters(undefined)), []);
  assert.deepEqual(mapFilters(dalvikFilters(null)), []);
  assert.deepEqual(dalvikFilters([null, 7, { name: "x", state: true }]).length, 1, "junk entries are not rows");
});

test("a checkbox is sent back on its first child, because that is where the host reads it", () => {
  const rows = jsonForm();
  assert.deepEqual(dalvikChanges(rows, { "0": { checkBoxState: true } }), [
    {
      name: "Has available chapters",
      type: "checkbox",
      stateList: [{ name: "Has available chapters", type: "checkbox", stateBoolean: true }],
    },
  ]);
});

test("a select, a sort and a tri-state each carry the field the host reads", () => {
  const rows = jsonForm();
  assert.deepEqual(dalvikChanges(rows, { "5": { sortState: { index: 1, ascending: false } } }), [
    { name: "Sort", type: "sort", stateSort: { index: 1, ascending: false } },
  ]);
  assert.deepEqual(dalvikChanges(rows, { "6": { selectState: 2 } }), [{ name: "Created within last", type: "select", stateInt: 2 }]);
  assert.deepEqual(dalvikChanges(rows, { "8": { triState: "INCLUDE" } }), [
    { name: "Genre", type: "group", stateList: [{ name: "Action", type: "tristate", stateInt: 1 }] },
  ]);
});

test("a group change carries only the children that changed, in one entry", () => {
  const rows = jsonForm();
  assert.deepEqual(dalvikChanges(rows, { "2": { checkBoxState: false }, "4": { checkBoxState: true } }), [
    {
      name: "Content rating",
      type: "group",
      stateList: [
        { name: "Safe", type: "checkbox", stateBoolean: false },
        { name: "Pornographic", type: "checkbox", stateBoolean: true },
      ],
    },
  ]);
});

test("a change equal to the source's own default is not a change", () => {
  const rows = jsonForm();
  assert.deepEqual(dalvikChanges(rows, { "0": { checkBoxState: false } }), [], "the checkbox is already off");
  assert.deepEqual(dalvikChanges(rows, { "5": { sortState: { index: 0, ascending: true } } }), [], "the sort is already title asc");
  assert.deepEqual(dalvikChanges(rows, { "98": { checkBoxState: true } }), [], "a position the source does not have is dropped");
  assert.deepEqual(dalvikChanges(rows, { "2": { selectState: 1 } }), [], "a state of the wrong kind is dropped, not coerced");
});

test("a text filter travels as text, and a checkbox next to it still uses the child form", () => {
  const rows = mapFilters(dalvikFilters(FILTER_FORMS.html));
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["header", "text", "checkbox"],
  );
  assert.deepEqual(dalvikChanges(rows, { "1": { textState: "Fixture" } }), [{ name: "Author", type: "text", stateString: "Fixture" }]);
  assert.deepEqual(dalvikChanges(rows, { "2": { checkBoxState: true } }), [
    { name: "Finished only", type: "checkbox", stateList: [{ name: "Finished only", type: "checkbox", stateBoolean: true }] },
  ]);
});

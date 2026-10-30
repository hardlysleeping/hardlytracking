import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIDGE_CONTEXT,
  applyStored,
  manualField,
  prefStoreKey,
  readPrefSchema,
  storedFields,
  wirePreference,
  wirePreferences,
} from "../../src/lib/extensions/prefs.ts";

/** The shape `preferencesManga` actually answers with, trimmed to one of each kind. */
const SCHEMA = [
  { key: "Address", editTextPreference: { title: "Address", summary: "Where Komga lives", value: "" } },
  { key: "Data saver", switchPreferenceCompat: { title: "Data saver", summary: "Smaller images", value: false } },
  {
    key: "Cover quality",
    listPreference: {
      title: "Cover quality",
      valueIndex: 0,
      entries: ["Original", "Medium", "Low"],
      entryValues: ["", ".512.jpg", ".256.jpg"],
    },
  },
  {
    key: "Default libraries",
    multiSelectListPreference: { title: "Libraries", entries: ["Manga", "Comics"], entryValues: ["1", "2"] },
  },
  { key: "Colour", colorPreference: { title: "Colour", value: "#fff" } },
];

test("every declared preference kind becomes a field, and an unknown kind is dropped", () => {
  const fields = readPrefSchema(SCHEMA);
  assert.deepEqual(
    fields.map((field) => [field.key, field.kind]),
    [
      ["Address", "text"],
      ["Data saver", "switch"],
      ["Cover quality", "select"],
      ["Default libraries", "multi"],
    ],
  );
  assert.equal(fields[2].value, "", "a select starts on the value its index points at");
});

test("the wire shape is the runtime's nested one, not {key, value}", () => {
  assert.deepEqual(wirePreference({ key: "Address", kind: "text", title: "Address", value: "http://x" }), {
    key: "Address",
    editTextPreference: { value: "http://x" },
  });
  assert.deepEqual(wirePreference({ key: "S", kind: "switch", title: "S", value: true }), {
    key: "S",
    switchPreferenceCompat: { value: true },
  });
  assert.deepEqual(
    wirePreference({ key: "Q", kind: "select", title: "Q", value: ".256.jpg", entryValues: ["", ".512.jpg", ".256.jpg"] }),
    { key: "Q", listPreference: { valueIndex: 2, entryValues: ["", ".512.jpg", ".256.jpg"] } },
  );
  assert.deepEqual(wirePreference({ key: "M", kind: "multi", title: "M", value: ["2"] }), {
    key: "M",
    multiSelectListPreference: { values: ["2"] },
  });
});

test("a select value that is not in the list falls back to the first entry instead of index -1", () => {
  const wire = wirePreference({ key: "Q", kind: "select", title: "Q", value: "gone", entryValues: ["a", "b"] });
  assert.equal(wire.listPreference.valueIndex, 0);
});

test("the snapshot is sent as the truth, so an edited value can overwrite the runtime's copy", () => {
  const wire = wirePreferences([{ key: "Address", kind: "text", title: "Address", value: "http://y" }]);
  assert.equal(wire[0].key, "__mangayomi_bridge_context__");
  assert.equal(wire[0].preferenceApplyMode, "replace-present");
  assert.deepEqual(wire[1], { key: "Address", editTextPreference: { value: "http://y" } });
  assert.equal(BRIDGE_CONTEXT.preferenceApplyMode, "replace-present");
});

test("a stored value wins over the extension's default, and keeps its type", () => {
  const fields = readPrefSchema(SCHEMA);
  const stored = { Address: "http://komga:25600", "Data saver": true, "Default libraries": ["2"] };
  const merged = applyStored(fields, stored);
  assert.equal(merged[0].value, "http://komga:25600");
  assert.equal(merged[1].value, true, "a switch stays a boolean, so it is not written back as 'true'");
  assert.deepEqual(merged[3].value, ["2"]);
  assert.equal(merged[2].value, "", "an unstored field keeps the default");
});

test("what is stored can be drawn before the runtime answers again", () => {
  const fields = storedFields(readPrefSchema(SCHEMA));
  assert.deepEqual(fields.map((field) => field.kind), ["text", "switch", "select", "multi"]);
  assert.equal(fields[0].title, "Address", "the title travels, so a settings screen needs no schema");
});

test("settings are keyed by the source id the provider has at call time", () => {
  assert.equal(prefStoreKey("4508733312114627536"), "prefs:4508733312114627536");
});

test("a named setting is a text field, for a screen the runtime cannot build", () => {
  assert.deepEqual(manualField("Address", "http://komga:25600"), {
    key: "Address",
    kind: "text",
    title: "Address",
    value: "http://komga:25600",
  });
});

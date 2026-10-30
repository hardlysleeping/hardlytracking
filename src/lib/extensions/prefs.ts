/**
 * An extension's settings, as the runtime describes them and as it wants them back.
 *
 * Mihon extensions declare a preference screen (`setupPreferenceScreen`) and read the values from
 * their own `SharedPreferences`. A reader that never shows that screen cannot use a source whose
 * address or login lives in it — which is every self-hosted one, Komga and Suwayomi included.
 *
 * Three shapes matter and they are all different:
 *
 *   schema   what `preferencesManga` answers: `[{ key, listPreference: { title, valueIndex, … } }]`
 *   stored   what this device keeps:          `{ "Address": "http://…", "Data saver": false }`
 *   wire     what a call carries:             `[{ key, editTextPreference: { value: "http://…" } }]`
 *
 * The wire shape is the runtime's, not a guess: `MihonInvoker.applyPreferences` reads the nested
 * object by preference type and writes the primitive into the extension's store. Sending
 * `{ key, value }` is silently ignored, which reads in the UI as "the setting did not stick".
 */

export type PrefKind = "text" | "switch" | "select" | "multi";

export interface PrefField {
  key: string;
  kind: PrefKind;
  title: string;
  summary?: string;
  /** Human labels, for `select` and `multi`. */
  entries?: string[];
  /** The values those labels stand for; `select` writes one of these, never the label. */
  entryValues?: string[];
  value: string | boolean | string[];
}

/** One entry of `preferencesManga`, kept loose because extensions differ by version. */
type RawPref = Record<string, unknown>;

function asObject(value: unknown): RawPref | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RawPref) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function strList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length === value.length ? items : undefined;
}

/**
 * The runtime's schema, as fields this app can draw.
 *
 * A preference type we do not know is dropped rather than guessed at: drawing a text box over a
 * colour picker would write a string where the extension expects an int, and the failure would
 * surface later as a source that "stopped working".
 */
export function readPrefSchema(raw: unknown): PrefField[] {
  if (!Array.isArray(raw)) return [];
  const fields: PrefField[] = [];
  for (const item of raw) {
    const entry = asObject(item);
    const key = entry === undefined ? undefined : str(entry.key);
    if (entry === undefined || key === undefined) continue;

    const text = asObject(entry.editTextPreference);
    if (text !== undefined) {
      fields.push({
        key,
        kind: "text",
        title: str(text.title) ?? key,
        ...(str(text.summary) === undefined ? {} : { summary: str(text.summary) as string }),
        value: str(text.value) ?? "",
      });
      continue;
    }

    const toggle = asObject(entry.switchPreferenceCompat) ?? asObject(entry.checkBoxPreference);
    if (toggle !== undefined) {
      fields.push({
        key,
        kind: "switch",
        title: str(toggle.title) ?? key,
        ...(str(toggle.summary) === undefined ? {} : { summary: str(toggle.summary) as string }),
        value: toggle.value === true,
      });
      continue;
    }

    const list = asObject(entry.listPreference);
    if (list !== undefined) {
      const entries = strList(list.entries) ?? [];
      const entryValues = strList(list.entryValues) ?? [];
      const index = typeof list.valueIndex === "number" ? list.valueIndex : 0;
      fields.push({
        key,
        kind: "select",
        title: str(list.title) ?? key,
        ...(str(list.summary) === undefined ? {} : { summary: str(list.summary) as string }),
        entries,
        entryValues,
        value: entryValues[index] ?? entryValues[0] ?? "",
      });
      continue;
    }

    const multi = asObject(entry.multiSelectListPreference);
    if (multi !== undefined) {
      fields.push({
        key,
        kind: "multi",
        title: str(multi.title) ?? key,
        ...(str(multi.summary) === undefined ? {} : { summary: str(multi.summary) as string }),
        entries: strList(multi.entries) ?? [],
        entryValues: strList(multi.entryValues) ?? [],
        value: strList(multi.values) ?? [],
      });
    }
  }
  return fields;
}

/** One field as the runtime applies it. */
export function wirePreference(field: PrefField): Record<string, unknown> {
  switch (field.kind) {
    case "text":
      return { key: field.key, editTextPreference: { value: String(field.value) } };
    case "switch":
      return { key: field.key, switchPreferenceCompat: { value: field.value === true } };
    case "select": {
      const values = field.entryValues ?? [];
      const at = values.indexOf(String(field.value));
      // A value that is not in the list cannot be expressed as an index; the first entry is what the
      // extension itself would have chosen on a fresh install.
      return { key: field.key, listPreference: { valueIndex: at >= 0 ? at : 0, entryValues: values } };
    }
    case "multi":
      return { key: field.key, multiSelectListPreference: { values: Array.isArray(field.value) ? field.value : [] } };
  }
}

/**
 * The bridge context entry.
 *
 * Without `replace-present` the runtime refuses to overwrite a value the extension already stored
 * itself, so an edited address would be applied once and then ignored forever. This app is the
 * authority for these values, so every call sends them as the truth.
 */
export const BRIDGE_CONTEXT: Record<string, unknown> = {
  key: "__mangayomi_bridge_context__",
  preferenceApplyMode: "replace-present",
};

/** The whole snapshot, ready to ride on a call. */
export function wirePreferences(fields: PrefField[]): Array<Record<string, unknown>> {
  return [BRIDGE_CONTEXT, ...fields.map(wirePreference)];
}

/**
 * Where a source's settings live in this device's store.
 *
 * Keyed by the source id alone, because a source id is minted by the extension and is unique to it
 * — and because the provider only ever has the source id when it is about to make a call.
 */
export function prefStoreKey(sourceId: string): string {
  return `prefs:${sourceId}`;
}

/** Stored values, as the schema's fields. A stored value wins over the extension's default. */
export function applyStored(fields: PrefField[], stored: Record<string, unknown> | undefined): PrefField[] {
  if (stored === undefined) return fields;
  return fields.map((field) => {
    const value = stored[field.key];
    if (value === undefined || value === null) return field;
    if (field.kind === "switch") return { ...field, value: value === true };
    if (field.kind === "multi") return { ...field, value: Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : field.value };
    return { ...field, value: String(value) };
  });
}

/**
 * What to keep after the user edits.
 *
 * The kind is kept with the value: a switch stored as `"true"` would be written back as a string
 * into a `boolean` slot, and the extension would read its default forever. Titles are kept so the
 * settings screen can draw itself before the runtime answers — or at all, when it cannot.
 */
export function storedFields(fields: PrefField[]): PrefField[] {
  // Every array is copied, not referenced: a field can come straight out of a Svelte rune, and a
  // rune proxy cannot be structured-cloned into IndexedDB (`DataCloneError`) — the write would
  // vanish with no error on screen.
  return fields.map((field) => ({
    key: field.key,
    kind: field.kind,
    title: field.title,
    value: Array.isArray(field.value) ? [...field.value] : field.value,
    ...(field.summary === undefined ? {} : { summary: field.summary }),
    ...(field.entries === undefined ? {} : { entries: [...field.entries] }),
    ...(field.entryValues === undefined ? {} : { entryValues: [...field.entryValues] }),
  }));
}

/**
 * A setting the extension never declared.
 *
 * The fallback for a schema that cannot be built: some extension builds crash the runtime's
 * bytecode verifier while constructing their preference screen, and the only honest answer is to
 * let the user name the key. The keys are the extension's own, documented in its source.
 */
export function manualField(key: string, value: string): PrefField {
  return { key, kind: "text", title: key, value };
}

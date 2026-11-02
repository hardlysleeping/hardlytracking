/**
 * A source's own filter form: read it, hold the user's choices, send them back with the search.
 *
 * Three things live here, all pure and all tested without a network:
 *
 * 1. **`mapFilters`** turns what the runtime answers into `SourceFilter[]`. The array is
 *    position-aligned with the source's own list — a `HeaderFilter`, a `SeparatorFilter` or a
 *    typename this build does not draw keeps its slot (as `unknown`), because the runtime reads a
 *    change by `position` and a list that silently skipped one would send every later choice to the
 *    filter above it.
 * 2. **`stateOf`** answers what a row currently says: the user's choice, else the source's default.
 *    The sheet draws from this, so opening it never invents a starting value.
 * 3. **`changesFor`** is the wire payload: only the positions the user actually changed, in the
 *    source's own order. A position left alone is not sent, so a source that gains a filter in an
 *    update keeps working instead of being handed a default this client guessed.
 *
 * `cleanSelection` is what turns the sheet's pending edits into a stored selection: an entry equal
 * to the source's default is dropped, so "Filters (3)" always means three things that change the
 * request.
 */
import type { FilterState, SourceFilter, SourceFilterSelection, TriState } from "../api/source";

/**
 * One filter as the Suwayomi GraphQL answers it.
 *
 * The defaults arrive under a per-class alias (`selectDefault`, `checkDefault`, …): Suwayomi's
 * `default` has a different type per filter class, and GraphQL refuses one response key that resolves
 * to two types — a shared alias fails the whole query with *FieldsConflict*.
 */
export interface RawFilter {
  __typename?: string | null;
  name?: string | null;
  values?: Array<string | null> | null;
  selectDefault?: unknown;
  checkDefault?: unknown;
  textDefault?: unknown;
  triDefault?: unknown;
  sortDefault?: { index?: number | null; ascending?: boolean | null } | null;
  /** The group this row belongs to, when the host declares one (see `dalvikFilters`). */
  group?: string;
}

const TRI_STATES: TriState[] = ["IGNORE", "INCLUDE", "EXCLUDE"];

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function values(raw: RawFilter["values"]): string[] {
  return (raw ?? []).filter((value): value is string => typeof value === "string");
}

/** An index into `items`, clamped into range so a stored value cannot point past the list. */
export function indexIn(value: unknown, items: readonly string[], fallback = 0): number {
  const index = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  if (items.length === 0) return 0;
  if (index < 0) return 0;
  return index >= items.length ? items.length - 1 : index;
}

export function triStateOr(value: unknown, fallback: TriState = "IGNORE"): TriState {
  return TRI_STATES.includes(value as TriState) ? (value as TriState) : fallback;
}

/**
 * The runtime's answer as the sheet's list, one entry per position.
 *
 * An unrecognised typename becomes `unknown` rather than disappearing; a Select with no values is
 * also `unknown`, because a dropdown with nothing in it is not a control.
 */
export function mapFilters(raw: readonly RawFilter[] | null | undefined): SourceFilter[] {
  return (raw ?? []).map((filter): SourceFilter => withGroup(oneFilter(filter), filter));
}

/** One raw entry as the sheet's row. Group markers are attached by `mapFilters`. */
function oneFilter(filter: RawFilter): SourceFilter {
  const name = text(filter.name);
  switch (filter.__typename) {
    case "HeaderFilter":
      return { kind: "header", name };
    case "SeparatorFilter":
      return { kind: "separator", name };
    case "SelectFilter": {
      const list = values(filter.values);
      if (list.length === 0) return { kind: "unknown", name };
      return { kind: "select", name, values: list, default: indexIn(filter.selectDefault, list) };
    }
    case "CheckBoxFilter":
      return { kind: "checkbox", name, default: filter.checkDefault === true };
    case "TextFilter":
      return { kind: "text", name, default: text(filter.textDefault) };
    case "SortFilter": {
      const list = values(filter.values);
      if (list.length === 0) return { kind: "unknown", name };
      return {
        kind: "sort",
        name,
        values: list,
        default: {
          index: indexIn(filter.sortDefault?.index, list),
          ascending: filter.sortDefault?.ascending !== false,
        },
      };
    }
    case "TriStateFilter":
      return { kind: "tristate", name, default: triStateOr(filter.triDefault) };
    default:
      return { kind: "unknown", name };
  }
}

/** Attach the parent group's name, when the host declared one. A blank name is not a group. */
function withGroup(row: SourceFilter, filter: RawFilter): SourceFilter {
  return filter.group === undefined || filter.group === "" ? row : { ...row, group: filter.group };
}

/** Whether this entry can carry a choice. A header, a rule and an unknown filter cannot. */
export function takesState(filter: SourceFilter): boolean {
  return filter.kind === "select" || filter.kind === "checkbox" || filter.kind === "text" || filter.kind === "sort" || filter.kind === "tristate";
}

/** The source's own starting value for a row. */
export function defaultStateOf(filter: SourceFilter): FilterState | null {
  switch (filter.kind) {
    case "select":
      return { selectState: filter.default };
    case "checkbox":
      return { checkBoxState: filter.default };
    case "text":
      return { textState: filter.default };
    case "sort":
      return { sortState: { index: filter.default.index, ascending: filter.default.ascending } };
    case "tristate":
      return { triState: filter.default };
    default:
      return null;
  }
}

/**
 * What the row currently says.
 *
 * The stored choice when there is one, else the source's default. A stored state of the wrong shape
 * for the row (the source changed what that position holds) is refused rather than coerced: the
 * default is the honest answer, and `cleanSelection` drops the bad entry on the next Apply.
 */
export function stateOf(filter: SourceFilter, position: number, selection: SourceFilterSelection): FilterState | null {
  const stored = selection[String(position)];
  if (stored !== undefined && fits(filter, stored)) return stored;
  return defaultStateOf(filter);
}

/** Does this state belong to this row? A number cannot be sent to a checkbox. */
export function fits(filter: SourceFilter, state: FilterState): boolean {
  switch (filter.kind) {
    case "select":
      return "selectState" in state;
    case "checkbox":
      return "checkBoxState" in state;
    case "text":
      return "textState" in state;
    case "sort":
      return "sortState" in state;
    case "tristate":
      return "triState" in state;
    default:
      return false;
  }
}

/** Equal states, so "set back to the default" is not a change. */
export function sameState(a: FilterState, b: FilterState): boolean {
  if ("selectState" in a && "selectState" in b) return a.selectState === b.selectState;
  if ("checkBoxState" in a && "checkBoxState" in b) return a.checkBoxState === b.checkBoxState;
  if ("textState" in a && "textState" in b) return a.textState === b.textState;
  if ("triState" in a && "triState" in b) return a.triState === b.triState;
  if ("sortState" in a && "sortState" in b) return a.sortState.index === b.sortState.index && a.sortState.ascending === b.sortState.ascending;
  return false;
}

/**
 * A selection as the runtime's `[FilterChangeInput!]`: `{position, …state}`, in position order.
 *
 * This is the one place the record shaped for storage becomes the list shaped for the wire; the
 * provider calls it so a filtered search and a filtered cache key can never disagree.
 */
export function wireChanges(selection: SourceFilterSelection | undefined): Array<{ position: number } & FilterState> {
  if (selection === undefined) return [];
  return Object.keys(selection)
    .map((key) => ({ position: Number(key), state: selection[key] }))
    .filter((entry) => Number.isInteger(entry.position) && entry.position >= 0)
    .sort((a, b) => a.position - b.position)
    .map((entry) => ({ position: entry.position, ...entry.state }));
}

/**
 * The stored selection, minus anything that is not a change.
 *
 * Drops positions the source no longer has, rows that take no state, and states of the wrong shape
 * or equal to the default. What is left is exactly what would go on the wire, which is why the
 * Filters button can count it.
 */
export function cleanSelection(filters: readonly SourceFilter[], selection: SourceFilterSelection): SourceFilterSelection {
  const clean: SourceFilterSelection = {};
  filters.forEach((filter, position) => {
    if (!takesState(filter)) return;
    const stored = selection[String(position)];
    if (stored === undefined || !fits(filter, stored)) return;
    const fallback = defaultStateOf(filter);
    if (fallback !== null && sameState(stored, fallback)) return;
    clean[String(position)] = stored;
  });
  return clean;
}

/** How many rows the user has changed — the number the Filters button shows. */
export function activeCount(selection: SourceFilterSelection): number {
  return Object.keys(selection).length;
}

/**
 * The changes, in the source's own order.
 *
 * Only what survives `cleanSelection`: a position the user left alone keeps the source's default,
 * which is the answer the source itself would have given.
 */
export function changesFor(filters: readonly SourceFilter[], selection: SourceFilterSelection): Array<{ position: number } & FilterState> {
  return wireChanges(cleanSelection(filters, selection));
}

/**
 * A stable signature of a selection, for a cache key.
 *
 * Without this, a filtered answer would be painted for the same query with no filters — the cache is
 * keyed by source + query and knows nothing about a form. Sorted by position and JSON-encoded, so
 * two equal selections made in a different order share one entry.
 */
export function filterSignature(selection: SourceFilterSelection | undefined): string {
  if (selection === undefined) return "";
  const parts = Object.keys(selection)
    .sort((a, b) => Number(a) - Number(b))
    .map((position) => `${position}:${JSON.stringify(selection[position])}`);
  return parts.join("|");
}

/** A one-line account of what a selection does, for the sheet's footer. */
export function describeSelection(filters: readonly SourceFilter[], selection: SourceFilterSelection): string {
  const bits: string[] = [];
  filters.forEach((filter, position) => {
    const stored = selection[String(position)];
    if (stored === undefined) return;
    const label = filter.name === "" ? `#${position + 1}` : filter.name;
    if ("selectState" in stored && filter.kind === "select") bits.push(`${label}: ${filter.values[stored.selectState] ?? stored.selectState}`);
    else if ("checkBoxState" in stored) bits.push(`${label}: ${stored.checkBoxState ? "on" : "off"}`);
    else if ("textState" in stored) bits.push(`${label}: ${stored.textState === "" ? "(empty)" : stored.textState}`);
    else if ("triState" in stored) bits.push(`${label}: ${stored.triState.toLowerCase()}`);
    else if ("sortState" in stored && filter.kind === "sort") {
      bits.push(`${label}: ${filter.values[stored.sortState.index] ?? stored.sortState.index} ${stored.sortState.ascending ? "asc" : "desc"}`);
    }
  });
  return bits.join(" · ");
}

// ---- the dalvik host: reading its dump, writing its list ---------------------

/**
 * One filter as an M-Extension-Server answers `filtersManga`.
 *
 * The host does not answer a typed tree. It serialises the extension's own Java objects with
 * Jackson, so what arrives is **fields, not a class name**: `state` is the only clue to the kind —
 * a boolean is a checkbox, a string text, a number a select or a tri-state, `{index, ascending}` a
 * sort, an array a group. An extension's own subclasses add their own fields (`a`, `b`, …), which
 * is why this type is open: nothing here may treat the runtime's field names as the whole story.
 */
export interface DalvikRawFilter {
  name?: unknown;
  state?: unknown;
  values?: unknown;
  a?: unknown;
  [field: string]: unknown;
}

/** A label out of a value list that may hold strings or the extension's own option objects. */
function labelsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value === "string") {
      out.push(value);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    const entry = value as { a?: unknown; b?: unknown; name?: unknown };
    // Mihon's own `Sort` option is a pair (`{a: label, b: value}`); a Select's is usually a string.
    const label = typeof entry.a === "string" ? entry.a : typeof entry.name === "string" ? entry.name : null;
    if (label !== null) out.push(label);
  }
  return out;
}

/**
 * The host's dump as the one list `mapFilters` reads.
 *
 * **A group is flattened**: the group's name becomes a `header` row and each child a row of its own
 * carrying `group`, because the sheet draws flat rows and the host addresses a change by name, not
 * by position. Positions in the answer are this client's own, which is safe here and nowhere else —
 * the Suwayomi path sends positions back on the wire, and this one does not.
 *
 * Two shapes cannot be honoured and become `unknown` (kept visible, and no state can be sent):
 * a text child of a group — the host assigns `state = child.name` for those, so whatever is sent is
 * ignored — and a group inside a group. `unknown` is the honest answer: it says the row exists and
 * this build cannot set it, rather than drawing a control whose Apply is a no-op.
 */
export function dalvikFilters(raw: readonly DalvikRawFilter[] | null | undefined): RawFilter[] {
  const rows: RawFilter[] = [];
  for (const filter of raw ?? []) {
    if (filter === null || typeof filter !== "object") continue;
    const name = typeof filter.name === "string" ? filter.name : "";
    if (!Array.isArray(filter.state)) {
      rows.push(dalvikOne(filter));
      continue;
    }
    // A group: its own name as a label, then its children, each marked with the parent.
    rows.push({ __typename: "HeaderFilter", name });
    for (const child of filter.state) {
      if (child === null || typeof child !== "object") continue;
      const childRow = dalvikOne(child as DalvikRawFilter);
      const settable = childRow.__typename !== "TextFilter" && childRow.__typename !== "HeaderFilter" && childRow.__typename !== "UnknownFilter";
      rows.push(settable ? { ...childRow, group: name } : { __typename: "UnknownFilter", name: typeof childRow.name === "string" ? childRow.name : "" });
    }
  }
  return rows;
}

/** One dump entry as a raw row. The kind is inferred from the *shape* of `state`, and nothing else. */
function dalvikOne(filter: DalvikRawFilter): RawFilter {
  const name = typeof filter.name === "string" ? filter.name : "";
  const state = filter.state;
  if (state === undefined || state === null) {
    // No state at all is a Header or a Separator — the host serialises both as `{name}` and there is
    // no field that tells them apart. A label is the honest reading of either.
    return { __typename: "HeaderFilter", name };
  }
  if (typeof state === "boolean") return { __typename: "CheckBoxFilter", name, checkDefault: state };
  if (typeof state === "string") return { __typename: "TextFilter", name, textDefault: state };
  if (typeof state === "number") {
    const list = labelsOf(filter.values);
    if (list.length === 0) return { __typename: "TriStateFilter", name, triDefault: TRI_STATES[indexIn(state, TRI_STATES)] };
    return { __typename: "SelectFilter", name, values: list, selectDefault: indexIn(state, list) };
  }
  if (typeof state === "object") {
    const sort = state as { index?: unknown; ascending?: unknown };
    if (typeof sort.index !== "number") return { __typename: "UnknownFilter", name };
    // `values` is the class's own label array; `a` is what some extensions declare instead.
    const list = labelsOf(filter.values).length > 0 ? labelsOf(filter.values) : labelsOf(filter.a);
    return {
      __typename: "SortFilter",
      name,
      values: list,
      sortDefault: { index: indexIn(sort.index, list), ascending: sort.ascending !== false },
    };
  }
  return { __typename: "UnknownFilter", name };
}

/** One entry of the `filterList` a search carries. */
export interface DalvikFilterChange {
  name: string;
  type: "select" | "checkbox" | "text" | "tristate" | "sort" | "group";
  stateString?: string;
  stateInt?: number;
  stateList?: DalvikChildChange[];
  stateSort?: { index: number; ascending: boolean };
}

/** One changed child of a group. The host's child type has no field for text. */
export interface DalvikChildChange {
  name: string;
  type: "select" | "checkbox" | "tristate";
  stateBoolean?: boolean;
  stateInt?: number;
}

/**
 * The selection as the host's `filterList`: name-keyed, one entry per filter the user changed.
 *
 * Three quirks of the host's reader, all measured against the running runtime rather than guessed:
 *
 * 1. **It matches by name**, so a stored position is resolved against the form this client just
 *    read. A position the source no longer has is dropped by `cleanSelection` before it gets here.
 * 2. **A top-level checkbox's state arrives in `stateList[0].stateBoolean`**, not in a field of its
 *    own — its reader asks the first child of a list for a checkbox that has none.
 * 3. **A group change carries only the children that changed**; the host starts from the source's
 *    own defaults and applies what is named, so an untouched sibling keeps its default.
 */
export function dalvikChanges(filters: readonly SourceFilter[], selection: SourceFilterSelection): DalvikFilterChange[] {
  const changes: DalvikFilterChange[] = [];
  const groups = new Map<string, DalvikChildChange[]>();
  for (const change of wireChanges(cleanSelection(filters, selection))) {
    const filter = filters[change.position];
    if (filter === undefined) continue;
    const group = filter.group;
    if (group === undefined) {
      const entry = dalvikTopLevel(filter, change);
      if (entry !== null) changes.push(entry);
      continue;
    }
    const child = dalvikChild(filter, change);
    if (child === null) continue;
    const bucket = groups.get(group);
    if (bucket === undefined) groups.set(group, [child]);
    else bucket.push(child);
  }
  for (const [name, stateList] of groups) changes.push({ name, type: "group", stateList });
  return changes;
}

function dalvikTopLevel(filter: SourceFilter, state: FilterState): DalvikFilterChange | null {
  switch (filter.kind) {
    case "select":
      return "selectState" in state ? { name: filter.name, type: "select", stateInt: state.selectState } : null;
    case "checkbox":
      // Quirk 2: the host reads a checkbox's state off a one-entry list.
      return "checkBoxState" in state
        ? { name: filter.name, type: "checkbox", stateList: [{ name: filter.name, type: "checkbox", stateBoolean: state.checkBoxState }] }
        : null;
    case "text":
      return "textState" in state ? { name: filter.name, type: "text", stateString: state.textState } : null;
    case "sort":
      return "sortState" in state ? { name: filter.name, type: "sort", stateSort: { index: state.sortState.index, ascending: state.sortState.ascending } } : null;
    case "tristate":
      return "triState" in state ? { name: filter.name, type: "tristate", stateInt: TRI_STATES.indexOf(state.triState) } : null;
    default:
      return null;
  }
}

function dalvikChild(filter: SourceFilter, state: FilterState): DalvikChildChange | null {
  const name = filter.name;
  switch (filter.kind) {
    case "select":
      return "selectState" in state ? { name, type: "select", stateInt: state.selectState } : null;
    case "checkbox":
      return "checkBoxState" in state ? { name, type: "checkbox", stateBoolean: state.checkBoxState } : null;
    case "tristate":
      return "triState" in state ? { name, type: "tristate", stateInt: TRI_STATES.indexOf(state.triState) } : null;
    default:
      return null;
  }
}

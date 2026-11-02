# A source's own filters

A Mihon extension declares a form — albums, languages, statuses, a sort — and applies it in
`getSearchManga`. That form is the honest "advanced search" for a manga reader: the app cannot invent
fields the source does not have, and cannot know what an album actually contains.

Owner's rule for this feature: **a Filters button appears only when the source answers with a form.**
A sheet that looks done and narrows nothing is worse than no sheet.

## The seam

`src/api/source.ts`

- `SourceProvider.filters?(sourceId): Promise<SourceFilter[]>` — absent means the provider cannot ask.
  Absent today: `local`, `archive`, `webdav`, `komga`. Answered by `mihon` (Suwayomi's GraphQL) and by
  `dalvik`/`htserver` (the extension host's own `filtersManga` — see below).
- `SourceProvider.search(sourceId, query, page, filters?)` — the choices travel with the search and
  nowhere else. A Mihon extension applies filters in `getSearchManga`; `getPopularManga` and
  `getLatestManga` do not take them at all, so sending them to popular would be a lie the UI tells.

`SourceFilter` is a flat list **indexed by position**: `header`, `separator`, `select`, `checkbox`,
`text`, `sort`, `tristate`, and `unknown` for a class this build cannot draw. `unknown` keeps its slot,
because `position` — not the order things arrive in — is what the runtime reads. Dropping one would
send every later choice to the filter above it.

`SourceFilterSelection` is `Record<position, FilterState>` (`{selectState}`, `{checkBoxState}`,
`{textState}`, `{triState}`, `{sortState: {index, ascending}}`), stored as one pref:
`settings.sourceFilters[sourceId]`, so the choice travels in an export and survives a reload.

`src/lib/source-filters.ts` is pure and tested: `mapFilters`, `stateOf`, `cleanSelection`,
`wireChanges`, `changesFor`, `filterSignature`, `describeSelection`.

## Suwayomi (verified live, v2.4.2366)

Read one source's form — `source(id:)` is a `LongString!`, not `Int!`:

```graphql
query SourceFilters($id: LongString!) {
  source(id: $id) {
    filters {
      __typename
      ... on HeaderFilter { name }
      ... on SeparatorFilter { name }
      ... on SelectFilter { name values selectDefault: default }
      ... on CheckBoxFilter { name checkDefault: default }
      ... on TextFilter { name textDefault: default }
      ... on TriStateFilter { name triDefault: default }
      ... on SortFilter { name values sortDefault: default { index ascending } }
    }
  }
}
```

**`default` needs one alias per filter class.** A shared alias (`fdefault: default` on all four)
fails the whole query with *FieldsConflict: returns different types 'Int' and 'Boolean'* — the runtime
reports only the validation error, so the form looks like a broken source.

Send the choices back with the search:

```graphql
mutation FetchSource($source: LongString!, $page: Int!, $type: FetchSourceMangaType!,
                     $query: String, $filters: [FilterChangeInput!]) {
  fetchSourceManga(input: { source: $source, page: $page, type: $type, query: $query, filters: $filters }) {
    mangas { id title thumbnailUrl author description status }
    hasNextPage
  }
}
```

`position` is the filter's index in the source's own list. `filters: null` means "the form's own
defaults"; an unrecognised `position` (e.g. 9 on a four-filter source) is **silently ignored**, so a
mistake here produces an unfiltered list rather than an error. That is why `mapFilters` never drops an
entry and `cleanSelection` validates every state against its row's kind.

### Measured: a filter changes the result set

8Muses (`mihon:src:1802675169972965535`), `type: SEARCH`, `query: ""`, through the app's own
`createMihonProvider` against `http://localhost:4567/api`:

| changes sent | rows | ids |
|---|---|---|
| none | 26 | ids 8564–8589 |
| `[{position: 2, selectState: 3}]` (Album) | 19 | different set |
| `[{position: 2, selectState: 5}]` (Album) | 72 | different set |
| `[{position: 3, selectState: 3}]` (Sort Order) | 21 | different set |

Local source (`mihon:src:0`, a `SortFilter` "Order by" Title/Date) with three local titles:

| changes sent | order |
|---|---|
| none / `{}` | Alpha, Mike, Zulu (title) |
| `[{position: 0, sortState: {index: 1, ascending: false}}]` | Zulu, Mike, Alpha (date, newest first) |

**The same form on POPULAR does nothing** for the same source — filters are a *search* thing. An
earlier probe that sent `sortState` with `type: POPULAR` saw no change and looked like a broken wire
format; it was the wrong fetch type.

## The dalvik / iOS runtime: the host's own shape

The embedded runtime is **not ours**: `plugins/mihon-runtime/ios` starts a JVM with
`MExtensionServer.jar` (upstream, MPL-2.0) and talks to it over JNI; the `/dalvik` routes are served by
that jar. So `filtersManga` needed no native change — the pinned builds already carry the reader that
applies a `filterList` back (`MihonInvoker.convertFilterList`, present in `ios-runtime-v9`,
`ios-runtime-v10` and the v1.0.9 Linux jar this repo pins; checked with `javap` on each). What was
missing was on this side: a mapper, and the plumbing that sends a choice with the search.

### What it answers (measured: MangaDex, pinned jar)

`filtersManga` returns a Jackson serialisation of the extension's Java filter objects. There is no type
tag; the kind is the *shape* of `state`:

| serialised shape | kind |
|---|---|
| `{name}` | header or separator — indistinguishable from each other |
| `{name, state: bool}` | checkbox |
| `{name, state: string}` | text |
| `{name, state: n, values: [...]}` | select; `n` is the selected index |
| `{name, state: n}` with no values | tri-state: `0` ignore, `1` include, `2` exclude |
| `{name, state: {index, ascending}, values: [...]}` | sort |
| `{name, state: [children]}` | group; children are any of the above except a group |

Extension subclasses add their own fields (`a`, `b`, …), and a `Sort`'s labels may be `values` or the
extension's own `a` array of `{a: label, b: value}`. MangaDex's en source answers 106 of these: one
checkbox, four checkbox groups, a sort, a select, and five tri-state groups (its tags alone are ~80).

`dalvikFilters()` reads that dump by shape, and `mapFilters()` — the same function the Suwayomi path
uses — builds the `SourceFilter[]`, so a dalvik source draws in the same sheet as any other. A group is
flattened: its name becomes a header row, each child a row carrying `group`, because the sheet draws
flat rows and the host does not address a change by position.

### What it accepts back (measured)

`getSearchManga` takes `filterList`: a list keyed by **name**, not by position.

```json
[{"name":"Sort","type":"sort","stateSort":{"index":0,"ascending":true}},
 {"name":"Content rating","type":"group","stateList":[{"name":"Safe","stateBoolean":false}]},
 {"name":"Has available chapters","type":"checkbox","stateList":[{"name":"Has available chapters","stateBoolean":true}]},
 {"name":"Created within last","type":"select","stateInt":2},
 {"name":"Gore","type":"tristate","stateInt":1}]
```

Three quirks, each read out of the host's own reader and then measured:

1. a top-level checkbox's value is read from `stateList[0].stateBoolean` — it has no field of its own;
2. a group carries only the children that changed; the host starts from the source's declared defaults,
   so an untouched sibling keeps its own value;
3. a group's *text* child cannot be set at all (the host assigns `state = child.name` for those), so it
   is mapped to `unknown` and never sent.

Measured on MangaDex's en source through this app's own provider (pinned jar, `getSearchManga`,
query `""`): no `filterList` → the default 20 titles; `Sort {index:0, ascending:true}` → 20 different
titles (title order); `Content rating` with only `Safe`, then only `Pornographic` → disjoint sets, 0 of
20 shared, and stable when repeated. With a query (`yuri`): base 20, `Safe` 20, **0 of 20** shared with
the base — a metadata filter bites on a query too.

**The earlier "accepted and ignored" result was a payload-shape mistake**, not a host limitation: the
dump's own fields (`state`, `values`) were sent back, while the reader looks for `stateInt`,
`stateBoolean`, `stateString`, `stateSort` and `stateList`. Fed the dump, it finds nothing, changes
nothing, and answers exactly as if there were no filters — which is what was observed.

`dalvikChanges()` (pure, tested) turns a stored position-keyed selection into that list, resolving each
position against the form read for the source; `dalvik.ts` reads the form once per session and sends
`filterList` only when something changed. A source with no form answers `[]`, which draws no button.

### What is still not honoured

- a text child of a group (quirk 3), and a group inside a group — both `unknown`, kept in the list so
  the sheet does not under-report the form, and never sent;
- header vs separator — both serialise as `{name}`, drawn as a header;
- a host older than the `convertFilterList` build: the app cannot ask (there is no capability flag), so
  the pinned jars are the floor. `plugins/mihon-runtime/ios/PrepareEmbeddedRuntime.sh` names the
  release and `docs/ios-embedded-runtime.md` the constraint.

## UI

`src/components/SourceFilterSheet.svelte` draws the form from `SourceFilter[]` and edits a **draft**;
only Apply writes, so Cancel really cancels. Rows: a header is an uppercase label, a separator is a
rule, a select is a dropdown, a sort is a dropdown plus Asc/Desc chips, a checkbox is a checkbox, text
is a field with "Any" empty, and a tri-state is Ignore / Include / Exclude chips. The footer says what
the selection does in the source's own words ("Sort Order: Date desc") and Clear all empties it.

`src/views/Source.svelte`:

- asks `provider.filters(sourceId)` once per source, and draws `Filters (n)` **only** when the answer
  is non-empty;
- passes `cleanSelection(...)` to `search()` and only to `search()`;
- Apply writes `settings.sourceFilters[sourceId]` (an empty selection deletes the entry) and re-runs a
  search that is already on screen;
- while a filter is set but the tab is Popular or Latest, a hint says "filters apply to search".

Global Search does not apply per-source filters: that screen fans one query across many sources, and a
result silently narrowed by a form the user cannot see there would read as a broken source.

## The bug this work exposed

The source view's `$effect` reset the grid on every run and called `run()` directly; `run()` reads
`mode` and `query` before its first `await`, so those reads became dependencies of the effect. Tapping
**Latest** set the mode, the effect re-ran, and set it back to **Popular** — the tab never moved. The
reset is now wrapped in `untrack()` so the effect depends on `sourceId` alone. Verified live: Latest
sticks, and a filtered search no longer snaps back to Popular underneath it.

## Gates

Suwayomi (T49): `npm test` 855/855 (27 new in `tests/unit/source-filters.test.mjs`), `npx tsc --noEmit`
clean, `svelte-check --threshold error` 0 errors, `npm run build` green, `npm run smoke` 9/9 against the
live runtime. Live at 440×956, `scrollWidth === innerWidth`, sheet 440 wide at the bottom with no
overflow, `Filters (1)` persisted across a reload, search order changed to date-descending and back
after Clear all. The Internet Archive source shows no Filters chip.

Dalvik / the phone (T50): `npm test` 870/870 (15 new: `tests/unit/dalvik-filters.test.mjs` for the dump
and the wire, 5 more in `dalvik-fixture.test.mjs` against the fixture host), `tsc` clean,
`svelte-check` 0 errors, build green. Live at 440×956 against the fixture host
(`tests/manual/stub-dalvik-filters.mjs` + `PORT=8461 DALVIK_URL=… node server/proxy.mjs`): an installed
fixture extension draws `Filters` on its two sources that declare a form and none on the one that does
not; the sheet draws the group headers and children, a top-level checkbox and a text field; Apply
changes the search from four titles to two and the chip to `Filters (1)`; `scrollWidth === innerWidth`.
And against the real M-Extension-Server with the MangaDex APK, through this app's own provider: 106 rows
normalised from the 12-entry dump, a sort and two rating choices each changing the result set (0 of 20
shared between them) — see "What it accepts back".

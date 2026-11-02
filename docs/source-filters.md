# A source's own filters

A Mihon extension declares a form — albums, languages, statuses, a sort — and applies it in
`getSearchManga`. That form is the honest "advanced search" for a manga reader: the app cannot invent
fields the source does not have, and cannot know what an album actually contains.

Owner's rule for this feature: **a Filters button appears only when the source answers with a form.**
A sheet that looks done and narrows nothing is worse than no sheet.

## The seam

`src/api/source.ts`

- `SourceProvider.filters?(sourceId): Promise<SourceFilter[]>` — absent means the provider cannot ask.
  Absent today: `local`, `archive`, `webdav`, `komga`, `dalvik` and `htserver` (see below).
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

## The dalvik / iOS runtime: no filters, and why

`filtersManga` exists in the bridge's method list, and the pinned M-Extension-Server **does** answer
it — but with a Gson dump of the obfuscated Mihon filter classes, not a typed tree:

```json
[{"name":"Has available chapters","state":false},
 {"name":"Original language","state":[{"name":"Japanese (Manga)","state":false,"a":"ja"}],"a":2},
 {"name":"Sort","state":{"index":5,"ascending":false},"values":[…],"a":[{"a":"Alphabetic","b":"title"}]},
 {"name":"Created within last","state":0,"values":["Any","Day","Week","Month","Year"],"a":"createdAtSince"}]
```

There is no type tag (a checkbox, a select and a tri-state are distinguishable only by the JSON shape,
and only by guessing), and the input side is worse: `filterList` on `getSearchManga` is **accepted and
ignored**. Measured with the real MangaDex APK on the local host — the tree sent back untouched, with
`Sort` flipped to `{index: 0, ascending: true}`, and with `Created within last` set to `1`, all returned
the **same 20 titles in the same order** as no filters.

So `filters?` is absent on `dalvik`/`htserver`: the phone draws no Filters button rather than a sheet
whose Apply button would be a no-op. Revisit when upstream publishes the input shape (or when the host
echoes a type per filter); the seam and the sheet need no change then, only a mapping.

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

`npm test` 855/855 (27 new in `tests/unit/source-filters.test.mjs`), `npx tsc --noEmit` clean,
`svelte-check --threshold error` 0 errors, `npm run build` green, `npm run smoke` 9/9 against the live
runtime. Live at 440×956, `scrollWidth === innerWidth`, sheet 440 wide at the bottom with no overflow,
`Filters (1)` persisted across a reload, search order changed to date-descending and back after Clear
all. The Internet Archive source shows no Filters chip.

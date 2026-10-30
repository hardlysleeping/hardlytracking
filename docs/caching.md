# Caching: the list is data, the copies are copies

Two caches, one rule borrowed from HardlyReader: **nothing the reader owns is ever evicted to meet a
limit.** The library, progress, history and downloads are data. Covers, page images and search
answers are copies, and only copies can be dropped.

## Image cache

`src/lib/cache/images.ts`, rows in the `imageCache` store of the same database (`key`, `blob`,
`bytes`, `at`, `usedAt`).

- **Read path:** `imageCache.resolve(url)` → an object URL from the store, or the plain URL plus a
  background fetch that stores it. A failed fetch returns the plain URL — a cache miss is never an
  error, and a cover that cannot be cached is still a cover.
- **Same-origin URLs count.** Covers and page images go through the app's own `/api/img` proxy, so
  the cache accepts `/api/...` paths as well as absolute `http(s)` URLs. A `blob:` or `data:` URL is
  already local and is skipped.
- **Where it is used:** `Cover.svelte` (every cover, including History and Updates) and the reader's
  page images via `use:cacheImage` (`src/lib/cache/action.ts`).
- **Ceiling:** `settings.imageCacheLimitMb`, default 256 MB, choices 64 MB – 1 GB. `prune()` runs at
  startup and after each store; it evicts oldest-first (unread-first when `keepRead` is off), never a
  pinned row, and reports when the pinned rows alone are over the ceiling instead of deleting them.
- **Settings → Storage** prints the real numbers (`1 image · 23 KB of 256.0 MB`), the limit, an
  on/off switch, and a clear button that answers with what it freed.

`src/lib/cache/policy.ts` is pure and tested: `measureCache`, `planEviction`, `overLimit`,
`formatBytes`, `describeCache`. The eviction plan is deterministic (age, then use, then key), so a
test can assert the exact list.

## Search

Two problems, two answers (`src/lib/search/index.ts`):

- **The library is indexed on the device.** `scoreRow`/`searchRows` rank rows in memory — title
  prefix (100) > title word prefix (60) > title contains (30) > author (10–20) > whole title word
  (25). A query ranks; it does not merely filter, so "piece" puts *Piece of Cake* above *One Piece*
  and "oda" finds the author. No network, no per-keystroke scan of a linear `includes`.
- **Source answers are cached.** Each `(source, query)` answer is stored in the `searchCache` store
  with a timestamp and trusted for `SEARCH_CACHE_TTL_MS` (10 minutes). A repeat search paints from
  the cache immediately and still refreshes; with no network it shows the last answer instead of an
  error.

## Titles for rows that are not in the library

History, Updates and Continue can point at a series that was read straight from a source and never
saved. The row keeps ids, so the name is resolved in this order (`library.resolveSeriesMeta`):

1. the library row,
2. a `knownSeries` row — the name and cover recorded the first time the app saw the series anywhere
   (`rememberSeriesMeta`, called from the series page; it keeps the first name and only refreshes a
   missing cover),
3. the provider itself, cached into `knownSeries` afterwards.

If none of them answer, the row reads **Unknown title** / **Chapter**. A namespaced provider id is
never printed where a name belongs — `src/lib/titles.ts` (`looksLikeId`, `seriesLabel`,
`chapterLabel`) is the one place that decides, and it is tested.

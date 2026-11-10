# KANBAN — HardlyTracking

Board: `hermes kanban --board hardlytracking` · Backlog: `BACKLOG.md` · Plan (Native MVP boundary):
`~/.hermes/plans/2026-10-29_133058-hardlytracking-mvp.md` · Gate: `docs/ios-mvp-test-matrix.md`

**Priority order: standalone iPhone first** (owner, 2026-10-29). **WIP limit: 2** — one card per file
area; `src/api/` + `src-tauri/` are the bottlenecks.

Repo: `~/apps/hardlytracking` · branch `master` · remote `github.com/hardlysleeping/hardlytracking` (public).

## Current work: reader usability (2026-11-03)

Plan: `~/.hermes/plans/2026-11-03_024548-hardlytracking-reader-usability.md`. WIP: four isolated implementation worktrees (reader, Library/Search views/controls, Stats, theme parity) plus parent integration; no automatic board dispatch. Owner: current parent session. Cards are held blocked while executed by this session to prevent duplicate gateway workers.

| Card | Backlog | Priority | Work / gate |
|---|---|---|---|
| T66 `t_6ce9d03c` | 68 | P0 | DONE f905de0 + integration: shared BrowseDisplay for Library/Search/Series, 5 unit tests and 96 geometry cases (Row/Grid/Card, 2–8 columns, density, horizontal rail off by default); today 8 live cases at 320–1440 with zero document overflow while a card is open. |
| T67 `t_5637a6ea` | 69 | P0 | DONE bf404ce+b2a547a: direct eye/pin, tuck/restore session-local privacy and Reader route guard; 15 browser checks, clean 1,018 tests/type/Svelte/build, Pro Max emulation. Awaiting next IPA. |
| T64 `t_51a23c55` | 66 | P0 | DONE: expanded-card action row measured at 320/390/440/844/1024/1440 in tests/manual/search-glass.mjs — pairwise overlap false in all 8 cases, three actions present, zero page/card overflow. |
| T51 `t_eacc901e` | 53 | P0 | DONE 8015b16/1fe86e3: drag with the overlay closed moved the page 0 → 195 px; taps, edge tap, centre toggle and horizontal turns still work; 60 geometry cases with zero page errors on the current tree. |
| T52 `t_8462b0f1` | 54 | P0 | DONE: fit width 390×780, fit height 422×844 and whole page 390×780 measured at 390×844, plus landscape pairs; no inaccessible edges in the 60-case run. |
| T53 `t_3393aa57` | 55 | P0 | DONE: resumed page 4 starts at 47 ms before page 5 at 181 ms; cancellation and bounded prefetch pass; read-ahead later made the budget configurable (None/2/3/5/10, default 3) with the current page still first. |
| T54 `t_2c9c129c` | 56 | P0 | DONE b2bde7a: expansion replaces the tapped row and opening a card leaves scrollY at 0; re-verified in tests/manual/search-glass.mjs at 440×956 and at six widths. |
| T68 `t_0d94b8de` | 70 | P1 | DONE: ThemePanel with 10 colour keys, background image/blur/dim/glass, validated persistence, reset and four-mode compatibility; 8 unit tests plus live input-event, reload and 320/390/844 layout checks. |
| T69 `t_84da96af` | 71 | P1 | DONE c5646f9: the opened search card carries its own cover as a blurred, aria-hidden, untappable backdrop with a readability veil; resets between titles, drops under prefers-reduced-transparency. 6 unit tests, 8 live cases at 320–1440 (zero overflow, zero button overlap, no scroll on open), screenshot reviewed. |
| T65 `t_f1939433` | 67 | P1 | Dedicated Stats tab backed by history/read marks/progress/sessions; isolated implementation underway |
| T55 `t_be2108a2` | 57 | P1 | DONE: webtoon seam measured 0 px at 390×844; vertical mode keeps its 12 px page gap by design. |
| T56 `t_86e5ac0c` | 58 | P1 | DONE 60a2445: four regressions, eleven browser cases at Pro Max portrait/landscape; validated persistence and immediate current-first queue updates; clean 1,013 tests/type/Svelte/build. Awaiting next IPA. |
| T57 `t_4f278979` | 59 | P1 | Seen thumbnails remain cached across revisits: Seen covers survive remount/reload/offline; stable keys; respect cache quota; object URL cleanup preserves bytes. |
| T58 `t_ca2518ca` | 60 | P1 | Cache and index search results item metadata and issues: Reuse stored results and chapters; explicit refresh; offline read; keys include source/query/filter identity. |
| T59 `t_fc34fbd2` | 61 | P1 | Long-hold issue range read and download actions: Hold without opening reader; above/below mark read in displayed order with clear anchor semantics; download and read/unread actions. |
| T60 `t_ff6df231` | 62 | P2 | Autoscroll speed slider and linear or bottom-speed curves: Off until started; speed, linear/slower-bottom/faster-bottom; pause/stop; background/exit teardown. |
| T61 `t_c2ce4135` | 63 | P2 | Default-off automatic download on library add: Separate opt-in; use existing queue; dedupe and surface failures; no real bulk tests. |
| T62 `t_d65253fd` | 64 | P2 | Default-off keep existing library offline policy: Reconcile missing issues only; never repeat completed downloads; disabling never deletes. |
| T63 `t_85dc29b7` | 65 | P2 | Per-category keep offline policy: Independent category opt-ins; shared reconciliation; overlapping categories dedupe; disabling never deletes. |

## Earlier roadmap snapshot (not current dispatch order)

| Card | Backlog | Work | Gate |
|---|---|---|---|

| T14 `t_7eb8c34d` | 4 | Local authority DB: history, last-read position, source mappings (categories + hidden/pinned marks already landed) | unit tests + the matrix's data-ownership checks |
| T18 `t_6cc60338` | 5 | Reader modes: vertical + paged, settings, offline pages | both modes read a downloaded chapter with the network off |
| T15 `t_d6ae631e` | 6 | Device downloads: download, manage, delete, offline read | a chapter downloads, opens in airplane mode, deletes cleanly |
| T16 `t_1b9bcf7e` | 8 | Backup import (source identity) + export round-trip | a Mihon/Komikku backup restores and reconnects to installed extensions |
| T13 `t_65a17602` | 1 | The gate: run the iPhone release matrix on a device | matrix + capability + offline + ownership rows recorded, with timings |
| T19 `t_00d83ba5` | 16 | Controlled fixture extension (headers, cookies, WebView, update, slow/failing endpoints) | installs through the app's own repo flow; deterministic rows behave as specified |
| T6 `t_f6e28ea6` | 14 | Tauri desktop with the embedded runtime (desktop jar, same bridge) | Linux artefact launches, `/capabilities` answers, a source browses |
| T8 `t_19227cdc` | 15 | KomgaProvider | blocked on credentials |
| T39 `t_1197a386` | 45 | Colour customisation: HardlyReader's theme panel (accent, per-signal inks, page picture/blur/dim/glass) | default palette renders every screen unchanged; validation + `cssVars` unit test; phone-width panel |


## Done

| Card | Backlog | Evidence |
|---|---|---|
| — `t_ba9b8509` | reader | **A page you own reaches the reader**: the first page and the "ready" state both hung off callbacks that only run with a rendered frame. `lazyPage` fetched page bytes only from an `IntersectionObserver`, and `load()` cleared `busy` only after `await tick()` — a *local* `requestAnimationFrame` — so in a tab that is not painting (backgrounded, a screenshot run, a webview still occluded behind the app that opened it) the reader sat on "Fetching pages…" with every page blank, for as long as you waited, and one frame later it was fine. Now the page being read is fetched by itself (`use:lazyPage={{ page, now: page.index === index }}`) and the observer stays for the neighbours it was meant to prefetch; `busy` clears on Svelte's `tick()`, a microtask. The action also stopped revoking blob URLs it does not own — `pages.ts` and `imageCache` bound them (12 local pages, 160 images) and handed back a dead URL, which blanked a page on the way back to it. Measured at :8460 in an unpainted tab, before: `.loading` still true at 12 s, no `img[src]`; after: no spinner by 1.5 s, `1 / 8`, page 1 decoded 600×900; vertical scroll and paged mode still fetch on approach, and page 1 survives leaving and re-entering the window. In a painted tab the same book reads page 1 in under a second. 800/800, `tsc` clean, build green. **Open:** the 10 MB PDF in the same report is the import deadline (`t_c7cec60c`, `f0b1c94`), not this card |
| — `t_c7cec60c` | import | **A big PDF import ends, and says why**: `lib/files/import.ts` bounds both steps that can wait. Opening a file runs under the app's `RUNTIME_DEADLINE_MS` and a file that misses it is named in `errors` — "still not read after 30 s — the file may be damaged, or too large for this device" — with the rest of the pick still imported; the cover draw has its own `COVER_DEADLINE_MS` (15 s) and **a cover that fails or runs out of time degrades to the title tile, never drops the book** (a shelf picture is a want, the book is the need). `onProgress` + `describeProgress` give the button "Adding 2 of 5…" and a line under it — "Reading X", "Drawing the cover of X", "Saving X" — so working and hung are distinguishable; `SlowNotice` now also mounts on the welcome screen, which is where a first import happens. `ComicBook.open(index, { maxWidth })` draws a cover at 800 px instead of 2× its page box, so a scan exported with a pixel page box (2 550 × 3 300 pt) no longer makes a 34 MP canvas for a 400 px tile. Measured in Chromium at 440×956: a 133-page 31 MB scan imports in 0.30 s with a 400×518 / 12 KB cover, three in a row with no heap growth (38 MB flat), the reader's own page still 1 191×1 684; a file that never opens ends at its deadline with the sentence above, the chip reading "Waiting on stuck-3.pdf · 2s → 4s" and gone at the deadline; covers read back out of IndexedDB at 400 px. 4 new tests (800/800 in the tree), `tsc` clean, `svelte-check` 0 errors / 8 warnings, build 1.20 s. **Open:** 30 s is the app's single deadline, so a file that genuinely needs longer is refused by name rather than waited on — `openDeadlineMs` is per call if a real case turns up |
| T41 `t_a45d863a` | 46 | **CBR and real covers**: `src/lib/files/rar.ts` decodes `.cbr` through unrar compiled to wasm (`node-unrar-js`, lazy, one decoder at a time — its wasm callbacks read whichever extractor was created last), names normalised from Windows backslashes, both RAR 1.5 and RAR 5; page 1 becomes a 400 px JPEG cover at import into `imageCache` under `book:<id>#cover`, so an owned or WebDAV book shows a picture instead of the title (WebDAV books gain one on their first read). 784/784, tsc clean, svelte-check 9 warnings as before, build emits `unrar-*.wasm`; live at :8461 a 3-page 1200×1800 `.cbr` imported with a 400×600/6 KB cover, opened in the reader at 1200×1800, page 2 on ArrowRight; two real RAR 1.5 archives off disk (116 MB/196 pages, 48 MB/29 pages) listed and read in 338/202 ms |
| T12 `t_7d2d23fe` | 2 | **The iPhone runs its own extension host (build half)**: `plugins/mihon-runtime` (local npm package + pod) — our own ObjC++ JNI host on one 8 MiB thread with `RTLD_GLOBAL` and the VM options this runtime needs, a Capacitor plugin, and `PrepareEmbeddedRuntime.sh` pinning the JVM + server jar by SHA-256. App side: `src/lib/mihon-runtime.ts` (7 tests, 495/495 total, tsc clean, svelte-check 0 errors) + `CapacitorHttp` for loopback. CI `41139345968` on `c70db8d`: IPA 58,042,014 B, `OpenJDKRuntime.framework` 40 MB Mach-O arm64, 46 MB runtime bundle with `MExtensionServer.jar` + `java-logging-shim.jar`, `_MihonRuntimeStart/Pause/Stop/IsRunning` exported, `registered plugins: MihonRuntimePlugin` (the workflow fails if that class is missing from `packageClassList`). **Open:** on-device start and `/capabilities` — the T13 device run |
| T30 `t_fc96361a` | tracking | **Push on read + queue (engine)**: `src/lib/trackers/queue.ts` (the 1 m → 5 m → 15 m → 1 h → 6 h ladder, `isDue`, `nextChapter`), `host.flushPending` now reads `pending.attempt` so a failing service is not re-asked on every launch, a `force` pass for the manual button, and a debt the row has outgrown is dropped instead of pushed backwards. `sync.ts` arms it: `installTrackerSync` sets `store.onReadMark` (fired after the local write in `setRead`, never awaited), drains on `online` and on launch, and exposes `syncAll()`. 9 new tests (488/488), `tsc` clean, `svelte-check` 0 errors, build green; live at :8460 a seeded title's `Read` wrote `read:…:ch:1`/`:ch:2` = true with no error. **Open:** no adapter (T26–T28 need his logins) and no button (T29), so nothing is bound yet |
| T37 `t_4fda70ff` | 45 | **Migrate a title to another source**: `lib/migrate.ts` (alignment + refusals, 16 tests), `lib/migrate-apply.ts` (the write sequence, 7 tests), `MigrateSheet.svelte` behind the series `⋯` menu. The entry keeps its id and categories; the mapping's `remoteSeriesId` is the remap and `alternates` keeps the old source, so it is reversible. `remoteOf()` makes `details`/`chapters`/`readState` follow the mapping; marks follow the title. Live at 440×956: mark + position carried, alternate written, a no-chapter target refused with the database unchanged. 757/757 on master, tsc clean, svelte-check 0 errors, build green. `docs/migration.md` |
| T24 `t_2ae97e10` | 23 | **iPhone Library screen, all 14 plan tasks** (T-L1…T-L14, `1ed3bd0`…`da588c6`): one query model, header + `⋯`, real filter model + `Filter (n)` + chips, collection tabs with `+N`, continue reading with covers and next-unread, ten sort keys with per-collection memory, manual order + drag, selection with tri-state collections, badge set + quick resume + three sizes, search operators + scope, view state that survives a route change, the 5 000-row budget, offline + derived widths. Gate: 479/479 tests, `tsc` clean, `svelte-check` 0 errors; 5 000 rows in a production build at 22 ms first paint / 60 fps / a read mark touching 2 nodes (44.6 ms), `&cv=off` 27 ms / 42 fps; parity controls read off the live DOM at 440×956 with no sideways pan; offline by blocking `/api/*` — one line in place, 24 tiles kept. `docs/runs/2026-10-30-t24-library.md` |
| T1 `t_2a08f8b6` | 9 | 24/24 unit tests, `tsc --noEmit` clean, `svelte-check` 0/0, build 60.8 kB JS / 4.7 kB CSS |
| T2 `t_3ee23911` | 10 | `npm run smoke` 9/9 direct at `:4567` and 9/9 through the proxy `:8460` |
| T3 `t_8a225c2a` | 11 | authority tests + browser IndexedDB read-back |
| T4 `t_ce5c97eb` | 12 | browser at `:8460`: 5 source chips, 1 chapter, reader `2 / 4` resuming from the stored page |
| T5 `t_6abb03ac` | 13 | `/api/mihon/graphql` → sources JSON; thumbnail 200 `image/jpeg`; `/series/mihon:12` → 200 |
| T24 `t_0b7e28cf` | 2 | iPhone-first shell: tokens, bottom nav, every screen, reader modes, downloads, backup | live at 390×844 with a real MangaFire chapter (106 pages, 14.7 MB downloaded, read offline) |
| T23 `t_dffee54c` | 3 | extension repositories: add a URL, search the index, install/update | live: Keiyoushi (1 438) → MangaFire 1.6.35 → 7 sources on Browse |
| T21 `t_19f3c2b0` | 3 | dalvik host wired in: registry probe, APK install from file, `dalvik` provider kind | live: real MangaDex APK installed in the UI (61 sources, sha256 `12fde776…`) → popular (20) → series → Ch.1, 17 pages, all 17 loaded via `/api/dalvik/image/`; hard reload keeps the 61 sources with no reinstall; read mark goes to our DB and draws back on the list |
| T14 `t_7eb8c34d` | 4 | history, position, source mappings + continue strip | live: read to 3/21 → library 'page 3' → resumed at 3/21 |
| T11 `t_1da228de` | 3 | `/dalvik` bridge proven on Linux: MExtensionServer v1.0.9 + real MangaDex APK — 61 sources, 20 popular (hasNext), details, 3 chapters, 21 pages, search 4, 2.1 s; 130/130 tests |
| T20 `t_b3da9c53` | 4 | **Hidden + pinned categories in HardlyReader's look**: eye cycles Hidden → Revealed → Only, pin cycles Active → Only → Hidden, pinned rows ring + underlight + tone, per-row eye/pin, rail selection, `categories` store (DB v2). 37/37 tests, `tsc` clean, `svelte-check` 0/0, browser: all three eye states, all three pin states, per-row marks, reload persistence |
| T17 `t_338636c0` | 7 | **WebView login + cookie sharing into the runtime**: `src/lib/webview/*` (cookie rules, platform seam, database jar, runtime's challenge routes), `src/api/mihon-bridge.ts` (`loginSource`: 401 → page → jar → the same call answers), cookies on every `/dalvik` call as `Cookie` + `x-hardlytracking-cookies` (proxy promotes it for the PWA), 401 with its `loginUrl` on `DalvikError`, login button on the Source screen. 21/21 new tests, 408/408 total, `tsc` clean, `svelte-check` 0 errors. Live: fixture host via the real proxy — 401 bare, 200 with the session header; real M-Extension-Server v1.0.9 + MangaDex — 20 items with and without the session headers, no handler error. Device rows (WEB-01…06) wait on the shells' webview — `docs/runs/2026-10-29-t17-webview-cookies.md` |

## Ready (next up after the native path)

| Card | Plan | Work | Gate |
|---|---|---|---|
| — | — | Nothing waiting that can be built here: T13 needs his iPhone (the runtime is device-only, no simulator), T26–T28 need his own tracker logins, T29 is deprioritised by his call, T6 waits on the native path. T30's engine is done — what it lacks is an adapter to push through and a button to press | — |

## More ecosystems — planned, not dispatched

Owner's direction 2026-10-30: "support more sources and more types of backups, not just mihon based,
aidoku or suwatte or paperback too, same with repos, goal is to make transferring in and out easy,
access same repos, same extensions, from this app, would also like webnovel reading support."

Plan: `~/.hermes/plans/2026-10-30_221335-hardlytracking-multi-ecosystem.md` · Backlog rows **27–39**.
No live cards are created for these on purpose: a new card is claimed within seconds and the worker
`cd`s into the main tree (see the worktree trap in the skill). They get cards when they are dispatched,
each with `--workspace dir:<worktree>`.

| Backlog | Work | Can start now? |
|---|---|---|
| 27–30 | Neutral repo index + Aidoku/Suwatte/Paperback list parsers, one Extensions list | **yes** — pure parsers, fixtures from the live lists, no device, no credentials |
| 31–33 | `.tachibk` reader/writer + Aidoku/Suwatte/Paperback backup readers + one import door | **yes for the readers**; the `.tachibk` writer needs one real Mihon backup as a fixture |
| 34–37 | Hosts: Aidoku WASM spike first, then the provider; Suwatte/Paperback JS in a Worker; host registry | yes — B1 is a timeboxed measurement on this box, no iPhone needed |
| 38 | Webnovels: text chapters, text reader mode, per-ecosystem text mapping | yes, after C1's model change |
| 39 | Export back out to each ecosystem | after the matching reader exists |

Phase A (27–33) is the only part that may run beside the T13 gate, because it is credential-free and
needs no device. Everything else keeps the "nothing starts while a hard gate fails" rule.

T24 is on the board as `t_2ae97e10`, completed with the same evidence as this file. `src/api/**` and
`src-tauri/**` were never touched by it, so it did not collide with T12/T17.

## Post-launch — paid sync (not on the road to launch)

**The reader is free; the subscription pays only for automatic cross-device sync.** $0.99/month or
$9.99/year, one capability `cloudSync`, all providers under one account. No account for reading,
downloads, backups or Komga/Suwayomi. Supabase holds identity + entitlement + devices + Stripe mapping —
never the library, history, downloads, extensions or sync documents. Manual export/import stays free.

| Card | Depends on | Work | Gate |
|---|---|---|---|
| S1 `t_128d24d5` ✅ | — (credential-free, done alongside the native path) | Sync document schema + versioning, one format | `npm run sync:roundtrip`: 1 526 bytes, identical sha256 written/rewritten |
| S2 `t_228bc810` ✅ | — | Change log: tombstones, per-field stamps, merge rules | two-device merge keeps progress, honours deletions |
| S4 `t_43c26b7c` | S2 | Supabase Auth (Google, Apple, magic link), device list, revoke | two clients, one user; revoke is per-session |
| S5 `t_a629976c` | S4 | Billing service: `/checkout` monthly\|yearly, portal, webhook, `entitlements` + RLS | test purchase flips `cloud_sync`; client writes refused |
| S6 `t_083bac82` ✅ | — | First cloud transport behind the document (folder/WebDAV) | two devices converge; Supabase not involved |
| S7 `t_cb4a2033` | S5 | Entitlement gate, Manage Subscription, expiry behaviour | expiry stops sync and changes nothing else |

Not synced, by design: downloaded images, CBZ, page/cover cache, APK binaries, WebView cookies.

## The gate in one paragraph

`docs/ios-mvp-test-matrix.md`: the release gate. 25 pinned extensions from the live Keiyoushi index
(1 438 entries) across all ten required classes — MangaDex (61 sources), Manga Million (108), XCOMIC (77),
GlobalComix (37), MangaFire (7), plus HTML, JSON, filters, preferences, cookies, auth, headers, WebView,
Cloudflare/captcha, image headers and non-Latin sources. Then his EXT / SRC / HTTP / WEB / LIB / OFF / BAK /
UPD / LIFE matrices, the six release gates and the single final acceptance scenario. `npm run matrix:check`
validates today: 25 rows, missing 0, APK unreachable 0, version drift 0, source-id loss 0, every class at
or above its minimum. **Hard gates are non-negotiable — nothing starts on Komga, Suwayomi or the PWA while
one is failing.**

## Incident recorded on the board

During the first UI pass, opening a chapter wrote `isRead: true` to the runtime's own database (chapter 1 of
manga 12 on the local Suwayomi). That is a write to data the app does not own. It was reverted
(`updateChapter … isRead:false`, verified), and the reader now has an explicit `Mark read` button.

## 2026-10-30 — the owner's new priority: marks that hide, on sources too

"the same buttons and system for UI from hardlyreader, but here it works not just on categories, but also
hides sources, and reading history of comics in those categories and/or sources that are hidden."

Measured before planning: the **grid exists** (Library has `grid`/`compact`/`list` in the header toggle), and
the **eye/pin system exists for categories** (`lib/categories.ts` rules, `CategoryRail.svelte` look,
`applyView` already filters the grid). What does not exist: any mark on a source, and any effect of the marks
outside the grid — `History.svelte` never consults them.

- **T31** (`t_6bc49db5`) — `SourceMark` + `sourceMarks` store + `SourceRail` + Browse, same band and words.
- **T32** (`t_142bf5e9`) — one predicate, every caller: library, history, continue, updates.

Rule: a series is hidden when every category it is filed under is hidden, **or** its source is hidden. The
source half is deliberately absolute — a source is where a title comes from, so hiding it hides everything
from it even when a category would have shown it.

## T36 — HardlyReading's patterns, in search / extensions / settings (done)

Owner: *"i want all of hardlyreadings functionality in hardlytrackings search and extension and its
settings, everything that makes sense, i also like how there in search the grid shifts and open the
card info in search without getting to a new page"*. The reference is the **Python** HardlyReading
(`~/apps/HardlyReading/index.html`, `showDetail` + `.stage.split`), not the Flutter rewrite.

Landed in three commits:

- `d1c5dca` — **Search opens a result in place.** The grid narrows (`minmax(0,1fr) minmax(320px,380px)`)
  and the record paints beside it; under 940 px the pane is `position:fixed; inset:0` and the search stays
  underneath. The description comes from `details()` (cached per id), the pane says "In your library" with
  Remove when saved, and **Select mode** ticks results instead of opening them so one button can file them
  all — a stray click never queues anything, which is HardlyReading's rule.
- `61581e5` — **Settings has the Disk panel.** `navigator.storage.estimate()` as a bar (1.5 % floor,
  80/92 % tints) labelled as this app's quota, never as free disk space; the search cache is measured
  (`store.searchCacheSize()`, rows + bytes) and clearable.
- `39af2ed` — **Extensions**: an installed card lists its own sources (`▾ sources (n)`), and
  "Check for updates" asks **every** repository, not only the open one — pure `planUpdates()` with three
  tests (built-ins skipped, no version code skipped, downgrades refused).

- `bbf2ce2` — **A source's own filters** (the "advanced search"): `SourceProvider.filters?` answers a
  position-aligned form, `search()` carries `settings.sourceFilters[sourceId]`, `SourceFilterSheet`
  draws it and only Apply writes, and the `Filters (n)` chip appears only for a source that declares
  one. Measured live through the shipped provider: 8Muses SEARCH 26 rows unfiltered → 19 / 72 / 21 for
  three filters; Local source's SortFilter reversing three titles by date. Filters are a **search**
  thing (the same form on Popular changes nothing). `docs/source-filters.md`.
- `f6af016` — **The phone's extension host answers its own filters too.** T49 left `filters?` off the
  dalvik/iOS host because its `filterList` had been measured as accepted-and-ignored; that measurement
  was a payload-shape mistake. The pinned `MExtensionServer.jar` has `MihonInvoker.convertFilterList`
  (checked with `javap` on `ios-runtime-v9`, `ios-runtime-v10` and the pinned Linux jar), and it reads
  a **name-keyed** list — `stateInt` / `stateBoolean` / `stateString` / `stateSort` / `stateList`, with a
  top-level checkbox's value on its first child. `dalvikFilters` reads the host's Jackson dump by the
  shape of `state` and flattens groups (`group` on the row); `dalvikChanges` turns the stored selection
  into that list; `dalvik.ts` sends it and nothing else. Measured against the real host with MangaDex:
  106 rows from its 12-entry dump, and a sort or a rating choice each changing the set (0 of 20 shared,
  stable when repeated); with a query, `Content rating: Safe` shared 0 of 20 with the base. Live in the
  app at 440×956 against `tests/manual/stub-dalvik-filters.mjs`: button on the two sources that declare
  a form, none on the one that does not; Apply took the search from four titles to two and the chip to
  `Filters (1)`. 870/870 tests, `tsc` clean, `svelte-check` 0 errors. No native change was needed.
  `docs/source-filters.md`, `docs/ios-embedded-runtime.md`.

Not ported, with reasons in the plan file: archive.org's Lucene advanced search (its query language,
not ours — a source's own form is our answer, now built), the password gate and `local_only` (this
app's server already takes `HARDLYTRACKING_TOKEN`), the support pill (archive.org-specific), and the
autostart toggle (exists as a user unit + `scripts/service.sh`; a webview would need a new Tauri
command).

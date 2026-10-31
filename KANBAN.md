# KANBAN — HardlyTracking

Board: `hermes kanban --board hardlytracking` · Backlog: `BACKLOG.md` · Plan (Native MVP boundary):
`~/.hermes/plans/2026-10-29_133058-hardlytracking-mvp.md` · Gate: `docs/ios-mvp-test-matrix.md`

**Priority order: standalone iPhone first** (owner, 2026-10-29). **WIP limit: 2** — one card per file
area; `src/api/` + `src-tauri/` are the bottlenecks.

Repo: `~/apps/hardlytracking` · branch `master` · remote `github.com/hardlysleeping/hardlytracking` (private).

## Now (in dispatch order)

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

## Done

| Card | Backlog | Evidence |
|---|---|---|
| T12 `t_7d2d23fe` | 2 | **The iPhone runs its own extension host (build half)**: `plugins/mihon-runtime` (local npm package + pod) — our own ObjC++ JNI host on one 8 MiB thread with `RTLD_GLOBAL` and the VM options this runtime needs, a Capacitor plugin, and `PrepareEmbeddedRuntime.sh` pinning the JVM + server jar by SHA-256. App side: `src/lib/mihon-runtime.ts` (7 tests, 495/495 total, tsc clean, svelte-check 0 errors) + `CapacitorHttp` for loopback. CI `41139345968` on `c70db8d`: IPA 58,042,014 B, `OpenJDKRuntime.framework` 40 MB Mach-O arm64, 46 MB runtime bundle with `MExtensionServer.jar` + `java-logging-shim.jar`, `_MihonRuntimeStart/Pause/Stop/IsRunning` exported, `registered plugins: MihonRuntimePlugin` (the workflow fails if that class is missing from `packageClassList`). **Open:** on-device start and `/capabilities` — the T13 device run |
| T30 `t_fc96361a` | tracking | **Push on read + queue (engine)**: `src/lib/trackers/queue.ts` (the 1 m → 5 m → 15 m → 1 h → 6 h ladder, `isDue`, `nextChapter`), `host.flushPending` now reads `pending.attempt` so a failing service is not re-asked on every launch, a `force` pass for the manual button, and a debt the row has outgrown is dropped instead of pushed backwards. `sync.ts` arms it: `installTrackerSync` sets `store.onReadMark` (fired after the local write in `setRead`, never awaited), drains on `online` and on launch, and exposes `syncAll()`. 9 new tests (488/488), `tsc` clean, `svelte-check` 0 errors, build green; live at :8460 a seeded title's `Read` wrote `read:…:ch:1`/`:ch:2` = true with no error. **Open:** no adapter (T26–T28 need his logins) and no button (T29), so nothing is bound yet |
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

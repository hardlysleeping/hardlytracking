# KANBAN — HardlyTracking

Board: `hermes kanban --board hardlytracking` · Backlog: `BACKLOG.md` · Plan (Native MVP boundary):
`~/.hermes/plans/2026-10-29_133058-hardlytracking-mvp.md` · Gate: `docs/ios-mvp-test-matrix.md`

**Priority order: standalone iPhone first** (owner, 2026-10-29). **WIP limit: 2** — one card per file
area; `src/api/` + `src-tauri/` are the bottlenecks.

Repo: `~/apps/hardlytracking` · branch `master` · remote `github.com/hardlysleeping/hardlytracking` (private).

## Now (in dispatch order)

| Card | Backlog | Work | Gate |
|---|---|---|---|

| T12 `t_7d2d23fe` | 2 | iOS shell: Tauri plugin wrapping `MihonEmbeddedBridge` + `OpenJDKRuntime.xcframework` | unsigned IPA builds on Codemagic; on device the server starts and `/capabilities` answers |
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
| T24 `t_2ae97e10` | `~/.hermes/plans/2026-10-29_152448-hardlytracking-iphone-library.md` | **iPhone Library screen**: the owner's §1–§36 spec — five tabs (already there), category tabs + `+N` overflow, Continue Reading rules and controls, one filter/sort/search query model with active chips, manual order + drag, Select All + tri-state collections, badge set + quick-resume, state persistence, 5 000-row budget, offline, first-launch defaults | 14 tasks, each green on `npm test` + `tsc` + `svelte-check` + build; the plan's §3 parity list ticked off in the browser at 390 px; `node scripts/library-perf.mjs` prints the three numbers; offline reload |

Status `ready`, unassigned — the dispatcher skips an unassigned card, so nothing runs until it is
assigned. `src/api/**` and `src-tauri/**` are untouched by it, so it does not collide with T12/T17.

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

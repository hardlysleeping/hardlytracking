# KANBAN — HardlyTracking

Board: `hermes kanban --board hardlytracking` · Backlog: `BACKLOG.md` · Plan (Native MVP boundary):
`~/.hermes/plans/2026-10-29_133058-hardlytracking-mvp.md`

**Priority order: standalone iPhone first** (owner, 2026-10-29). **WIP limit: 2** — one card per file
area, and `src/api/` + `src-tauri/` are the bottlenecks.

Repo: `~/apps/hardlytracking` · branch `master` · remote `github.com/hardlysleeping/hardlytracking` (private).

## Now (in order)

| Card | Backlog | Work | Gate |
|---|---|---|---|
| T11 `t_1da228de` | 3 | Bridge transport `POST /dalvik` + extension store (repo index → APK → base64) | proven on Linux against `MExtensionServer-Linux-x64` v1.0.9 with a real APK: sources, popular, search, chapters, pages |
| T12 `t_7d2d23fe` | 2 | iOS shell: Tauri plugin wrapping `MihonEmbeddedBridge` + `OpenJDKRuntime.xcframework` | unsigned IPA builds on Codemagic; on device the server starts and `/capabilities` answers |
| T13 `t_65a17602` | 1 | Native MVP acceptance test (7 steps, no server) | a physical iPhone passes all seven; per-step timings recorded |
| T9 `t_1b9bcf7e` | 9 | Mihon/Komikku backup import | round-trip a real backup into the app DB |
| T6 `t_f6e28ea6` | 10 | Tauri desktop with the embedded runtime (desktop jar, same bridge) | Linux artefact launches, `/capabilities` answers, a source browses |
| T8 `t_19227cdc` | 11 | KomgaProvider | blocked on credentials |
| T10 `t_d6ae631e` | 12 | Downloads (device, inside the native MVP) + sync polish | a chapter downloads and reads with the network off |

## Done

| Card | Backlog | Evidence |
|---|---|---|
| T1 `t_2a08f8b6` | 4 | 19/19 unit tests, `tsc --noEmit` clean, `svelte-check` 0/0, build 60.8 kB JS / 4.7 kB CSS |
| T2 `t_3ee23911` | 5 | `npm run smoke` 9/9 direct at `:4567` and 9/9 through the proxy `:8460` |
| T3 `t_8a225c2a` | 6 | authority tests + browser IndexedDB read-back |
| T4 `t_ce5c97eb` | 7 | browser at `:8460`: 5 source chips, 1 chapter, reader `2 / 4` resuming from the stored page |
| T5 `t_6abb03ac` | 8 | `/api/mihon/graphql` → sources JSON; thumbnail 200 `image/jpeg`; `/series/mihon:12` → 200 |

## The native boundary in one paragraph

On a physical iPhone with no server, no Suwayomi, no desktop and no LAN: add a Mihon extension repo,
install and update an APK extension, browse/search, open a series, list chapters, render pages, download a
chapter and read it offline, relaunch and keep library/history/position. Nothing else is in the native MVP.
The stack is not speculative — `m_extension_server` ships an in-process **OpenJDK Zero interpreter**
(no JIT) as `OpenJDKRuntime.xcframework` for iOS 13+, device-arch only, behind a four-function Obj-C++
bridge that starts a loopback HTTP server speaking `POST /dalvik`.

## Incident recorded on the board

During the first UI pass, opening a chapter wrote `isRead: true` to the runtime's own database (chapter 1 of
manga 12 on the local Suwayomi). That is a write to data the app does not own. It was reverted
(`updateChapter … isRead:false`, verified), and the reader now has an explicit `Mark read` button.

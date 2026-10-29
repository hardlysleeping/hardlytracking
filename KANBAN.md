# KANBAN — HardlyTracking

Board: `hermes kanban --board hardlytracking` (10 cards, ids in each card below).
Backlog: `BACKLOG.md` — row numbers below are its rows.
Plan: `~/.hermes/plans/2026-10-29_133058-hardlytracking-mvp.md`

**WIP limit: 2.** One card per file area: `src/api/` and `src/views/` are the bottlenecks;
queue anything that needs both behind the card holding them.

Repo: `~/apps/hardlytracking` · branch `master` · no worktrees yet.

## Done

| Card | Backlog | Evidence |
|---|---|---|
| T1 scaffold: Svelte app + seam + DB (`t_2a08f8b6`) | 1 | 19/19 unit tests (`node --test`), `tsc --noEmit` clean, `svelte-check` 0 errors 0 warnings, `vite build` → 60.8 kB JS / 4.7 kB CSS |
| T2 MihonProvider (`t_3ee23911`) | 2 | `npm run smoke` 9/9 direct at `:4567` and 9/9 through the proxy `:8460`; unit tests pin the query shapes and the relative-page join |
| T3 library + progress + authority (`t_8a225c2a`) | 3 | authority tests (mihon `ownsProgress:false`, local `true`, `progressWriter`); IndexedDB rows read back in the browser: `series:1, chapters:1, progress:[{chapterId:"mihon:ch:1",page:1,total:4}]` |
| T4 four views (`t_ce5c97eb`) | 4 | browser at `:8460`: library tile, 5 source chips, series page 1 chapter, reader `2 / 4` resuming from the stored page |
| T5 proxy + compose (`t_6abb03ac`) | 5 | `/api/mihon/graphql` → sources JSON; `/api/mihon/v1/manga/12/thumbnail` → 200 `image/jpeg`; `/series/mihon:12` → 200 (SPA fallback) |

## Blocked (not started, deliberately)

| Card | Backlog | Blocked on |
|---|---|---|
| T6 Tauri desktop + embedded runtime (`t_f6e28ea6`) | 6 | a Rust/Tauri build and an in-process runtime |
| T7 iOS embedded JVM plugin (`t_7d2d23fe`) | 7 | the Mangayomi bridge source, which is not in this tree |
| T8 KomgaProvider (`t_19227cdc`) | 8 | Komga credentials (`:25600` answers 401) |
| T9 backup import (`t_1b9bcf7e`) | 9 | nothing technical — next in queue |
| T10 downloads + sync (`t_d6ae631e`) | 10 | after T9 |

## Incident recorded on the board

During the first UI pass, opening a chapter wrote `isRead: true` to the runtime's own
database (chapter 1 of manga 12 on the local Suwayomi). That is a write to data the app
does not own. It was reverted (`updateChapter … isRead:false`, verified), and the reader
now has an explicit `Mark read` button instead of a write-on-open.

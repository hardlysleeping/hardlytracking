# What this device remembers

The database is the app's memory, not a cache. In a packaged build (iOS/Android/desktop) it is
SQLite; in a browser tab it is IndexedDB behind the same `Database` interface (`src/lib/db/open.ts`),
so every store below is written once and runs on both. Nothing important lives in
`localStorage` or `sessionStorage` — the theme is the only exception, because it has to be applied
before the database is open.

Schema version **9**.

## The tables, and what the spec called them

| Spec | Here | Key |
|---|---|---|
| manga | `series` | `id` |
| chapters | `chapters` | `id` |
| library_entries | `series` (a row in it *is* a library entry) | `id` |
| categories | `categories` | `id` |
| category_membership | `series.categoryIds` | — |
| reading_progress | `progress` | `chapterId` |
| reading_sessions | `sessions` | `id` |
| history | `history` | `chapterId` |
| downloads | `downloads`, `downloadPages` | `chapterId`, `id` |
| sources | `extensions.sources` (+ `mappings.sourceId`) | — |
| extensions | `extensions` | `extensionId` |
| extension_preferences | `extensionPrefs` | `${extensionId}:${key}` |
| tracker_mappings | `mappings` (source), `trackers` in the sync document | `seriesId` |
| library_view_state | `viewState` | `collectionId` (`all` for the whole library) |
| sync_metadata | `syncMeta` | `key` |

Membership is an array on the series row rather than a join table: a series belongs to a handful of
collections, and the library is read as a whole on every launch, so a second store would be a join
for no gain. The same reasoning keeps sources inside the extension rows that expose them.

## reading_progress vs reading_sessions

```
progress  → where to resume right now          one row per chapter, overwritten
sessions  → how the reading actually happened   one row per sitting, never overwritten
```

`progress` carries `page`, `total`, `at` and `completed`. Completion is **sticky**: reaching the last
page marks it, and re-reading from page 1 does not clear it — only an explicit "mark unread" does.

A session is the data model, in full:

```
id                 chapterId@startedAt
seriesId           manga_id
sourceId           source_id — the extension's own id, from the source mapping
chapterId          chapter_id
startedAt          started_at
endedAt            ended_at (absent while the session is open)
startPage          start_page
endPage            end_page
pagesRead          pages_read — |end − start| + 1, so a backward re-read counts honestly
durationSeconds    duration_seconds — whole seconds, measured start to close
completedChapter   completed_chapter — the last page was reached during this session
```

## When a session starts and ends

The rules are pure functions in `src/lib/history.ts`, tested in `tests/unit/history.test.mjs`:

```
starts    the chapter's pages are on screen (not when the row is tapped)
ends      the reader closes (Back, route change, tab gone)
          the chapter changes
          the app has been in the background ≥ 60s   (BACKGROUND_GRACE_MS)
          no page has turned for 5 minutes           (INACTIVITY_TIMEOUT_MS)
continues a background trip shorter than 60s, and a return to the same chapter inside that
          window, reuse the open session instead of writing a new row
```

The grace period is deliberately much shorter than the inactivity timeout: a notification is the
same sitting, a chapter left open overnight is not eight hours of reading. A session that was never
closed stays open in the database and is reported as `open`, not silently repaired.

**A session ends at the last moment reading was real, not at the wall clock of the close.**
`durationSeconds` is `endedAt - startedAt` and the store takes `endedAt` from the caller's `at`, so
the Reader — the only thing that sees the page leave the screen — sends it (`sessionEndAt`):

```
reader   the page is on screen and the reader leaves: now, exactly as before
away     the page went hidden, or the reader is torn down while hidden: the moment it went hidden
idle     the inactivity timeout fired: the last page turn (plateau), never the timer's late fire
```

A backgrounded app, a sleeping tablet or a throttled webview therefore adds no absence to the stored
span: an hour away after 60 s of reading stores 60 s, and growing the absence does not grow it. The
pages, completion, progress, read marks and history rows are untouched by the cutoff — it only
decides where the clock stops.

## Remembering the screen, not just the data

`viewState` is per collection: `sort`, `view`, `coverSize`, `onlyUnread`, `onlySource`, `query`,
`scroll`, `selectedSeriesId`. It is written debounced while the library is used, flushed when the
collection changes, and flushed on `pagehide` / a hidden tab — because a phone app is killed without
unmounting anything. So this survives a relaunch:

```
Library → Reading, sort Last read, filter Unread, scrolled halfway
→ open a title, read Ch. 54 to page 17, close the app
→ reopen: same collection, same sort, same filter, same scroll, Continue Reading at 54/17
```

## Privacy and history controls

`Settings → History` (schema v9 adds a `tombstones` store):

**Pause reading history** — incognito reading. No new `sessions` rows, no new `history` entries, no
reading-time statistics. Everything else keeps working exactly as before: `progress` and `position`
still save, read/unread still updates, Continue Reading still resumes, downloads and the library are
untouched. Existing history is left alone, not hidden.

**Keep reading history** — `Forever` (default), 30 days, 90 days, 6 months, 1 year, or a custom
number of days. Retention applies **only to closed `reading_sessions`**. It never touches
`progress`, read marks, library membership, categories, bookmarks, downloads or Continue Reading. An
open session is the read in progress, so it is never pruned. Cleanup runs at launch and whenever the
setting changes — no background service.

**Clear reading history** — deletes `sessions` and `history`, and nothing else. The confirmation
says what survives:

> Delete all recorded reading sessions and reading-history entries? Your current chapter, page
> progress, read/unread state, library, and downloads will not be changed.

**Clear history by date…** — Today, Last 7 days, Last 30 days, or All time. "Last 7 days" deletes
the records *inside* that window and leaves the older ones; the same rule, historical rows only.

```
Clear History ≠ Reset Reading Progress
```

A future "Reset Reading Progress" must be its own, separately destructive action. Nothing here is
ever deleted automatically unless the user changes retention.

### Deletion travels

Every row removed by a clear or a retention prune leaves a tombstone (`kind: session` or
`kind: history`) in the `tombstones` store, and the sync document carries them. That is what stops
the other device's copy from being merged back in. `applyDocument` still ignores tombstones on
manual import — an import is "bring this in", not "make this device match that one" — so a restore
can only add. Pausing history and the retention setting are ordinary preferences and therefore sync
with everything else; a future "This device only" scope would need its own field, not a silent
exception.

## Backups and paid sync

Sessions travel. They are small metadata — an id, two page numbers, a duration — and without them a
second device's History and Stats are a guess. The sync document (`hardlytracking.sync`, version 2)
carries a `sessions` list with the same fields plus the merge stamp (`at`, `device`), so:

- **Manual backup** (free, always available) exports them, and an import writes them back.
- **Paid automatic sync** mirrors the same document; the raw database file is never uploaded.

Nothing else about content moves: no pages, no images, no APKs, no cookies. `applyDocument` writes
rows and never deletes, so a restore cannot shrink a library.

A v1 document is refused rather than guessed at: "missing list" is not "empty list". Nothing has
shipped, so no v1 document exists outside tests.

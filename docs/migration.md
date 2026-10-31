# Migrating a title to another source

A source dies, is removed, or a better extension carries the same series. The entry, its read marks
and its history must not be stranded on the source that is going away.

**The model is a remap, not a copy.** The library entry keeps its identity — its id, its categories,
its hidden/pinned marks, its tracker links — and one row says which series it reads from. Everything
that resolves a title goes through that row, so nothing else in the app has to know a migration
happened. The same model is what T38 (merging duplicates) records, in the other direction.

## Where it lives

| What | Where |
|---|---|
| The rules: alignment, refusals, the confirm panel | `src/lib/migrate.ts` (pure, 16 tests) |
| The write sequence | `src/lib/migrate-apply.ts` (7 tests against a memory database) |
| Preview + commit, over a store and providers | `state/library.svelte.ts` — `previewMigration`, `migrate`, `remoteOf` |
| The three-step sheet | `components/MigrateSheet.svelte`, opened from the series `⋯` menu |
| The stored row | `mappings` store: `SourceMappingRow` in `lib/db/store.ts` |

## The row

```ts
interface SourceMappingRow {
  seriesId: string;        // the library entry — never changes
  provider: string;        // the source it reads from now
  sourceId: string;        // that provider's own source id, "" when it was never known
  remoteSeriesId?: string; // the series id inside that provider's space (`dalvik:2:https://…`)
  alternates?: AlternateMapping[]; // where it used to live, oldest first
  at: number;
}
```

`remoteSeriesId` is the whole mechanism: `LibraryState.remoteOf(seriesId)` reads it and answers
"which provider, and which id inside it". `details()` and `chapters()` ask that, and store the rows
under **our** id, so unread counts, Continue, Updates and the reader stay on one entry.

The old home is kept as an alternate, so migrating back is the same operation in the other
direction — `currentSeriesId` in `planMigration` is what stops that being mistaken for "the same
series". A `mihon:12` id names no source, so its alternate carries `sourceId: ""` rather than a
guess; the provider and the series id are what switching back needs.

## What moves

- **Read marks** — `read:<chapterId>` prefs, written on the target's chapter id, the old one removed.
- **Progress** — page, total, `completed` and the original `at`, per chapter.
- **History** — rewritten onto the new chapter ids, keeping the time it was read.
- **The bookmark** — the `position` row follows its chapter; it is cleared when that chapter did not
  come across, because a bookmark into a chapter the entry no longer has is a dead end.
- **Downloads** — a chapter whose page count still matches moves its pages onto the new id
  (`rekeyDownload`); one that does not is removed, and the confirm panel says so first.
- **The chapter list** — replaced by the target's, stored under our id.

Not moved, deliberately: **sessions** (they record how the reading happened, on the source it
happened on) and **history rows for chapters the target does not have** (a true fact about a chapter
that still exists on the old source).

## When it refuses

Nothing is written unless the plan is sound. `planMigration` refuses by name:

| Reason | Message shape |
|---|---|
| `same-series` | "That is this title on the source it is already on" |
| `no-chapters` | "…has no chapters on its current source yet" |
| `empty-target` | "…has no chapters on that source, so nothing was moved" |
| `target-shorter` | "That source has 8 chapters and this title has 12" |
| `unnumbered-mismatch` | neither list is numbered, and the counts differ |
| `unmatched-progress` | "Chapter 5 is read here and that source does not have it" |

Alignment is by chapter number (two-decimal precision, repeated numbers consumed in list order).
When **both** lists are unnumbered — an archive of volumes — order is the only signal, and it is used
only when the counts are equal. A read mark or a page position with no counterpart refuses the whole
move; an unread chapter that exists only on the old source is reported in the panel and left behind.

## Marks follow the title

`sourceKeyOf(seriesId, mapping)` prefers the mapping over the id, so a migrated title is governed by
the source it reads from now, not the one its id spells. Its category marks are untouched, because
they were never about the source. (T31/T32: one predicate, every caller.)

## Gates

`npm test` 696/696, `tsc --noEmit` clean, `svelte-check --threshold error` 0 errors, `npm run build`
green. Live at 440×956 against the real Suwayomi fixture: a `mihon:12` entry with a read mark and a
bookmark migrated to a series on this device — the entry kept its id and its category, the mark and
the position moved to the new chapter, the mapping recorded the old source as an alternate, and the
page reloaded on the target's title. A target with no chapters refused with
"Berserk Alt has no chapters on that source, so nothing was moved", the panel said nothing had
changed, and the database was byte-identical afterwards.

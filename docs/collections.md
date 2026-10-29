# Collections: the library model

One row type, two kinds. A shelf is either **manual** (the user put titles in it) or **smart** (a rule
computed from facts the app already stores). Both are `Collection`; both can be pinned, hidden and
ordered; both can be a Library home section.

```
LibraryCollection
├─ id           "c:<n>" manual (a Mihon category) · "s:<system>" built-in · "s:custom" user smart
├─ name         what the user sees ("Reading", "Unread", "Weekly")
├─ kind         "manual" | "smart"
├─ order        0-based, the user's own order
├─ hidden       the eye: its titles leave the library grid
├─ pinned       the pin: sorts first, and may be drawn as a home section
├─ system?      "unread" | "downloaded" | "recent" | "completed"  (built-ins only)
└─ filter?      SmartFilter                                        (smart only)
```

Why one type: implementing categories now and smart shelves later is how an app ends up with
"categories" in one menu and "filters" in another, and neither can be pinned. Mihon compatibility
falls out for free — a Mihon category *is* a manual collection, so an imported backup needs no
translation and an export writes the same ids back.

## Manual collections

Membership lives on the series row (`categoryIds`), which is already the shape of a Mihon backup.
Multiple membership is normal: a title can be in `Reading`, `Favorites` and `Manhwa` at once.

`c:<n>` ↔ Mihon category id `n` (`collectionIdFromCategory` / `categoryIdFromCollection`). The mapping
is total and reversible, so a re-export does not renumber the user's shelves.

## Smart collections

A rule over facts we keep, not over anything we would have to fetch:

```
unread            at least one unread chapter
allRead           every chapter read, and there is at least one chapter
downloaded        at least one chapter on this device
started           a reading position exists
provider          dalvik | mihon | local
sourceId          the Mihon source id from the source mapping
inCollection      also filed under this manual collection
updatedWithinDays newest chapter published inside this window
```

Every field present is ANDed. A missing fact **fails** its test: a title with no chapters is not
"completed", and a source filter does not match a title with no mapping. That is the rule that keeps
a smart shelf from quietly claiming titles it knows nothing about.

Built-ins, in selector order: `Unread`, `Downloaded`, `Recently updated` (14 days), `Completed`.

Custom smart collections are the same structure with their own filter, and they can nest inside a
manual collection (`inCollection`) — which is how "unread titles in Reading" is expressed without a
second mechanism.

## Continue Reading is not a smart collection

It is a position inside a chapter, not a set of titles. The rule:

```
unfinished chapter      → resume at its saved page
finished chapter        → next unread chapter at page 1   (setting: "show next")
                        → or drop the title               (setting: "remove until I start another")
newest first, one entry per title, capped
```

`continueEntries()` takes that shape and returns `{seriesId, chapterId, page, total, at, next}`.
History is a different question ("what have I read", thousands of rows) and is never the
implementation of this one.

## What the library draws

```
Continue Reading          positions, newest first (chapter-level, above everything)
Pinned collections        homeSections(): pinned, not hidden, max 6, Continue excluded
Collection selector       every collection, pinned first, then order
Grid                      titles from every collection that is not hidden
```

Hiding is not deleting: a hidden collection still evaluates, and an uncategorised title is never
hidden by it — "not filed" is not "hidden". With no collections configured at all, the whole library
shows.

## Storage and sync

Stored in the existing `categories` store. `kind`, `system` and `filter` are optional fields, so the
current rows are already valid and there is no database migration. The eye and the pin are the same
two marks the HardlyReader work introduced.

Export/import: manual collections and membership travel as Mihon categories, unchanged. Smart
collections are local until the sync document gains a `collections` collection (format version 2);
until then they are not exported rather than exported into a format that would drop them.

## What this deliberately does not do

- No dedicated Home tab. Library is the landing page; sections are optional and reorderable.
- No rule that needs a network call. Every field above is already in the device database.
- No automatic "Currently reading" category that the user cannot delete. The built-ins can be
  hidden; Continue Reading can be turned off in settings.

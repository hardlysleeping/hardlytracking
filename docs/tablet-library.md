# The tablet library layout

The rule: **a tablet is not a bigger phone.** Komikku is the familiarity bar on a tablet — categories
always reachable, a dense grid, unread/download/source visible, filters and sort at hand, bulk actions
that do not cover the thing being selected, and a resume that is one tap. The layout below keeps all
of that, and the collection model underneath (`docs/collections.md`) makes it more capable than a
fixed category list.

Encoded in `src/lib/layout-modes.ts` and tested in `tests/unit/layout-modes.test.mjs` — the numbers
here and the numbers in the tests are the same numbers.

## Device classes

```
phone    < 600
tablet   600 – 1279      (iPad landscape is 1024–1180: not a desktop)
desktop  ≥ 1280
```

Width alone is not enough for the split. A tablet splits into grid + detail only when it is at least
1000 wide **and** 600 tall: a 1100×560 window has no height for a detail pane and stays single.

## The four shapes

### Phone — one pane, collections as chips

```
Library                    🔍 ⋯
All  Reading  Favorites  +      ← chips, horizontally scrolling
Filter · Sort · density

Continue reading  [ A ][ B ] →
(cover) (cover)
```

Selecting a title replaces the grid. Bulk actions float above the bottom bar. Resume lives in the
long-press menu.

### Tablet portrait — collections as a column, detail still replaces

```
┌────────────┬──────────────────────────────┐
│ Collections│ Library                  🔍 ⋯ │
│            │ Continue reading [A][B] →    │
│ All        │ Filter · Sort · Density      │
│ Reading  ● │ ┌────┐ ┌────┐ ┌────┐ ┌────┐  │
│ Favorites  │ │cov │ │cov │ │cov │ │cov │  │
│ Manhwa     │ └────┘ └────┘ └────┘ └────┘  │
│ Completed  │ title  title  title  title    │
│ + New      │ 3 unread  Ch.52  ↓   ✓        │
└────────────┴──────────────────────────────┘
```

A 768-wide screen cannot hold a collection list, a usable grid and a readable detail pane at once, so
detail replaces the grid — but the collection column stays, because switching collections is the
thing that must never take extra steps.

### Tablet landscape — grid + detail

```
┌────────────┬───────────────────────┬──────────────────────┐
│ Collections│ Library          🔍 ⋯ │ ← Manga title    ⋯   │
│            │ Continue reading →    │  (cover)  title       │
│ All        │ Filter · Sort         │           author      │
│ Reading  ● │ ┌────┐ ┌────┐ ┌────┐  │ [Continue] [+ Library]│
│ Favorites  │ │cov │ │cov │ │cov │  │ description…          │
│ Manhwa     │ └────┘ └────┘ └────┘  │ Chapters   filter/sort│
│            │ ┌────┐ ┌────┐ ┌────┐  │ 120 Chapter 120    ↓  │
│            │ └────┘ └────┘ └────┘  │ 119 Chapter 119    ✓  │
└────────────┴───────────────────────┴──────────────────────┘
```

The grid keeps its selection, so tapping a second title swaps the pane rather than leaving the shelf.
The detail pane scrolls on its own.

### Desktop — three panes

```
┌──────────┬──────────────┬───────────────────┬────────────────────┐
│ Library  │ Collections  │ Grid              │ Detail             │
│ Updates  │ All          │ ┌───┐ ┌───┐ ┌───┐ │ cover  title       │
│ Browse   │ Reading    ● │ └───┘ └───┘ └───┘ │ chapters           │
│ History  │ Favorites    │ ┌───┐ ┌───┐ ┌───┐ │                    │
│ More     │ + New        │ └───┘ └───┘ └───┘ │                    │
└──────────┴──────────────┴───────────────────┴────────────────────┘
```

## Rules that hold in every shape

**Collections are one tap, never a sheet.** Chips on a phone, a persistent column everywhere else.
The column collapses to a rail of the same rows (not to nothing) when the user wants the width.

**Density is a number, not a mode.** `comfortable 148 / compact 112 / dense 88`. Tablets and desktops
default to `compact` (grid min 112); phones to 132. Columns are computed, never fixed: at least two,
at most eight.

**Metadata shrinks with the cover.** At `comfortable`: title + unread/download badges + source and
language. At `compact`: title + badges. At `dense`: badges only, title on hover/long-press. Source
and language are shown because Komikku shows them and a library with three MangaDex sources needs it.

**Resume without opening the detail page.** Phone: long-press menu → Resume. Tablet: a corner control
on the tile, always visible. Desktop: on hover, and double-click resumes. Resume opens the reader at
the exact page; the detail page is for chapters, categories and metadata.

**Filters and sort are inline, not sheets.** One row above the grid; active filters show as removable
chips. A sheet is the phone's answer to a small screen, not the tablet's.

**Selection is bulk-first.** Long-press enters selection on touch, hover shows a checkbox and
shift-click selects a range on desktop. The action bar is pinned to the bottom of the grid column on
tablet and desktop (a floating bar would cover the covers), and floats above the bottom bar on a
phone. Actions: Download unread, Mark read/unread, Add to collection, Remove from collection, Migrate,
Remove from library.

**Pane widths are remembered.** Collection 176–264 on a tablet, 200–280 on a desktop; detail 340–460
and 360–520. Clamped, persisted, and a collapsed column does not lose its width.

**Reader preferences are per device class.** A tablet keeps its own mode (spread, RTL, preload,
brightness, orientation lock) so a phone's single-page setting never lands on it. `readerProfile()`
keys the preference set.

## What is deliberately not here

- No dedicated Home tab. Library is the landing page; pinned collections become sections on it.
- No hover-only actions on touch, and no tap-only actions on desktop: every action above has a touch
  and a pointer path.
- No grid that reflows while images load: covers reserve their 2:3 box, so a density change is the
  only thing that moves the grid.

## Status

Defined and encoded: `layout-modes.ts` (device classes, four shapes, densities, columns, pane widths,
selection-bar placement, reader profile keying), 13 tests.

Not yet wired: the Library view still renders the phone layout at every width. Wiring means replacing
`viewport.size` checks in `Library.svelte` with `libraryLayout(viewport.width, viewport.height)`, adding
the collection column and the detail pane, and persisting the density and pane widths in `settings`.

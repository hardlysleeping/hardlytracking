# The tablet library layout

The rule: **a tablet is not a bigger phone, and the phone is not a cut-down tablet.** Komikku is the
familiarity bar on a tablet — categories at hand, dense grid, badges, filters and sort nearby,
one-tap resume, bulk selection. The same model collapses to a phone and expands to a desktop with
only the presentation changing.

Encoded in `src/lib/layout-modes.ts`, tested in `tests/unit/layout-modes.test.mjs` (22 tests). The
numbers in this document and the numbers in the tests are the same numbers.

## Device classes

```
phone    < 600
tablet   600 – 1279      iPad landscape is 1024–1180, so it is not a desktop
desktop  ≥ 1280
```

Chrome: no rail on a phone, a 76px rail on a tablet, a 224px sidebar on a desktop. The library's own
decisions are then made on **usable width** — viewport minus chrome minus 32px padding — never on the
device name.

## Category navigation: tabs, overflow, or a sidebar

The most important choice on a landscape tablet, so all three exist and the default is `Automatic`:

```
Settings → Library → Category navigation
  ● Automatic
  ○ Tabs
  ○ Sidebar
```

| Usable width | Automatic | Forced Tabs | Forced Sidebar |
|---|---|---|---|
| < 750 (portrait tablet) | tabs, scrolling | tabs | falls back to tabs |
| 750 – 1050 | tabs | tabs | sidebar only if the grid keeps 420px |
| > 1050 | sidebar | tabs | sidebar |

- Up to **8 collections**, the bar scrolls horizontally — a Komikku user expects to swipe the bar.
- Past 8, the bar shows what fits plus a `+N` control; **pinned collections are never behind it**.
- The sidebar is 20% of usable width, clamped 200–280px, and is only chosen when the grid would still
  have its 420px minimum. That is the "doesn't meaningfully reduce the manga grid" test.
- Unread counts optionally sit beside collection names in the sidebar.
- Manual and smart collections look identical in the bar and the sidebar; only the editor differs.

## Split pane

One shared `paneMode` resolver decides single vs split. Library and Search pass it the content width
left after navigation, padding and the category sidebar, plus the saved `settings.libraryPane` choice.
The `single` choice stays single; `auto` and `split` use the same availability rule. If the saved
choice cannot fit, the view temporarily renders one pane without changing that preference.

```
content width < 750 or below pane floors   single pane
content width ≥ 750 and height ≥ 600       split available to auto/split
short landscape with enough width           split available
single preference                           always one pane
```

Default ratio 58 / 42, draggable between 45 / 55 and 75 / 25, remembered per device. Detail pane
clamped 340–520px. Tapping a second title swaps the pane; the library keeps its scroll and selection.
The reader always opens full-screen, and Back returns to the same collection, filters, scroll and
selected title.

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

### Tablet portrait — collection bar, detail replaces

```
Library                          🔍 Filter Sort ⋯
All  Reading  Favorites  Manhwa  +
Continue reading [A][B][C] →                    ⌄
┌────┐ ┌────┐ ┌────┐ ┌────┐
│cov │ │cov │ │cov │ │cov │
└────┘ └────┘ └────┘ └────┘
title  title  title  title
4 ●↓   ✓     12 ↓   Ch.45
```

A 768-wide screen cannot hold a collection list, a usable grid and a readable detail pane at once, so
the collections stay a scrolling bar and detail replaces the grid.

### Tablet landscape — sidebar + grid + detail

```
┌────────────┬───────────────────────┬──────────────────────┐
│ Collections│ Library          🔍 ⋯ │ ← Manga title    ⋯   │
│            │ Continue reading →    │  (cover)  title       │
│ All    142 │ Filter · Sort         │           author      │
│ Reading 32 │ ┌────┐ ┌────┐ ┌────┐  │ [Continue] [+ Library]│
│ Favorites18│ │cov │ │cov │ │cov │  │ description…          │
│ Manhwa  27 │ └────┘ └────┘ └────┘  │ Chapters   filter/sort│
│ Completed49│ ┌────┐ ┌────┐ ┌────┐  │ 120 Chapter 120    ↓  │
│ + Collection│ └────┘ └────┘ └────┘ │ 119 Chapter 119    ✓  │
└────────────┴───────────────────────┴──────────────────────┘
```

### Desktop — navigation, collections, grid, detail

```
┌──────────┬──────────────┬───────────────────┬────────────────────┐
│ Library  │ Collections  │ Grid              │ Detail             │
│ Updates  │ All       142│ ┌───┐ ┌───┐ ┌───┐ │ cover  title       │
│ Browse   │ Reading    32│ └───┘ └───┘ └───┘ │ chapters           │
│ History  │ Favorites  18│ ┌───┐ ┌───┐ ┌───┐ │                    │
│ More     │ + Collection │ └───┘ └───┘ └───┘ │                    │
└──────────┴──────────────┴───────────────────┴────────────────────┘
```

## Grid and density

Cover width, not column count, is the setting. Columns are computed from the width and clamped 2–8:

```
compact      88px   badges only              8–10 across on a 12–13" tablet
comfortable 112px   title + badges            6–8 across              ← tablet default
large       148px   title + badges + source   4–5 across              ← phone default
```

Changing the split ratio changes the column count, because the grid is `auto-fill` over the cover
width. There is no "iPad Pro gets seven columns" branch anywhere.

## Manga card

```
┌────────────┐  4      ← unread
│   COVER    │  ↓2     ← downloaded
└────────────┘  ●       ← new chapter
Manga Title
MD · EN                ← source + language, comfortable/large only
```

Badges are opt-in per kind. Defaults: **unread, downloaded, new**. Optional: source, language,
tracker. A compact 88px cover refuses source and language even when enabled — at that size they are a
smudge, and `badgesFor()` enforces it rather than leaving it to CSS.

The grid stays the dominant element: Continue Reading and pinned collections are one compact row
above it, collapsible, and never a dashboard.

## Selection

- Long press enters selection; a tap then toggles.
- Range: long-press-and-drag from A to F on touch, shift-click on a pointer, ctrl/cmd-click toggles.
- Dragging to reorder must not start a selection, so Manual sort owns the drag gesture and selection
  owns long-press-without-movement.
- The bar reads **"Select all 42 filtered"** when filters are active, never a silent "select all
  3 000" (`selectAllLabel`).
- The bar is pinned to the bottom of the grid column wherever there is a sidebar or a split; it floats
  above the bottom bar only on a phone, where there is nothing to cover.
- Direct on the bar: Read, Download, Collection, More (unread, remove downloads, track, migrate,
  remove from library). The common ones are not buried in an overflow.

## Per-collection state

Each collection remembers its own sort and filters, and the defaults are:

```
All        → Title
Reading    → Last read
Favorites  → Manual (drag to reorder)
Continue   → Last read
Recent     → Last updated
```

Navigating into the reader and back must preserve: collection, filters, sort, grid scroll, selected
title, split width, and the search query. A tablet library that rebuilds itself on every return is
the thing this section exists to prevent.

Filters compose with the collection as another dimension (`collection + unread + MangaDex`), and
active filters stay visible as removable chips with Clear all — never a filter that hides titles
without saying which one did it.

## Keyboard and pointer

```
↑ ↓ ← →         move focus in the grid
Enter           open the focused title (detail pane or page)
Space           resume, where a resume is available
Cmd/Ctrl+F      library search
Shift+click     range select
Cmd/Ctrl+click  toggle select
Esc             close selection, then the detail pane
```

Hover shows the resume control and the checkbox; right-click opens the same context menu as long
press; drag reorders when the sort is Manual. Every action above also has a touch path.

## Empty and error states

```
no filter results      "No manga match these filters."        [Clear filters]
empty collection       "Nothing in Reading yet."              [Browse sources]
offline, stale covers  "Library is available offline. Some source information could not be refreshed."
```

Never a blank pane.

## Reader

Full-screen, never inside the pane, and familiar to a Komikku user: RTL / LTR / vertical / webtoon,
page preload, tap zones that follow the reading direction, background, fit behaviour, brightness,
orientation lock — with preferences keyed per device class so a tablet spread never lands on a phone.

## Performance targets

5 000 titles, 50 000 chapters: virtualised grid, lazy cover decode, a thumbnail cache, incremental
filtering, and no full-grid re-render when one read state changes. Komikku's fast-browsing work is
the signal that this belongs in the design, not in a later optimisation pass.

## First install on a tablet

```
category navigation   Automatic
grid density          Comfortable
Continue Reading      shown, one compact row
pinned collections    none
badges                unread + downloaded + new
sort                  Title (All), Last read (Continue)
split                 Automatic
filters               none
source/language badge off
multi-select          long press
reader                full-screen, its own tablet preferences
```

Simple on first open, power one tap away.

## What is deliberately not here

- No dedicated Home tab. Library is the landing page; pinned collections become sections on it.
- No hover-only actions on touch, and no tap-only actions on desktop: every action above has a touch
  and a pointer path.
- No grid that reflows while images load: covers reserve their 2:3 box, so a density change is the
  only thing that moves the grid.
- No separate tablet app. Phone, tablet and desktop share `LibraryCollection`, `LibraryQuery`,
  `LibrarySort`, `LibrarySelection`, `MangaCard` and `MangaDetails`; only presentation changes.

## Status

**Wired.** `Library.svelte` asks `libraryLayout(width, height, options)` for the shape and only draws it;
`AppShell` takes its chrome from the same `deviceClass`, so the rail a screen sees is the width the
library subtracted.

- **Category navigation** — chips up to capacity, then a `+N` sheet (`collectionBar` lifts pinned
  collections and never puts one behind the control), or the collection column when the Automatic rule
  picks a sidebar. `Categories…` is in both places, so the rail is one tap away at every width.
- **Split pane** — `SeriesPage embedded` beside the grid, the picked tile highlighted, and a divider that
  drags the ratio (clamped 45/55–75/25, remembered in `settings.splitRatio`). In a split a tap swaps the
  pane instead of pushing a route; everywhere else a tap still opens the series page. Long press still
  enters selection, and a selection click never swaps the pane.
- **Density** — `settings.libraryDensity` is `auto` (the device class's own default: 148 phone,
  112 tablet/desktop), a named preset, or `manual` (the cover-size slider, which the sliders in Settings
  and the Filter sheet select). `coverWidth()` is the one rule.
- **Category navigation preference** — `settings.categoryNav`: Automatic / Tabs / Sidebar.

Measured in the browser at 390 / 768 / 1180 / 1440: bar / rail / rail / sidebar chrome; cover 148 / 112 /
112 / 112; columns 2 / 5 / 3 / 4; detail pane absent / absent / 360 / 398.

The former middle-band `forceSplit` switch is removed: Library, Search and History use the shared pane
mode resolver with their own content-width constraints. `selectionBar: "pinned"` still only moves the
floating bar's offset rather than docking it in the column.

/**
 * The library's shape, per screen — decided here, drawn by the view.
 *
 * The rule the plan settled on: **a tablet is not a bigger phone, and the phone is not a cut-down
 * tablet.** Komikku is the familiarity bar on a tablet (category switching always at hand, dense
 * grid, badges, filters and sort nearby, one-tap resume, bulk selection), and the same model scales
 * down to a phone and out to a desktop with only the presentation changing.
 *
 * Everything here is pure: pixels and preferences in, a decision out. The view reads the decision;
 * the tests read the same numbers, so a layout cannot drift from its spec without a failing test.
 */

import { paneMode, type PanePreference } from "./view-options";

export type DeviceClass = "phone" | "tablet" | "desktop";

/** Where the collection list lives. */
export type CategoryNav = "tabs" | "overflow" | "sidebar";

/** What the user asked for in Settings → Library → Category navigation. */
export type CategoryNavPreference = "automatic" | "tabs" | "sidebar";

export type Density = "compact" | "comfortable" | "large";

export type ResumeAffordance = "menu" | "always" | "hover";

export type Badge = "unread" | "downloaded" | "new" | "source" | "language" | "tracker";

export interface CategoryNavPlan {
  mode: CategoryNav;
  /** Collections drawn in the bar. Zero when the list is a sidebar. */
  visible: number;
  /** Collections behind the `+N` control. */
  overflow: number;
  /** Pinned collections are always in `visible`, whatever the overflow count. */
  pinned: number;
}

export interface LibraryLayout {
  device: DeviceClass;
  /** `single` is one pane; `split` puts the detail beside the grid. */
  mode: "single" | "split";
  categoryNav: CategoryNavPlan;
  /** Width of the collection sidebar when `categoryNav.mode === "sidebar"`. */
  sidebarWidth: number;
  /** Width of the grid, once the rail, sidebar and detail pane take theirs. */
  gridWidth: number;
  detailWidth: number;
  /** Width of the reading column in three-pane mode, 0 when there is no third pane. */
  thirdWidth: number;
  /** The grid/detail split, 0 when there is no pane. */
  splitRatio: number;
  density: Density;
  resume: ResumeAffordance;
  selectionBar: "floating" | "pinned";
}

export interface LayoutOptions {
  nav?: CategoryNavPreference;
  collectionCount?: number;
  pinnedCount?: number;
  /** In three panes, the shelf's share of the room above the three floors. */
  splitRatio3?: number;
  /** In three panes, the series column's share of the room the shelf leaves. */
  detailShare?: number;
  /** A remembered ratio from the user dragging the divider. */
  splitRatio?: number;
  /**
   * Settings → Library → Library panes. `single` never splits and `split` splits as soon as the
   * window has enough height and content width; automatic follows the same available-width rule.
   */
  pane?: PanePreference;
  /**
   * The narrowest the shelf may be left when a split is drawn.
   *
   * It used to be a constant (420), which on a laptop meant two panes never appeared at all. It is
   * a preference now, because how narrow a column of covers is still readable is the reader's call.
   */
  minGridWidth?: number;
}

/**
 * Phone below 600, tablet to 1279, desktop above — measured on the **shorter side**.
 *
 * Width alone turned an iPhone on its side into a small tablet: 844×390 has the width of a tablet and
 * the height of a phone, so it was given the 76 px rail, the rail's labels did not fit the space it
 * left, and the screen it was drawing into had 390 px to do it in. A phone is a phone horizontal or
 * vertical; what changes is which edge the notch is on, which is the safe area's business and not the
 * breakpoint's. A tablet in landscape (1024×768) is still a tablet, and a desktop window dragged short
 * stays a desktop rather than becoming a phone.
 */
export function deviceClass(width: number, height: number = width): DeviceClass {
  // Only the *phone* test looks at the shorter side: it is what tells "a phone on its side" apart from
  // "a small tablet". Past that, width decides — a 1280×900 desktop window is a desktop, not a tablet
  // with a wide rail, which is what a shortest-side rule would have made of it.
  if (Math.min(width, height) < 600) return "phone";
  if (width < 1280) return "tablet";
  return "desktop";
}

/**
 * Navigation chrome outside the library column.
 *
 * One width for every screen that has a nav column. A 1280 breakpoint used to trade 148 px of
 * shelf for labels beside the icons, so dragging a window wider suddenly shrank the library —
 * a panel of chrome should not get bigger because there is more room.
 */
export function railWidth(device: DeviceClass): number {
  return device === "phone" ? 0 : 76;
}

export const PAGE_PADDING = 32;
export const MIN_GRID_WIDTH = 420;
/**
 * The narrowest the shelf may be: the width of its own display menu.
 *
 * The row/grid/cards switcher is three options of 52 px inside a frame, which is ~170 px — below
 * that the menu wraps and the row of buttons becomes two rows of debris. A pane's floor should be
 * where its controls stop working, not a number someone can drag past.
 */
export const MIN_SHELF_WIDTH = 200;
export const MIN_DETAIL_WIDTH = 340;
export const MAX_DETAIL_WIDTH = 520;
/** The narrowest a reading column may be: two pages, or one page and its margins. */
export const MIN_READER_WIDTH = 420;
export const MIN_SIDEBAR_WIDTH = 200;

/** Cover widths. `comfortable` is the tablet default; `compact` is for very large libraries. */
export const DENSITIES: Record<Density, number> = { compact: 88, comfortable: 112, large: 148 };

/**
 * What the user chose in Settings → Library → Density.
 *
 * `auto` is the device class's own default (so a tablet is comfortable without anyone picking),
 * `manual` is the cover-size slider, and a named preset wins over both.
 */
export type DensityPreference = Density | "auto" | "manual";

export const DENSITY_OPTIONS: Array<{ id: DensityPreference; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "compact", label: "Compact" },
  { id: "comfortable", label: "Comfortable" },
  { id: "large", label: "Large" },
  { id: "manual", label: "Custom" },
];

/** A phone reads large covers; a tablet starts comfortable, which is the denser grid. */
export function defaultDensity(device: DeviceClass): Density {
  return device === "phone" ? "large" : "comfortable";
}

/**
 * The cover width `auto` draws, per device class.
 *
 * Not the named densities: a 900 px tablet at the phone's "comfortable" 112 fits seven columns,
 * which is a wall of thumbnails, not a shelf. These widths land the same component on 2 / 3 / 4 / 6
 * columns at 390 / 600 / 900 / 1400 px — the plan's own numbers — and a named density still wins,
 * because a user who picked "Compact" meant it.
 */
export const AUTO_COVER: Record<DeviceClass, number> = { phone: 148, tablet: 180, desktop: 200 };

/** The cover width a library draws, from the preference and the slider. */
export function coverWidth(preference: DensityPreference, device: DeviceClass, coverSize: number): number {
  if (preference === "manual") return coverSize;
  if (preference === "auto") return AUTO_COVER[device];
  return DENSITIES[preference];
}

/**
 * Which collections the bar draws, and which go behind the `+N` control.
 *
 * Pinned collections are lifted to the front and are never behind the control — that is what
 * pinning is for. The rest keep the user's own order, and a sidebar has no bar at all.
 */
export function collectionBar<T extends { pinned: boolean }>(
  items: T[],
  plan: CategoryNavPlan,
): { shown: T[]; overflow: T[] } {
  if (plan.mode === "sidebar") return { shown: [], overflow: [] };
  const ordered = [...items.filter((item) => item.pinned), ...items.filter((item) => !item.pinned)];
  if (plan.mode === "tabs") return { shown: ordered, overflow: [] };
  const take = Math.max(plan.visible, 0);
  return { shown: ordered.slice(0, take), overflow: ordered.slice(take) };
}

/** Minimum content width for a Library pane split, after navigation and sidebar chrome. */
export const LIBRARY_SPLIT_MIN_WIDTH = 750;
/** Automatic category sidebar breakpoint; independent of the pane-mode decision. */
export const CATEGORY_SIDEBAR_AUTO_AT = 1050;
export const MIN_SPLIT_HEIGHT = 600;

/**
 * Past this many collections the bar gets a `+N` control.
 *
 * Below it the chips scroll, which is what a Komikku user expects; above it a scrolling bar becomes a
 * memory test, so the pinned few stay and the rest move behind one control.
 */
export const OVERFLOW_AT = 8;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * How many collection chips fit in a bar of `usable` px.
 *
 * 150 px each is measured, not guessed: "Completed" plus its padding and the gap is about that. The
 * `+N` control itself takes a slot when it is needed.
 */
export function chipCapacity(usable: number): number {
  return Math.max(Math.floor(usable / 150), 1);
}

/**
 * Where collections go.
 *
 * - `tabs`: everything fits, so the bar is the list.
 * - `overflow`: the bar shows what fits and the rest go behind `+N` — never a 30-item scroller.
 * - `sidebar`: a column, only when there is width that does not come out of the grid's minimum.
 *
 * Pinned collections are always visible, which is the point of pinning them.
 */
export function categoryNavPlan(
  usable: number,
  preference: CategoryNavPreference,
  collectionCount: number,
  pinnedCount = 0,
): CategoryNavPlan {
  const count = Math.max(collectionCount, 0);
  const pinned = clamp(pinnedCount, 0, count);
  const capacity = chipCapacity(usable);

  // A sidebar is only worth its width if the grid still has a usable minimum beside it.
  const sidebarFits = usable - sidebarWidth() >= MIN_GRID_WIDTH;
  const wantsSidebar = preference === "sidebar" || (preference === "automatic" && usable >= CATEGORY_SIDEBAR_AUTO_AT);

  if (wantsSidebar && sidebarFits) {
    return { mode: "sidebar", visible: 0, overflow: 0, pinned };
  }
  // Up to eight, the bar scrolls. Past that, a `+N` control is easier to aim at than a scroller.
  if (count <= OVERFLOW_AT) {
    return { mode: "tabs", visible: count, overflow: 0, pinned };
  }
  const visible = Math.max(capacity, Math.min(pinned, capacity));
  return { mode: "overflow", visible, overflow: Math.max(count - visible, 0), pinned };
}

/**
 * The sidebar's width: one list, at one width.
 *
 * It was a fifth of the window, clamped at 280 — so widening the window widened the list, and a
 * column of category names stole room from the shelf every time the frame grew. A sidebar is
 * chrome; chrome does not resize because the window did.
 */
export function sidebarWidth(): number {
  return MIN_SIDEBAR_WIDTH;
}

/** Columns for a grid of `available` px at a cover width, clamped 2–8. */
export function columns(available: number, min: number, gap = 12): number {
  if (available <= 0 || min <= 0) return 2;
  return clamp(Math.floor((available + gap) / (min + gap)), 2, 8);
}

/** What a tile can say at a given density. */
export function tileMeta(density: Density): "badges" | "title+badges" | "title+badges+source" {
  if (density === "compact") return "badges";
  if (density === "comfortable") return "title+badges";
  return "title+badges+source";
}

/** Badges are opt-in per kind; these three are the default because they answer "what now?". */
export const DEFAULT_BADGES: Badge[] = ["unread", "downloaded", "new"];

/** Everything a card can show, in the order it appears. */
export const BADGE_OPTIONS: Badge[] = ["unread", "downloaded", "new", "source", "language", "tracker"];

/**
 * The badges a card draws, filtered to what the density has room for.
 *
 * A compact cover shows counts only: a source icon on an 88px cover is a smudge.
 */
export function badgesFor(density: Density, enabled: Badge[] = DEFAULT_BADGES): Badge[] {
  const allowed = tileMeta(density) === "badges" ? ["unread", "downloaded", "new"] : BADGE_OPTIONS;
  return enabled.filter((badge) => allowed.includes(badge));
}

/**
 * The library's shape for a viewport.
 *
 * The device class decides the chrome (rail or not); the *usable* width decides the split and the
 * collection navigation. That separation is what stops "iPad Pro gets seven columns" logic appearing.
 */
export function libraryLayout(width: number, height: number, options: LayoutOptions = {}): LibraryLayout {
  const device = deviceClass(width, height);
  const usable = Math.max(width - railWidth(device) - PAGE_PADDING, 0);
  const preference = options.nav ?? "automatic";
  const collectionCount = options.collectionCount ?? 0;
  const pinnedCount = options.pinnedCount ?? 0;

  const nav = categoryNavPlan(usable, preference, collectionCount, pinnedCount);
  const sidebar = nav.mode === "sidebar" ? sidebarWidth() : 0;
  const gridSpace = Math.max(usable - sidebar, 0);

  // A phone on its side is short but wide, and two panes side by side is exactly what that shape
  // wants; the height test is there to stop a *portrait* phone splitting into two slivers. A Duo
  // opened flat lands here too: wide enough is the whole test.
  const landscape = width > height;
  const tallEnough = height >= MIN_SPLIT_HEIGHT || (landscape && width >= LIBRARY_SPLIT_MIN_WIDTH);
  const minGrid = clamp(options.minGridWidth ?? MIN_SHELF_WIDTH, MIN_SHELF_WIDTH, MIN_GRID_WIDTH);
  const panePreference = options.pane ?? "auto";
  const paneConstraints = {
    list: minGrid,
    detail: MIN_DETAIL_WIDTH,
    gutter: 0,
    splitAt: LIBRARY_SPLIT_MIN_WIDTH,
    automaticAt: LIBRARY_SPLIT_MIN_WIDTH,
  };
  // The resolver receives the room left after the nav rail, padding and category sidebar. A short
  // portrait gets zero eligible width; a short landscape keeps its real room to divide.
  const splitWidth = tallEnough ? gridSpace : 0;
  const wanted = paneMode(panePreference, splitWidth, paneConstraints) === "split";
  /*
   * The split is a *share* of the room, and the room is whatever the window has.
   *
   * The detail pane used to be a width in pixels, pinned between 340 and 520. That made the shelf
   * the only pane that answered a resize: every pixel the window lost came out of the grid while
   * the detail sat at its number, and widening the window stopped giving the detail anything once
   * it hit 520. Both panes follow the share now — the divider sets the shape, the window sets how
   * much of it there is — and only the two floors are fixed numbers.
   */
  const floorShare = gridSpace > 0 ? minGrid / gridSpace : 0.5;
  const ceilingShare = gridSpace > 0 ? 1 - MIN_DETAIL_WIDTH / gridSpace : 0.5;
  const given = options.splitRatio;
  const asked = typeof given === "number" && Number.isFinite(given) ? given : 0.58;
  const ratio = Math.min(Math.max(asked, floorShare), Math.max(floorShare, ceilingShare));
  /*
   * Three panes are the shelf, the series and the chapter — the shape HardlyReader ships, one
   * column further along. The reading column is the one that has to be honest: a page squeezed
   * under 420px is a page with its margins eaten, so when the window cannot hold all three the
   * reader is what steps aside (two panes), then the series (one pane). Floors, not guesses.
   */
  const canHoldThree = gridSpace >= minGrid + MIN_DETAIL_WIDTH + MIN_READER_WIDTH;
  const three = wanted && panePreference === "three" && canHoldThree;
  /*
   * Three columns divide the room that is *above their floors*, not the window.
   *
   * Giving the shelf its share of the window first was the bug behind "the handles do nothing" in
   * three panes: at a 1440 window the shelf took 58% of 1424, which left the series and the chapter
   * exactly their floors — so both seams were pinned and neither handle had anywhere to go. Now
   * every column starts at its floor and the two shares divide the slack, which means each seam has
   * room to move at any window wide enough to hold three at all.
   */
  const given3 = options.splitRatio3;
  const shelfShare3 = typeof given3 === "number" && Number.isFinite(given3) ? Math.min(Math.max(given3, 0), 1) : 0.58;
  const givenDetail = options.detailShare;
  const seriesShare = typeof givenDetail === "number" && Number.isFinite(givenDetail) ? Math.min(Math.max(givenDetail, 0), 1) : 0.4;
  const slack = three ? gridSpace - minGrid - MIN_DETAIL_WIDTH - MIN_READER_WIDTH : 0;
  const shelfWidth = !wanted
    ? gridSpace
    : three
      ? minGrid + Math.round(slack * shelfShare3)
      : Math.min(Math.round(gridSpace * ratio), gridSpace - MIN_DETAIL_WIDTH);
  const rest = gridSpace - shelfWidth;
  const seriesSlack = three ? rest - MIN_DETAIL_WIDTH - MIN_READER_WIDTH : 0;
  const detailWidth = !wanted
    ? 0
    : three
      ? MIN_DETAIL_WIDTH + Math.round(seriesSlack * seriesShare)
      : rest;
  const split = wanted && detailWidth >= MIN_DETAIL_WIDTH;
  const thirdWidth = split && three ? gridSpace - shelfWidth - detailWidth : 0;

  return {
    device,
    mode: split ? "split" : "single",
    categoryNav: nav,
    sidebarWidth: sidebar,
    gridWidth: Math.max(split ? shelfWidth : gridSpace, 0),
    detailWidth: split ? detailWidth : 0,
    thirdWidth,
    splitRatio: split ? ratio : 0,
    density: defaultDensity(device),
    resume: device === "phone" ? "menu" : device === "tablet" ? "always" : "hover",
    selectionBar: nav.mode === "sidebar" || split ? "pinned" : "floating",
  };
}

/**
 * The selection bar's label for "select all".
 *
 * With filters active, "all" means the results on screen — not the 3 000 titles behind them. Saying
 * which is the difference between a bulk action and a mistake.
 */
export function selectAllLabel(visible: number, total: number): string {
  if (visible === total) return `Select all ${total}`;
  return `Select all ${visible} filtered`;
}

/**
 * Each collection remembers its own sort; these are the defaults a first install uses.
 *
 * Continue Reading is a resume list, so it sorts by last read whatever the rest of the library does.
 */
export function defaultSort(collectionId: string): "title" | "lastRead" | "lastUpdated" | "dateAdded" {
  if (collectionId === "s:continue") return "lastRead";
  if (collectionId === "s:recent") return "lastUpdated";
  return "title";
}

/** Reader preferences are keyed per device class: a tablet spread is wrong on a phone. */
export function readerProfile(device: DeviceClass): "phone" | "tablet" | "desktop" {
  return device;
}

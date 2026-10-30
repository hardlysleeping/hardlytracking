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
  /** True in the middle band, where a split is possible but not forced. */
  optionalSplit: boolean;
  categoryNav: CategoryNavPlan;
  /** Width of the collection sidebar when `categoryNav.mode === "sidebar"`. */
  sidebarWidth: number;
  /** Width of the grid, once the rail, sidebar and detail pane take theirs. */
  gridWidth: number;
  detailWidth: number;
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
  /** A remembered ratio from the user dragging the divider. */
  splitRatio?: number;
  /** The user asked for a split in the middle band. */
  forceSplit?: boolean;
}

/** Phone below 600, tablet to 1279, desktop above. iPad landscape (1024–1180) is a tablet. */
export function deviceClass(width: number): DeviceClass {
  if (width < 600) return "phone";
  if (width < 1280) return "tablet";
  return "desktop";
}

/** Navigation chrome outside the library column. */
export function railWidth(device: DeviceClass): number {
  if (device === "desktop") return 224;
  if (device === "tablet") return 76;
  return 0;
}

export const PAGE_PADDING = 32;
export const MIN_GRID_WIDTH = 420;
export const MIN_DETAIL_WIDTH = 340;
export const MAX_DETAIL_WIDTH = 520;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 280;

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

/**
 * The split is a question about *usable* width, not device width.
 *
 *   < 750    single pane, always
 *   750–1050 a split is possible but the user opts in
 *   > 1050   split by default
 *
 * And it needs height: a 1100×520 window has no room for a detail pane that can be read.
 */
export const SPLIT_OPTIONAL_AT = 750;
export const SPLIT_DEFAULT_AT = 1050;
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
  const sidebarFits = usable - sidebarWidth(usable) >= MIN_GRID_WIDTH;
  const wantsSidebar = preference === "sidebar" || (preference === "automatic" && usable >= SPLIT_DEFAULT_AT);

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

/** The sidebar's width: a fifth of the space, clamped so it stays a list and not a wall. */
export function sidebarWidth(usable: number): number {
  return clamp(usable * 0.2, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
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
  const device = deviceClass(width);
  const usable = Math.max(width - railWidth(device) - PAGE_PADDING, 0);
  const preference = options.nav ?? "automatic";
  const collectionCount = options.collectionCount ?? 0;
  const pinnedCount = options.pinnedCount ?? 0;

  const nav = categoryNavPlan(usable, preference, collectionCount, pinnedCount);
  const sidebar = nav.mode === "sidebar" ? sidebarWidth(usable) : 0;
  const gridSpace = Math.max(usable - sidebar, 0);

  // The split is decided on the space the window has, then checked against the space the grid would
  // actually be left with. A sidebar is worth its width only if the grid still gets its minimum.
  const tallEnough = height >= MIN_SPLIT_HEIGHT;
  const canSplit = usable >= SPLIT_OPTIONAL_AT && tallEnough;
  const splitByDefault = usable > SPLIT_DEFAULT_AT && tallEnough;
  const ratio = clamp(options.splitRatio ?? 0.58, 0.45, 0.75);
  const wanted = splitByDefault || (canSplit && options.forceSplit === true);
  const detailWidth = wanted ? clamp(gridSpace * (1 - ratio), MIN_DETAIL_WIDTH, MAX_DETAIL_WIDTH) : 0;
  const split = wanted && gridSpace - detailWidth >= MIN_GRID_WIDTH;

  return {
    device,
    mode: split ? "split" : "single",
    optionalSplit: canSplit && !splitByDefault,
    categoryNav: nav,
    sidebarWidth: sidebar,
    gridWidth: Math.max(gridSpace - detailWidth, 0),
    detailWidth: split ? detailWidth : 0,
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

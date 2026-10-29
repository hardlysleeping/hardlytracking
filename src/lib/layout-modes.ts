/**
 * How the library lays itself out, per device class.
 *
 * The rule the plan settled on: **a tablet is not a bigger phone.** A phone gets one pane and
 * chips; a tablet keeps the collection list on screen at all times and, once there is room, shows
 * the selected title beside the grid instead of replacing it. A desktop gets the third pane.
 *
 * This module is pure and returns a decision, not a CSS class, so the layout can be tested without
 * a browser and both the view and the tests read the same numbers. Widths are CSS px.
 */

export type DeviceClass = "phone" | "tablet" | "desktop";

/** Where collections live: a scrolling chip row, or a persistent column. */
export type CollectionSurface = "chips" | "column";

/** What selecting a title does to the screen. */
export type DetailSurface = "replace" | "pane";

export type LibraryMode = "single" | "list-detail" | "three-pane";

export interface LibraryLayout {
  mode: LibraryMode;
  collections: CollectionSurface;
  detail: DetailSurface;
  /** Width of the collection column when `collections === "column"`. */
  collectionWidth: number;
  /** Width of the detail pane when `detail === "pane"`. */
  detailWidth: number;
  /** Minimum cover width for the grid; the column count follows from it. */
  gridMin: number;
  /** How a title offers "resume" without opening its detail page. */
  resume: ResumeAffordance;
}

/** `always` on a tablet (a corner control), `hover` on a desktop, `menu` on a phone. */
export type ResumeAffordance = "menu" | "always" | "hover";

/**
 * Phone below 600, tablet to 1279, desktop above.
 *
 * 1279 rather than 1000 because an iPad in landscape is 1024–1180 wide: calling that "desktop"
 * would give it a three-pane layout it does not have the height for.
 */
export function deviceClass(width: number): DeviceClass {
  if (width < 600) return "phone";
  if (width < 1280) return "tablet";
  return "desktop";
}

/**
 * The library's shape.
 *
 * - phone: one pane, collections as chips, detail replaces the grid.
 * - tablet portrait / narrow: collections as a column, detail still replaces the grid — a 768-wide
 *   screen cannot hold a grid, a collection list and a readable detail pane at once.
 * - tablet landscape (≥1000 wide, ≥600 tall): grid + detail side by side.
 * - desktop: collections, grid, detail — three panes.
 */
export function libraryLayout(width: number, height: number): LibraryLayout {
  const device = deviceClass(width);
  if (device === "phone") {
    return {
      mode: "single",
      collections: "chips",
      detail: "replace",
      collectionWidth: 0,
      detailWidth: 0,
      gridMin: 132,
      resume: "menu",
    };
  }
  if (device === "tablet") {
    const split = width >= 1000 && height >= 600;
    return {
      mode: split ? "list-detail" : "single",
      collections: "column",
      detail: split ? "pane" : "replace",
      collectionWidth: clamp(width * 0.22, 176, 264),
      detailWidth: split ? clamp(width * 0.34, 340, 460) : 0,
      // Denser than a phone on purpose: a tablet is for browsing a large library.
      gridMin: 112,
      resume: "always",
    };
  }
  return {
    mode: "three-pane",
    collections: "column",
    detail: "pane",
    collectionWidth: clamp(width * 0.16, 200, 280),
    detailWidth: clamp(width * 0.26, 360, 520),
    gridMin: 112,
    resume: "hover",
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Cover densities.
 *
 * Komikku's "fast browsing" idea, expressed as three numbers rather than a mode: the smaller the
 * cover, the more of the library is on screen, and the less each tile can say.
 */
export const DENSITIES = { comfortable: 148, compact: 112, dense: 88 } as const;
export type Density = keyof typeof DENSITIES;

/** What a tile can show at a given density. A 88px cover has no room for a second line. */
export function tileMeta(density: Density): "badges" | "title+badges" | "title+badges+source" {
  if (density === "dense") return "badges";
  if (density === "compact") return "title+badges";
  return "title+badges+source";
}

/**
 * Columns for a grid of `available` px with `min` cover width.
 *
 * At least two, because a one-column library is a list with extra steps, and at most eight, because
 * past that the covers stop being recognisable.
 */
export function columns(available: number, min: number, gap = 12): number {
  if (available <= 0 || min <= 0) return 2;
  const fit = Math.floor((available + gap) / (min + gap));
  return clamp(fit, 2, 8);
}

/** The width the grid actually has, once the collection column and detail pane take theirs. */
export function gridWidth(total: number, layout: LibraryLayout, railWidth = 0): number {
  const used = railWidth + layout.collectionWidth + layout.detailWidth;
  return Math.max(total - used - 32, 0);
}

/**
 * Whether bulk actions live in a floating bar (phone) or a bar pinned to the grid column.
 *
 * The test is the collection surface, not the pane count: a tablet in portrait is also one pane, but
 * it has a real column beside the grid and a floating bar would sit on top of the covers being
 * selected.
 */
export function selectionBar(layout: LibraryLayout): "floating" | "pinned" {
  return layout.collections === "chips" ? "floating" : "pinned";
}

/** Reader preferences are per device class: a tablet spread is wrong on a phone. */
export function readerProfile(device: DeviceClass): "phone" | "tablet" | "desktop" {
  return device;
}

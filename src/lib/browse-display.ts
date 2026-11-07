/** One durable display choice shared by Library and Search. Collection snapshots never override it. */
import { deviceClass } from "./layout-modes";
export type BrowseMode = "row" | "grid" | "card";
export function browseMode(value: unknown): BrowseMode {
  if (value === "row" || value === "list") return "row";
  if (value === "card") return "card";
  return "grid";
}
/**
 * The most columns the slider offers.
 *
 * A desktop window is wide enough for a wall of small covers — 12 across on a 1440- or 1920-wide
 * screen is a shelf you can scan, and capping it at 8 made the slider stop where the space had not.
 * A phone or tablet keeps 6: past that a cover is smaller than the title under it, and tapping the
 * right one stops being reliable.
 */
export function maxColumns(width: number, height = width): number { return deviceClass(width, height) === "desktop" ? 12 : 6; }
export function columnsFor(value: unknown, width: number, height = width): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 3;
  return Math.min(maxColumns(width, height), Math.max(2, n));
}
export function knownSize(bytes: unknown): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

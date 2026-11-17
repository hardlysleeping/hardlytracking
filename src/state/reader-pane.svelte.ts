import { go, pathTo } from "../lib/nav";
import { settings } from "./settings.svelte";

/**
 * The chapter being read inside the library, when the library has a pane for it.
 *
 * Reading used to be a screen: `#/read/…` unmounted the shelf, put the reader on the whole
 * screen and gave it a back door. In two panes the shelf is a pane of its own, so a chapter is a
 * pane too — the shelf keeps its place, its scroll and its filters, and closing the chapter puts
 * them back exactly as they were.
 *
 * `null` is "no chapter open", not "nothing remembered": the last chapter stays here while the
 * pane is shut, so reopening it costs one tap rather than a walk back through the series.
 */
class ReaderPane {
  open = $state<{ seriesId: string; chapterId: string } | null>(null);

  /** True when the library is laid out with panes at all. */
  get available(): boolean {
    return settings.libraryPane === "split" || settings.libraryPane === "three";
  }

  show(seriesId: string, chapterId: string): void {
    this.open = { seriesId, chapterId };
  }

  /** Another chapter of the same book, without leaving the pane. */
  replace(chapterId: string): void {
    const current = this.open;
    if (current === null) return;
    this.open = { seriesId: current.seriesId, chapterId };
  }

  close(): void {
    this.open = null;
  }
}

export const readerPane = new ReaderPane();

/**
 * Where a "Read" press goes.
 *
 * With panes, the chapter opens beside the shelf; without them there is nowhere to put it, so it
 * is the reader screen as before. `allowPane` is for the full-page series view, which is its own
 * screen: offering it a pane the library is not drawing would be a button that does nothing.
 */
export function startReading(seriesId: string, chapterId: string, allowPane = true): void {
  if (allowPane && readerPane.available) {
    readerPane.show(seriesId, chapterId);
    return;
  }
  go(pathTo("read", seriesId, chapterId));
}
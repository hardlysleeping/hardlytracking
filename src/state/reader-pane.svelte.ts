import { go, pathTo } from "../lib/nav";
import { settings } from "./settings.svelte";
import { library } from "./library.svelte";

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

  /**
   * A counter that says "this chapter was asked for again".
   *
   * The reader's load effect depends on `chapterId`, which does not change when the same chapter is
   * reopened in the same pane. Restarting needs the load to run again, so a restart bumps this and
   * the reader watches it.
   */
  reloads = $state(0);
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

/**
 * Open a chapter at its first page, whatever this device last stopped on.
 *
 * "Restart chapter" used to call `startReading`, which is the same call as "Continue" — the reader
 * loads its saved page, so both walked back to page 40. The saved page is the one thing that has to
 * go for a restart to mean anything, so it is cleared first, and the reader is told a reload is
 * wanted (`reloads`) in case the very chapter is already open in a pane: a prop that did not change
 * would not mount anything.
 */
export async function restartChapter(seriesId: string, chapterId: string, allowPane = true): Promise<void> {
  const store = library.profile?.store;
  if (store !== undefined) {
    // Page 0, and the `completed` flag is kept: restarting a chapter is not un-reading it.
    await store.setProgress(chapterId, 0, 0).catch(() => undefined);
    await store.setPosition(seriesId, chapterId, 0).catch(() => undefined);
  }
  readerPane.reloads += 1;
  startReading(seriesId, chapterId, allowPane);
}
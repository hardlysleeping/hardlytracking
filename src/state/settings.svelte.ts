/**
 * What the user chose, and where it is kept.
 *
 * Everything here is a preference in the library database, keyed `settings.*`, so it travels with
 * an export and survives a reload. Fields are declared rather than a loose bag: a typo in a key
 * becomes a compile error instead of a setting that silently never saves.
 */
import type { CategoryNavPreference, DensityPreference } from "../lib/layout-modes";
import type { LibraryStore } from "../lib/db/store";

export type LibraryView = "grid" | "compact" | "list";
export type Sort = "title" | "recent" | "source";
export type ReaderMode = "vertical" | "webtoon" | "paged" | "ltr" | "rtl";
export type Fit = "width" | "height" | "contain";

const KEY = "settings.";

/** The fields a caller may write through `set`, so a typo is a compile error. */
export interface Prefs {
  libraryView: LibraryView;
  coverSize: number;
  /** Auto follows the device class; Custom is the cover-size slider. */
  libraryDensity: DensityPreference;
  /** Settings → Library → Category navigation. */
  categoryNav: CategoryNavPreference;
  /** The grid/detail split, remembered after the divider is dragged. */
  splitRatio: number;
  librarySort: Sort;
  showContinue: boolean;
  readerMode: ReaderMode;
  readerFit: Fit;
  pageGap: number;
  keepAwake: boolean;
  tapZones: boolean;
  /** Privacy: record what was read and when. Progress survives either way. */
  recordHistory: boolean;
}

class Settings {
  ready = $state(false);

  libraryView = $state<LibraryView>("grid");
  coverSize = $state(132);
  libraryDensity = $state<DensityPreference>("auto");
  categoryNav = $state<CategoryNavPreference>("automatic");
  splitRatio = $state(0.58);
  librarySort = $state<Sort>("title");
  showContinue = $state(true);

  readerMode = $state<ReaderMode>("vertical");
  readerFit = $state<Fit>("width");
  /** Space between pages in vertical/webtoon mode, px. */
  pageGap = $state(0);
  keepAwake = $state(true);
  /** Tap zones: left/right thirds turn pages, the middle shows the controls. */
  tapZones = $state(true);
  recordHistory = $state(true);

  private store: LibraryStore | null = null;

  async load(store: LibraryStore): Promise<void> {
    this.store = store;
    const read = async <T,>(key: string, fallback: T): Promise<T> => {
      const value = await store.getPref<T>(KEY + key);
      return value === undefined ? fallback : value;
    };
    this.libraryView = await read("libraryView", this.libraryView);
    this.coverSize = await read("coverSize", this.coverSize);
    this.libraryDensity = await read("libraryDensity", this.libraryDensity);
    this.categoryNav = await read("categoryNav", this.categoryNav);
    this.splitRatio = await read("splitRatio", this.splitRatio);
    this.librarySort = await read("librarySort", this.librarySort);
    this.showContinue = await read("showContinue", this.showContinue);
    this.readerMode = await read("readerMode", this.readerMode);
    this.readerFit = await read("readerFit", this.readerFit);
    this.pageGap = await read("pageGap", this.pageGap);
    this.keepAwake = await read("keepAwake", this.keepAwake);
    this.tapZones = await read("tapZones", this.tapZones);
    this.recordHistory = await read("recordHistory", this.recordHistory);
    this.ready = true;
  }

  /**
   * Write a field and remember it.
   *
   * The assignment happens first and the save is fire-and-forget: a UI toggle must not wait for
   * IndexedDB, and a failed save is not worth an error banner on a preference.
   */
  set<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
    (this as unknown as Record<string, unknown>)[key] = value;
    void this.store?.setPref(KEY + key, value).catch(() => {});
  }
}

export const settings = new Settings();

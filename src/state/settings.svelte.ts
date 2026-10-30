/**
 * What the user chose, and where it is kept.
 *
 * Everything here is a preference in the library database, keyed `settings.*`, so it travels with
 * an export and survives a reload. Fields are declared rather than a loose bag: a typo in a key
 * becomes a compile error instead of a setting that silently never saves.
 */
import type { CategoryNavPreference, DensityPreference } from "../lib/layout-modes";
import type { LibraryStore } from "../lib/db/store";
import { EMPTY_FILTER, type LibraryFilter } from "../lib/library/filter";
import type { Margins, PanePreference } from "../lib/view-options";
import { DEFAULT_CPU_LEVEL, type CpuLevel } from "../lib/performance";

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
  /** The filter the sheet last applied. A durable field, so an export carries it. */
  libraryFilter: LibraryFilter;
  showContinue: boolean;
  readerMode: ReaderMode;
  readerFit: Fit;
  pageGap: number;
  keepAwake: boolean;
  tapZones: boolean;
  /** Pause reading history: no sessions, no timeline. Progress and read marks continue. */
  historyPaused: boolean;
  /** Days a session is kept; 0 is forever. Applies to sessions only, never to progress. */
  historyRetentionDays: number;
  /** Source ids the user pinned, for "search pinned sources only" (Komikku's behaviour). */
  pinnedSources: string[];
  /** Global search defaults to the pinned sources when there are any. */
  searchPinnedOnly: boolean;
  /** How hard the app may work: pages fetched at once and pacing between them. */
  cpuLevel: CpuLevel;
  /** Room around the content: comfortable, compact, or none. */
  contentMargins: Margins;
  /** Remove comfort-only chrome (screen heading, Continue strip) so the grid keeps the pixels. */
  maximizeSpace: boolean;
  /** One pane or two, for the library. */
  libraryPane: PanePreference;
  /** One pane or two, for history. */
  historyPane: PanePreference;
  /** Cover/page image cache ceiling, MB. */
  imageCacheLimitMb: number;
  /** Cache images at all. */
  cacheImages: boolean;
}

class Settings {
  ready = $state(false);

  libraryView = $state<LibraryView>("grid");
  coverSize = $state(132);
  libraryDensity = $state<DensityPreference>("auto");
  categoryNav = $state<CategoryNavPreference>("automatic");
  splitRatio = $state(0.58);
  librarySort = $state<Sort>("title");
  libraryFilter = $state<LibraryFilter>({ ...EMPTY_FILTER, statuses: [], sources: [] });
  showContinue = $state(true);

  readerMode = $state<ReaderMode>("vertical");
  readerFit = $state<Fit>("width");
  /** Space between pages in vertical/webtoon mode, px. */
  pageGap = $state(0);
  keepAwake = $state(true);
  /** Tap zones: left/right thirds turn pages, the middle shows the controls. */
  tapZones = $state(true);
  historyPaused = $state(false);
  historyRetentionDays = $state(0);
  pinnedSources = $state<string[]>([]);
  searchPinnedOnly = $state(true);
  cpuLevel = $state<CpuLevel>(DEFAULT_CPU_LEVEL);
  contentMargins = $state<Margins>("comfortable");
  maximizeSpace = $state(false);
  libraryPane = $state<PanePreference>("auto");
  historyPane = $state<PanePreference>("auto");
  imageCacheLimitMb = $state(256);
  cacheImages = $state(true);

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
    this.libraryFilter = await read("libraryFilter", this.libraryFilter);
    this.showContinue = await read("showContinue", this.showContinue);
    this.readerMode = await read("readerMode", this.readerMode);
    this.readerFit = await read("readerFit", this.readerFit);
    this.pageGap = await read("pageGap", this.pageGap);
    this.keepAwake = await read("keepAwake", this.keepAwake);
    this.tapZones = await read("tapZones", this.tapZones);
    this.historyPaused = await read("historyPaused", this.historyPaused);
    this.historyRetentionDays = await read("historyRetentionDays", this.historyRetentionDays);
    this.pinnedSources = await read("pinnedSources", this.pinnedSources);
    this.searchPinnedOnly = await read("searchPinnedOnly", this.searchPinnedOnly);
    this.cpuLevel = await read("cpuLevel", this.cpuLevel);
    this.contentMargins = await read("contentMargins", this.contentMargins);
    this.maximizeSpace = await read("maximizeSpace", this.maximizeSpace);
    this.libraryPane = await read("libraryPane", this.libraryPane);
    this.historyPane = await read("historyPane", this.historyPane);
    this.imageCacheLimitMb = await read("imageCacheLimitMb", this.imageCacheLimitMb);
    this.cacheImages = await read("cacheImages", this.cacheImages);
    this.ready = true;
  }

  /**
   * Write a field and remember it.
   *
   * The assignment happens first and the save is fire-and-forget: a UI toggle must not wait for
   * IndexedDB, and a failed save is not worth an error banner on a preference.
   *
   * The value is snapshotted before it is stored: IndexedDB's structured clone refuses a Svelte
   * `$state` proxy (`DataCloneError`), and a filter or a sort spec is an object.
   */
  set<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
    const plain = $state.snapshot(value) as Prefs[K];
    (this as unknown as Record<string, unknown>)[key] = plain;
    void this.store?.setPref(KEY + key, plain).catch(() => {});
  }
}

export const settings = new Settings();

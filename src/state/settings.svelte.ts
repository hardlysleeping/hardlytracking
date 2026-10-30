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
import { sortSpecOfLegacy, type SortSpec } from "../lib/library/sort";
import { DEFAULT_BADGES } from "../lib/library/badges";
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
  /** The old three-value sort, kept readable; `sortByCollection` is what the library uses. */
  librarySort: Sort;
  /** One sort per collection, keyed by category id, `"all"` for the whole library. */
  sortByCollection: Record<string, SortSpec>;
  /**
   * Manual order, one id list per collection (`"all"` for the whole library).
   *
   * Ids, not rows: a series row is rebuilt from the runtime on every add, so an order field on the
   * row would be dropped on the next save. A list that names ids we no longer have is harmless —
   * they are ignored, and anything unlisted goes last in title order.
   */
  manualOrder: Record<string, string[]>;
  /**
   * Which card badges are on. A closed map of the six declared kinds, so a stored value from a
   * newer build cannot put an unknown pill on a card, and an export carries the choice.
   */
  badgeSet: Record<string, boolean>;
  /**
   * The newest chapter timestamp a title had when the Updates screen was last opened.
   *
   * A "new" badge is the difference between the newest chapter now and this mark, so opening
   * Updates is what clears it — the same promise the tab makes.
   */
  updatesSeen: Record<string, number>;
  /** The filter the sheet last applied. A durable field, so an export carries it. */
  libraryFilter: LibraryFilter;
  /**
   * The Continue strip's on/off. `showContinue` is the storage key, kept from the first build so
   * the owner's existing choice survives the upgrade — the strip's `continueShow` is this field.
   */
  showContinue: boolean;
  /** Where the strip sits relative to the tools row. */
  continuePosition: "above" | "below";
  /** How many cards the strip draws, 1–20. */
  continueMax: number;
  continueSize: "small" | "medium";
  /** After finishing a chapter: point at the next unread one, or stay put. */
  continueAfterFinish: "next-unread" | "hold";
  /** Series taken off the strip. Their position, library and history rows are untouched. */
  continueDismissed: string[];
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
  sortByCollection = $state<Record<string, SortSpec>>({});
  manualOrder = $state<Record<string, string[]>>({});
  badgeSet = $state<Record<string, boolean>>({ ...DEFAULT_BADGES });
  updatesSeen = $state<Record<string, number>>({});
  libraryFilter = $state<LibraryFilter>({ ...EMPTY_FILTER, statuses: [], sources: [] });
  showContinue = $state(true);
  continuePosition = $state<"above" | "below">("above");
  continueMax = $state(10);
  continueSize = $state<"small" | "medium">("small");
  continueAfterFinish = $state<"next-unread" | "hold">("next-unread");
  continueDismissed = $state<string[]>([]);

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
    this.sortByCollection = await read("sortByCollection", this.sortByCollection);
    this.manualOrder = await read("manualOrder", this.manualOrder);
    this.badgeSet = { ...DEFAULT_BADGES, ...(await read("badgeSet", this.badgeSet)) };
    this.updatesSeen = await read("updatesSeen", this.updatesSeen);
    // One-time migration: an existing three-value choice becomes the library's own spec, so the
    // upgrade does not silently re-sort the shelf the user has been looking at.
    if (Object.keys(this.sortByCollection).length === 0) {
      this.sortByCollection = { all: sortSpecOfLegacy(this.librarySort) };
    }
    this.libraryFilter = await read("libraryFilter", this.libraryFilter);
    this.showContinue = await read("showContinue", this.showContinue);
    this.continuePosition = await read("continuePosition", this.continuePosition);
    this.continueMax = await read("continueMax", this.continueMax);
    this.continueSize = await read("continueSize", this.continueSize);
    this.continueAfterFinish = await read("continueAfterFinish", this.continueAfterFinish);
    this.continueDismissed = await read("continueDismissed", this.continueDismissed);
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

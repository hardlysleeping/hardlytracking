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
import { isNavCorner, type Margins, type NavCorner, type PanePreference } from "../lib/view-options";
import type { SourceFilterSelection } from "../api/source";
import { DEFAULT_CPU_LEVEL, type CpuLevel } from "../lib/performance";
import {
  autoscrollCurveOf,
  autoscrollSpeedOf,
  DEFAULT_AUTOSCROLL_CURVE,
  DEFAULT_AUTOSCROLL_SPEED,
  type AutoscrollCurve,
  type AutoscrollSpeed,
} from "../lib/autoscroll";
import { keepCategoriesOf } from "../lib/offline/policy";
import { DEFAULT_CONTINUE_COLLAPSED, continueCollapsedOf } from "../lib/library/continue";
import { levelOr, type ContentLevel } from "../lib/content/levels";
import { pinRecordOf } from "../lib/pin";
import {
  DEFAULT_BOTTOM_NAV,
  DEFAULT_LIBRARY_TABS,
  DESTINATION_IDS,
  LIBRARY_SECTION_IDS,
  completeOrder,
  normaliseOrder,
} from "../lib/nav-order";

/** A stored corner is one of four words; anything else is the default, not a broken layout. */
function cornerOr(value: unknown): NavCorner {
  return isNavCorner(value) ? value : "bottom-right";
}

import { DEFAULT_READ_AHEAD, readAheadOf, type ReadAhead } from "../lib/reader-ahead";
import { scaleMapOf } from "../lib/reader-scale";
import { browseMode, rowStyleOf, type RowStyle } from "../lib/browse-display";
export type LibraryView = "grid" | "compact" | "list" | "row" | "card";
export type Sort = "title" | "recent" | "source";
export type ReaderMode = "vertical" | "paged" | "ltr" | "rtl" | "duo";
export type Fit = "width" | "height" | "contain" | "fill";

const KEY = "settings.";

/** The fields a caller may write through `set`, so a typo is a compile error. */
export interface Prefs {
  libraryView: LibraryView;
  /**
   * The shape of a `row` in the shelf: line, preview or table.
   *
   * A preference, not component state: which list shape the owner keeps is a decision about his
   * library, so it travels in an export and survives a relaunch like every other display choice.
   */
  rowStyle: RowStyle;
  /**
   * Where a grid tile's title goes: under the artwork, or on it.
   *
   * `below` is the readable default. `overlay` buys back the whole title row on a phone — the shelf
   * becomes covers and nothing else — which is what "compact" has to mean when the screen is 440 px.
   */
  browseTitle: "below" | "overlay";
  coverSize: number;
  /** Auto follows the device class; Custom is the cover-size slider. */
  libraryDensity: DensityPreference;
  /** Settings → Library → Category navigation. */
  categoryNav: CategoryNavPreference;
  /** The grid/detail split, remembered after the divider is dragged. */
  splitRatio: number;
  /** In three panes, the shelf's share of the room above the three floors. */
  splitRatio3: number;
  /** In three panes, the series column's share of the room the shelf leaves. */
  detailShare: number;
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
   * The collection the shelf was last looking at, so a relaunch opens there rather than at "All".
   * `null` is the whole library — a real answer, not "unset", so it is stored as one.
   */
  libraryCollection: string | null;
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
  /** The reader folded the strip away. The fold survives a relaunch, like any other choice. */
  continueCollapsed: boolean;
  /** After finishing a chapter: point at the next unread one, or stay put. */
  continueAfterFinish: "next-unread" | "hold";
  /** Series taken off the strip. Their position, library and history rows are untouched. */
  continueDismissed: string[];
  readerMode: ReaderMode;
  readerFit: Fit;
  /**
   * Page size per title, 0.5–1, keyed by series id.
   *
   * One field, not one pref per series, and 1 is stored as *no entry*: the fit is the default, so
   * a map that only names the titles the reader shrank stays small and an export stays honest.
   * The reading surface is shared by every chapter of a title, so the scale is too.
   */
  readerScale: Record<string, number>;
  readerAhead: ReadAhead;
  autoscrollSpeed: AutoscrollSpeed;
  autoscrollCurve: AutoscrollCurve;
  keepOnAdd: boolean;
  keepCategories: string[];
  pageGap: number;
  keepAwake: boolean;
  tapZones: boolean;
  /** Pause reading history: no sessions, no timeline. Progress and read marks continue. */
  historyPaused: boolean;
  /** Days a session is kept; 0 is forever. Applies to sessions only, never to progress. */
  historyRetentionDays: number;
  /**
   * Series ids pinned at the top of History.
   *
   * Ids, not rows: history rows are rebuilt from the log, and a pin is the reader's mark on a
   * title, so it lives in prefs where an export and a relaunch carry it. An id whose rows were
   * removed simply draws no Pinned group, and comes back if the title is read again.
   */
  historyPins: string[];
  /** Source ids the user pinned, for "search pinned sources only" (Komikku's behaviour). */
  pinnedSources: string[];
  /**
   * Each source's own filter choices, keyed by source id then by the filter's position.
   *
   * One field, not one pref per source: the map travels in an export and a source that disappears
   * with its extension leaves an entry that is simply never read.
   */
  sourceFilters: Record<string, SourceFilterSelection>;
  /** Global search defaults to the pinned sources when there are any. */
  searchPinnedOnly: boolean;
  /** How hard the app may work: pages fetched at once and pacing between them. */
  cpuLevel: CpuLevel;
  /**
   * Restricted / Mature / Adult — what the extension store and the source list are allowed to show.
   *
   * Mature, not Restricted, is the default: most indexes label nothing at all, and an app that
   * opens with an empty store reads as broken rather than as careful.
   */
  contentLevel: ContentLevel;
  /**
   * The age declaration, stored apart from the level.
   *
   * A restored backup, or a level left at Adult by another build, must not show adult sources to
   * someone who never said they were an adult. The setting says what to show; this says whether it
   * may.
   */
  adultDeclared: boolean;
  /** When the declaration was made, so Settings can say "declared on …" rather than just "on". */
  adultDeclaredAt: number | null;
  /** Room around the content: comfortable, compact, or none. */
  contentMargins: Margins;
  /** Remove comfort-only chrome (screen heading, Continue strip) so the grid keeps the pixels. */
  maximizeSpace: boolean;
  /** One pane or two, for the library. */
  libraryPane: PanePreference;
  /** The narrowest shelf a two-pane split may leave, in px. */
  /** One pane or two, for history. */
  historyPane: PanePreference;
  /** Which corner the phone's floating Back/Forward buttons sit in. */
  historyNavCorner: NavCorner;
  /**
   * The phone bar's destinations, in bar order.
   *
   * Ids, not rows, and only the ones the reader kept: a page taken off the bar is not gone — the
   * title menu lists every destination — so a short list is a real answer, not a broken one.
   */
  bottomNav: string[];
  /** The Library's section tabs, in tab order. Every section is in it; only the order changes. */
  libraryTabs: string[];
  /**
   * The Library's filter · sort · display row, folded away.
   *
   * Folded is a real answer — the shelf gets the pixels back and the row is one tap from returning —
   * so it is remembered rather than reset on every launch.
   */
  toolsCollapsed: boolean;
  /** Cover/page image cache ceiling, MB. */
  imageCacheLimitMb: number;
  /** Cache images at all. */
  cacheImages: boolean;
  /**
   * The screen-curtain PIN, as a salted hash record (`lib/pin`), or `""` for no PIN.
   *
   * A preference like any other, not a device secret: the owner asked for one PIN across devices,
   * so it travels in an export and in the HardlySync document's preferences. It is written only by
   * `library.setPin/changePin/clearPin`, and `set` drops any value that is not a record this build
   * recognises — a corrupt row means "no PIN", never a lock nobody can open.
   */
  privacyPin: string;
  /**
   * The visibility band's fold.
   *
   * The reader's own choice, not the curtain's: locking folds the band on top of it, so raising the
   * curtain gives back the fold they left behind. A preference, so a relaunch — and an export —
   * keeps it, the same promise Continue's fold makes.
   */
  privacyBandCollapsed: boolean;
  /** The first-run screen has been seen; it never shows again. */
  welcomed: boolean;
}

class Settings {
  ready = $state(false);

  libraryView = $state<LibraryView>("grid");
  rowStyle = $state<RowStyle>("line");
  browseTitle = $state<"below" | "overlay">("below");
  coverSize = $state(132);
  libraryDensity = $state<DensityPreference>("auto");
  categoryNav = $state<CategoryNavPreference>("automatic");
  splitRatio = $state(0.58);
  splitRatio3 = $state(0.58);
  detailShare = $state(0.4);
  librarySort = $state<Sort>("title");
  sortByCollection = $state<Record<string, SortSpec>>({});
  manualOrder = $state<Record<string, string[]>>({});
  badgeSet = $state<Record<string, boolean>>({ ...DEFAULT_BADGES });
  updatesSeen = $state<Record<string, number>>({});
  libraryFilter = $state<LibraryFilter>({ ...EMPTY_FILTER, statuses: [], sources: [] });
  libraryCollection = $state<string | null>(null);
  showContinue = $state(true);
  continuePosition = $state<"above" | "below">("above");
  continueMax = $state(10);
  continueSize = $state<"small" | "medium">("small");
  continueCollapsed = $state(DEFAULT_CONTINUE_COLLAPSED);
  continueAfterFinish = $state<"next-unread" | "hold">("next-unread");
  continueDismissed = $state<string[]>([]);

  readerMode = $state<ReaderMode>("vertical");
  readerFit = $state<Fit>("width");
  readerScale = $state<Record<string, number>>({});
  readerAhead = $state<ReadAhead>(DEFAULT_READ_AHEAD);
  autoscrollSpeed = $state<AutoscrollSpeed>(DEFAULT_AUTOSCROLL_SPEED);
  autoscrollCurve = $state<AutoscrollCurve>(DEFAULT_AUTOSCROLL_CURVE);
  /** Off by default: nothing is downloaded unless the reader asked. */
  keepOnAdd = $state(false);
  keepCategories = $state<string[]>([]);
  /** Space between pages in vertical mode, px. */
  pageGap = $state(0);
  keepAwake = $state(true);
  /** Tap zones: left/right thirds turn pages, the middle shows the controls. */
  tapZones = $state(true);
  historyPaused = $state(false);
  historyRetentionDays = $state(0);
  historyPins = $state<string[]>([]);
  pinnedSources = $state<string[]>([]);
  sourceFilters = $state<Record<string, SourceFilterSelection>>({});
  searchPinnedOnly = $state(true);
  cpuLevel = $state<CpuLevel>(DEFAULT_CPU_LEVEL);
  contentLevel = $state<ContentLevel>("mature");
  adultDeclared = $state(false);
  adultDeclaredAt = $state<number | null>(null);
  contentMargins = $state<Margins>("comfortable");
  maximizeSpace = $state(false);
  libraryPane = $state<PanePreference>("auto");
  historyPane = $state<PanePreference>("auto");
  /** Bottom right: where the thumb already is on a phone held in one hand. */
  historyNavCorner = $state<NavCorner>("bottom-right");
  bottomNav = $state<string[]>([...DEFAULT_BOTTOM_NAV]);
  libraryTabs = $state<string[]>([...DEFAULT_LIBRARY_TABS]);
  toolsCollapsed = $state(false);
  imageCacheLimitMb = $state(256);
  cacheImages = $state(true);
  /** Salted hash only — see `lib/pin`. Empty means the curtain has no PIN and refuses to lock. */
  privacyPin = $state("");
  /** Folded by the reader; the curtain adds its own fold on top without rewriting this. */
  privacyBandCollapsed = $state(false);
  /**
   * The first-run screen has been shown and dismissed.
   *
   * A preference in the library database, not a cookie or a device flag: it travels with an export,
   * so restoring a backup does not re-show the welcome to someone who has used the app for months.
   */
  welcomed = $state(false);

  private store: LibraryStore | null = null;

  async load(store: LibraryStore): Promise<void> {
    this.store = store;
    const read = async <T,>(key: string, fallback: T): Promise<T> => {
      const value = await store.getPref<T>(KEY + key);
      return value === undefined ? fallback : value;
    };
    const legacyView = await read("libraryView", this.libraryView);
    this.libraryView = browseMode(legacyView);
    this.rowStyle = rowStyleOf(await read<unknown>("rowStyle", this.rowStyle));
    this.toolsCollapsed = (await read<boolean>("toolsCollapsed", false)) === true;
    const title = await read("browseTitle", this.browseTitle);
    this.browseTitle = title === "overlay" ? "overlay" : "below";
    this.coverSize = await read("coverSize", this.coverSize);
    this.libraryDensity = await read("libraryDensity", this.libraryDensity);
    this.categoryNav = await read("categoryNav", this.categoryNav);
    this.splitRatio = await read("splitRatio", this.splitRatio);
    this.splitRatio3 = await read("splitRatio3", this.splitRatio3);
    this.detailShare = await read("detailShare", this.detailShare);
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
    this.libraryCollection = await read("libraryCollection", this.libraryCollection);
    this.showContinue = await read("showContinue", this.showContinue);
    this.continuePosition = await read("continuePosition", this.continuePosition);
    this.continueMax = await read("continueMax", this.continueMax);
    this.continueSize = await read("continueSize", this.continueSize);
    this.continueCollapsed = continueCollapsedOf(await read<unknown>("continueCollapsed", DEFAULT_CONTINUE_COLLAPSED));
    this.continueAfterFinish = await read("continueAfterFinish", this.continueAfterFinish);
    this.continueDismissed = await read("continueDismissed", this.continueDismissed);
    // "webtoon" was a second name for vertical with no gap: one mode, so an old value lands on it.
    const storedMode = await read<string>("readerMode", this.readerMode);
    this.readerMode = storedMode === "webtoon" ? "vertical" : (storedMode as ReaderMode);
    this.readerFit = await read("readerFit", this.readerFit);
    this.readerScale = scaleMapOf(await read<unknown>("readerScale", {}));
    this.readerAhead = readAheadOf(await read<unknown>("readerAhead", DEFAULT_READ_AHEAD));
    this.autoscrollSpeed = autoscrollSpeedOf(await read<unknown>("autoscrollSpeed", DEFAULT_AUTOSCROLL_SPEED));
    this.autoscrollCurve = autoscrollCurveOf(await read<unknown>("autoscrollCurve", DEFAULT_AUTOSCROLL_CURVE));
    this.keepOnAdd = (await read<boolean>("keepOnAdd", false)) === true;
    this.keepCategories = keepCategoriesOf(await read<unknown>("keepCategories", []));
    this.pageGap = await read("pageGap", this.pageGap);
    this.keepAwake = await read("keepAwake", this.keepAwake);
    this.tapZones = await read("tapZones", this.tapZones);
    this.historyPaused = await read("historyPaused", this.historyPaused);
    this.historyRetentionDays = await read("historyRetentionDays", this.historyRetentionDays);
    this.historyPins = await read("historyPins", this.historyPins);
    this.pinnedSources = await read("pinnedSources", this.pinnedSources);
    this.sourceFilters = await read("sourceFilters", this.sourceFilters);
    this.searchPinnedOnly = await read("searchPinnedOnly", this.searchPinnedOnly);
    this.cpuLevel = await read("cpuLevel", this.cpuLevel);
    this.contentLevel = levelOr(await read<unknown>("contentLevel", this.contentLevel));
    this.adultDeclared = await read("adultDeclared", this.adultDeclared);
    this.adultDeclaredAt = await read("adultDeclaredAt", this.adultDeclaredAt);
    this.contentMargins = await read("contentMargins", this.contentMargins);
    this.maximizeSpace = await read("maximizeSpace", this.maximizeSpace);
    this.libraryPane = await read("libraryPane", this.libraryPane);
    this.historyPane = await read("historyPane", this.historyPane);
    this.historyNavCorner = cornerOr(await read<unknown>("historyNavCorner", this.historyNavCorner));
    // A stored order is data from another build or a hand-edited export: known ids only, no
    // duplicates, stored order kept, and an unreadable value is the default rather than a blank bar.
    this.bottomNav = normaliseOrder(await read<unknown>("bottomNav", DEFAULT_BOTTOM_NAV), DESTINATION_IDS, DEFAULT_BOTTOM_NAV);
    // Completed, not just normalised: a stored order from before Downloads existed must still grow
    // the new section, or the tab is invisible to anyone who ever reordered them.
    this.libraryTabs = completeOrder(await read<unknown>("libraryTabs", DEFAULT_LIBRARY_TABS), LIBRARY_SECTION_IDS, DEFAULT_LIBRARY_TABS);
    this.imageCacheLimitMb = await read("imageCacheLimitMb", this.imageCacheLimitMb);
    this.cacheImages = await read("cacheImages", this.cacheImages);
    // Defensive read: a corrupt or foreign record is "no PIN", not a lock that refuses every entry.
    this.privacyPin = pinRecordOf(await read<unknown>("privacyPin", ""));
    this.privacyBandCollapsed = (await read<boolean>("privacyBandCollapsed", false)) === true;
    this.welcomed = await read("welcomed", this.welcomed);
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
    const normalised =
      key === "readerAhead"
        ? readAheadOf(value)
        : key === "autoscrollSpeed"
          ? autoscrollSpeedOf(value)
          : key === "autoscrollCurve"
            ? autoscrollCurveOf(value)
            : key === "keepCategories"
              ? keepCategoriesOf(value)
              : key === "rowStyle"
                ? rowStyleOf(value)
                : key === "readerScale"
                ? scaleMapOf(value)
                : key === "privacyPin"
                ? pinRecordOf(value)
                : key === "historyNavCorner"
                  ? cornerOr(value)
                  : key === "bottomNav"
                    ? normaliseOrder(value, DESTINATION_IDS, DEFAULT_BOTTOM_NAV)
                    : key === "libraryTabs"
                      ? completeOrder(value, LIBRARY_SECTION_IDS, DEFAULT_LIBRARY_TABS)
                      : value;
    const plain = $state.snapshot(normalised) as Prefs[K];
    (this as unknown as Record<string, unknown>)[key] = plain;
    void this.store?.setPref(KEY + key, plain).catch(() => {});
  }
}

export const settings = new Settings();

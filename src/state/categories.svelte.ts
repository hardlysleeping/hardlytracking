/**
 * The two marks, as app state.
 *
 * Everything the rail draws comes from here: the category list, which of them are
 * hidden or pinned, and the two view cycles. Policy lives in `lib/categories`; this
 * class only persists and mutates.
 *
 * Persistence is our own database (a `categories` store plus two prefs), because in
 * this app the library is ours. Nothing here talks to the Mihon runtime.
 */
import {
  HIDDEN_VIEW_LABELS,
  PIN_VIEW_LABELS,
  isHiddenView,
  isPinView,
  nextHiddenView,
  nextPinView,
  type Category,
  type HiddenView,
  type PinView,
} from "../lib/categories";
import type { LibraryStore } from "../lib/db/store";

const HIDDEN_VIEW_KEY = "categories.hiddenView";
const PIN_VIEW_KEY = "categories.pinView";

class CategoriesState {
  items = $state<Category[]>([]);
  hiddenView = $state<HiddenView>("hidden");
  pinView = $state<PinView>("all");
  loaded = $state(false);

  #store: LibraryStore | null = null;

  async load(store: LibraryStore): Promise<void> {
    if (this.loaded) return;
    this.#store = store;
    this.items = await store.listCategories();
    const hidden = await store.getPref<string>(HIDDEN_VIEW_KEY);
    const pin = await store.getPref<string>(PIN_VIEW_KEY);
    if (isHiddenView(hidden)) this.hiddenView = hidden;
    if (isPinView(pin)) this.pinView = pin;
    this.loaded = true;
  }

  get hiddenCount(): number {
    return this.items.filter((c) => c.hidden).length;
  }

  get pinnedCount(): number {
    return this.items.filter((c) => c.pinned).length;
  }

  get hiddenLabel(): string {
    return HIDDEN_VIEW_LABELS[this.hiddenView];
  }

  get pinLabel(): string {
    return PIN_VIEW_LABELS[this.pinView];
  }

  async create(name: string): Promise<Category | null> {
    const trimmed = name.trim();
    if (trimmed === "" || this.#store === null) return null;
    const category: Category = {
      id: `cat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: trimmed,
      order: this.items.length,
      hidden: false,
      pinned: false,
    };
    await this.#store.putCategory(category);
    this.items = await this.#store.listCategories();
    return category;
  }

  async remove(categoryId: string): Promise<void> {
    if (this.#store === null) return;
    await this.#store.removeCategory(categoryId);
    this.items = await this.#store.listCategories();
  }

  async rename(categoryId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    const current = this.items.find((c) => c.id === categoryId);
    if (trimmed === "" || current === undefined || this.#store === null) return;
    await this.#store.putCategory({ ...current, name: trimmed });
    this.items = await this.#store.listCategories();
  }

  async setHidden(categoryId: string, hidden: boolean): Promise<void> {
    const current = this.items.find((c) => c.id === categoryId);
    if (current === undefined || this.#store === null) return;
    await this.#store.putCategory({ ...current, hidden });
    this.items = await this.#store.listCategories();
  }

  /** The pin is its own mark: pinning never touches the eye, and vice versa. */
  async togglePin(categoryId: string): Promise<void> {
    const current = this.items.find((c) => c.id === categoryId);
    if (current === undefined || this.#store === null) return;
    await this.#store.putCategory({ ...current, pinned: !current.pinned });
    this.items = await this.#store.listCategories();
  }

  /**
   * The tab-row pin, which is a different mark from `pinned`.
   *
   * Pinned-to-the-row collections are the five one-tap chips; `pinned` floats a shelf in the rail.
   * Keeping them apart is what lets a user pin a shelf without rearranging their tab row.
   */
  async setTabPinned(categoryId: string, tabPinned: boolean): Promise<void> {
    const current = this.items.find((c) => c.id === categoryId);
    if (current === undefined || this.#store === null) return;
    if ((current.tabPinned === true) === tabPinned) return;
    const next: Category = { ...current };
    if (tabPinned) next.tabPinned = true;
    else delete next.tabPinned;
    await this.#store.putCategory(next);
    this.items = await this.#store.listCategories();
  }

  async toggleTabPin(categoryId: string): Promise<void> {
    const current = this.items.find((c) => c.id === categoryId);
    if (current === undefined) return;
    await this.setTabPinned(categoryId, current.tabPinned !== true);
  }

  async cycleHiddenView(): Promise<void> {
    this.hiddenView = nextHiddenView(this.hiddenView);
    await this.#store?.setPref(HIDDEN_VIEW_KEY, this.hiddenView);
  }

  async cyclePinView(): Promise<void> {
    this.pinView = nextPinView(this.pinView);
    await this.#store?.setPref(PIN_VIEW_KEY, this.pinView);
  }

  async assign(seriesId: string, categoryIds: string[]): Promise<void> {
    await this.#store?.setSeriesCategories(seriesId, categoryIds);
  }

  categoriesOfSeries(series: { categoryIds?: string[] }): Category[] {
    const ids = series.categoryIds ?? [];
    return this.items.filter((c) => ids.includes(c.id));
  }
}

export const categories = new CategoriesState();

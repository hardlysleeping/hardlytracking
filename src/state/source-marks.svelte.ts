/**
 * The two marks, on sources.
 *
 * The same state as `state/categories.svelte.ts`, deliberately: same words, same three-state cycles,
 * same storage discipline (our own database, nothing written to the runtime). Policy is in
 * `lib/marks`; this class only persists and mutates.
 *
 * A source with no row in the store has no marks — "never touched" is not "unhidden on purpose", and
 * the store keeps that distinction by deleting a row whose marks are both off.
 */
import {
  HIDDEN_VIEW_LABELS,
  PIN_VIEW_LABELS,
  isHiddenView,
  isPinView,
  nextHiddenView,
  nextPinView,
  type HiddenView,
  type PinView,
} from "../lib/categories";
import { type SourceMark } from "../lib/marks";
import type { LibraryStore } from "../lib/db/store";

import { privacy } from "./privacy.svelte";

const HIDDEN_VIEW_KEY = "sources.hiddenView";
const PIN_VIEW_KEY = "sources.pinView";

class SourceMarksState {
  marks = $state<SourceMark[]>([]);
  #hiddenView = $state<HiddenView>("hidden");
  get hiddenView(): HiddenView { return privacy.locked ? "hidden" : this.#hiddenView; }
  set hiddenView(value: HiddenView) { if (!privacy.locked) this.#hiddenView = value; }
  pinView = $state<PinView>("all");
  loaded = $state(false);

  #store: LibraryStore | null = null;

  async load(store: LibraryStore): Promise<void> {
    if (this.loaded) return;
    this.#store = store;
    this.marks = await store.listSourceMarks();
    const hidden = await store.getPref<string>(HIDDEN_VIEW_KEY);
    const pin = await store.getPref<string>(PIN_VIEW_KEY);
    if (isHiddenView(hidden)) this.#hiddenView = hidden;
    if (isPinView(pin)) this.pinView = pin;
    this.loaded = true;
  }

  markOf(sourceId: string): SourceMark {
    return this.marks.find((mark) => mark.id === sourceId) ?? { id: sourceId, hidden: false, pinned: false, incognito: false };
  }

  get hiddenCount(): number {
    return this.marks.filter((mark) => mark.hidden).length;
  }

  get pinnedCount(): number {
    return this.marks.filter((mark) => mark.pinned).length;
  }

  get incognitoCount(): number {
    return this.marks.filter((mark) => mark.incognito).length;
  }

  get hiddenLabel(): string {
    return HIDDEN_VIEW_LABELS[this.hiddenView];
  }

  get pinLabel(): string {
    return PIN_VIEW_LABELS[this.pinView];
  }

  /** The incognito tally, in the reader's words, for the Browse band and its accessibility text. */
  get incognitoLabel(): string {
    const count = this.incognitoCount;
    if (count === 0) return "No sources incognito";
    return count === 1 ? "1 source incognito" : `${count} sources incognito`;
  }

  async setHidden(sourceId: string, hidden: boolean): Promise<void> {
    await this.#write(sourceId, { hidden });
  }

  /** The pin is its own mark: pinning never touches the eye, and vice versa. */
  async togglePin(sourceId: string): Promise<void> {
    await this.#write(sourceId, { pinned: !this.markOf(sourceId).pinned });
  }

  async toggleHidden(sourceId: string): Promise<void> {
    await this.#write(sourceId, { hidden: !this.markOf(sourceId).hidden });
  }

  /**
   * Incognito is its own mark too, independent of both others.
   *
   * A source can be hidden, incognito, both or neither. Incognito never removes a title from the
   * library or History — it only stops the reading log from recording it.
   */
  async setIncognito(sourceId: string, incognito: boolean): Promise<void> {
    await this.#write(sourceId, { incognito });
  }

  async toggleIncognito(sourceId: string): Promise<void> {
    await this.#write(sourceId, { incognito: !this.markOf(sourceId).incognito });
  }

  async cycleHiddenView(): Promise<void> {
    if (privacy.locked) return;
    this.hiddenView = nextHiddenView(this.hiddenView);
    await this.#store?.setPref(HIDDEN_VIEW_KEY, this.hiddenView);
  }

  async cyclePinView(): Promise<void> {
    this.pinView = nextPinView(this.pinView);
    await this.#store?.setPref(PIN_VIEW_KEY, this.pinView);
  }

  /**
   * The marks with the search-scoped pins folded in.
   *
   * Browse's pin glyph already meant "search starts here" before this card, and that meaning is
   * kept: the same button now also sets the mark, so the pin floats a source and filters the list
   * *and* search keeps starting from it. One glyph, both consequences, no second pin to explain.
   */
  withSearchPins(pinnedIds: readonly string[]): SourceMark[] {
    const out = this.marks.map((mark) => ({ ...mark }));
    for (const id of pinnedIds) {
      const existing = out.findIndex((mark) => mark.id === id);
      if (existing >= 0) out[existing] = { ...out[existing], pinned: true };
      else out.push({ id, hidden: false, pinned: true, incognito: false });
    }
    return out;
  }

  async #write(sourceId: string, change: Partial<Pick<SourceMark, "hidden" | "pinned" | "incognito">>): Promise<void> {
    if (this.#store === null || privacy.locked) return;
    const current = this.markOf(sourceId);
    await this.#store.putSourceMark({ ...current, ...change });
    const marks = await this.#store.listSourceMarks();
    if (!privacy.locked) this.marks = marks;
  }
}

export const sourceMarks = new SourceMarksState();

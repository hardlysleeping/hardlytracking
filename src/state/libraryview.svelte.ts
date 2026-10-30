/**
 * The library screen's memory of itself.
 *
 * Module state, not component state: a route change (Library → Series → back) destroys the view and
 * Svelte keeps this module alive, so the shelf comes back on the same collection, with the same
 * words in the search box and the same row under the thumb. Component-local `$state` made all of
 * that survive only by accident.
 *
 * Two kinds of memory live here, and they are not the same promise:
 *
 * - `collection` is durable. It is written to `settings.libraryCollection` too, so a relaunch opens
 *   the shelf the owner last looked at (§31's list of things a reload must keep).
 * - `query` is session-only, on purpose. A search box that comes back filled after a relaunch reads
 *   as an empty library — the plan says not to persist it, and it does not.
 */
import type { SearchScope } from "../lib/library/search";

export interface LibraryMemory {
  /** The collection the rail points at; `null` is the whole library. */
  collection: string | null;
  query: string;
  searching: boolean;
  scope: SearchScope;
  /** The scroller's offset, so coming back from a series lands on the same row. */
  scroll: number;
  /**
   * Whether this module has been through a mount in this page's lifetime. A reload starts false and
   * takes the durable collection from settings; a route change keeps it true and keeps what the
   * owner was looking at.
   */
  mounted: boolean;
}

export const libraryMemory = $state<LibraryMemory>({
  collection: null,
  query: "",
  searching: false,
  scope: "category",
  scroll: 0,
  mounted: false,
});

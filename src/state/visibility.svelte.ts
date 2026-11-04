import { categories } from "./categories.svelte";
import { sourceMarks } from "./source-marks.svelte";
import { privacy } from "./privacy.svelte";
import { library } from "./library.svelte";
import { contextOf, isHidden, sourceKeyOf, type Marked, type MappedSource } from "../lib/marks";
import type { LibraryStore } from "../lib/db/store";

/** Shared by fetched-result views: evaluate against current marks, never a fetch-time snapshot. */
class VisibilityState {
  mappings = $state<Map<string, MappedSource>>(new Map());
  ready = $state(false);
  saved = $derived(new Map(library.library.map((row) => [row.id, row])));
  context = $derived(contextOf({ categories: categories.items, sources: sourceMarks.marks, sourceOf: (id) => sourceKeyOf(id, this.mappings.get(id)) }));
  #store: LibraryStore | null = null;
  #generation = 0;
  #pending: Promise<void> | null = null;

  load(store: LibraryStore): Promise<void> {
    if (this.#store === store && this.#pending) return this.#pending;
    this.#store = store;
    const generation = ++this.#generation;
    this.ready = false;
    this.#pending = store.listMappings().then((rows) => {
      if (generation !== this.#generation) return;
      this.mappings = new Map(rows.map((row) => [row.seriesId, row]));
      this.ready = true;
    }).catch(() => {
      // Fail closed while locked; a later mount can retry a failed local read.
    }).finally(() => { if (generation === this.#generation) this.#pending = null; });
    return this.#pending;
  }
  allows(row: Marked): boolean {
    if (!privacy.locked) return true;
    if (row.id === "") return false;
    if (!categories.loaded || !sourceMarks.loaded || !this.ready) return false;
    const saved = this.saved.get(row.id);
    return !isHidden({ ...row, categoryIds: saved?.categoryIds ?? row.categoryIds }, this.context);
  }
  sourceAllowed(id: string): boolean {
    return !privacy.locked || (sourceMarks.loaded && !sourceMarks.markOf(id).hidden);
  }
}
export const visibility = new VisibilityState();

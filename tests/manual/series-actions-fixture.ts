// Synthetic series/category data in memoryDatabase only. Never calls library.open(), so the owner's
// shelf, feeds and device are never read. Open tests/manual/series-actions-fixture.html after
// starting this worktree's Vite, then drive it with series-actions-browser.mjs.
import { mount } from "svelte";
import Source from "../../src/views/Source.svelte";
import "../../src/app.css";
import { DEFAULT_THEME, themeVariables } from "../../src/lib/theme-model";
for (const [key, value] of Object.entries(themeVariables(DEFAULT_THEME))) document.documentElement.style.setProperty(key, value);

import { memoryDatabase } from "../../src/lib/db/open";
import { LibraryStore } from "../../src/lib/db/store";
import { downloads } from "../../src/state/downloads.svelte";
import { library } from "../../src/state/library.svelte";
import { categories } from "../../src/state/categories.svelte";
import { sourceMarks } from "../../src/state/source-marks.svelte";
import { settings } from "../../src/state/settings.svelte";
import { privacy } from "../../src/state/privacy.svelte";
import type { Series, Chapter, Source as SourceRow } from "../../src/api/source";

const store = new LibraryStore(memoryDatabase());
const db = store.database;

const titles = ["Fixture One", "Fixture Two", "Fixture Three", "Fixture Four", "Fixture Five", "Fixture Six"];
const rows: Series[] = titles.map((title, index) => ({
  id: `local:${index + 1}`,
  provider: "local",
  title,
  author: "Fixture Author",
  description: "A synthetic title for the series action fixture.",
  categoryIds: [],
}));
// A title the provider returns that is not in the library yet: the "add, then file" path.
const unsaved: Series = { id: "local:new", provider: "local", title: "Not In Library Yet", author: "Fixture Author" };
const unsaved2: Series = { id: "local:new2", provider: "local", title: "Also Not In Library", author: "Fixture Author" };

const chapters: Chapter[] = [...rows, unsaved, unsaved2].flatMap((row) =>
  Array.from({ length: 4 }, (_, index) => ({
    id: `${row.id}:ch${index + 1}`,
    seriesId: row.id,
    name: `Issue ${index + 1}`,
    number: index + 1,
    pageCount: 18,
    read: false,
  })),
);

for (const row of rows) {
  await store.addSeries(row);
  await store.putChapters(row.id, chapters.filter((chapter) => chapter.seriesId === row.id));
}

const provider = {
  kind: "local" as const,
  name: "Fixture provider",
  ownsProgress: true,
  popular: async () => ({ items: [...rows, unsaved, unsaved2], hasNext: false }),
  latest: async () => ({ items: [...rows, unsaved, unsaved2], hasNext: false }),
  search: async () => ({ items: [...rows, unsaved, unsaved2], hasNext: false }),
  details: async (id: string) => [...rows, unsaved, unsaved2].find((row) => row.id === id)!,
  chapters: async (id: string) => chapters.filter((chapter) => chapter.seriesId === id),
};

const sources: SourceRow[] = [{ id: "local:src:library", provider: "local", name: "Fixture Source" }];

library.profile = { store, providers: [provider], warnings: [] } as any;
library.sources = sources;
library.ready = true;
// The real chapters() and save() stay in place: the sheet's toggle path is what this fixture proves.
library.isSaved = async (id: string) => (await store.getSeries(id)) !== undefined;

downloads.load = async () => {};
downloads.rows = [];
downloads.knownTotals = async () => ({});
downloads.isDownloaded = () => false;
downloads.inQueue = () => false;
/** The queue is a record here, not an engine: the fixture only proves the tap asked for the work. */
const queuedCalls: Array<{ seriesId: string; count: number }> = [];
downloads.enqueueMany = ((seriesId: string, list: unknown[]) => {
  queuedCalls.push({ seriesId, count: list.length });
}) as typeof downloads.enqueueMany;

await settings.load(store);
await categories.load(store);
await sourceMarks.load(store);
await library.refreshLibrary();

// Enough shelves that the list/grid choice has something to choose between.
for (const name of ["Shelf A", "Shelf B", "Shelf C", "Shelf D", "Shelf E", "Shelf F", "Shelf G", "Shelf H"]) {
  await categories.create(name);
}

(window as any).seriesActionsFixture = {
  store,
  db,
  categories,
  library,
  settings,
  privacy,
  rows,
  unsaved,
  queuedCalls,
  /** Everything a reload would read: the persisted category ids and the shelf order. */
  snapshot: async () => ({
    series: (await store.listSeries()).map((row) => ({ id: row.id, categoryIds: row.categoryIds ?? [] })),
    byCategory: Object.fromEntries(
      await Promise.all(categories.items.map(async (category) => [
        category.name,
        (await store.seriesInCategory(category.id)).map((row) => row.id),
      ])),
    ),
    categories: categories.items.map((category) => category.name),
  }),
};

mount(Source, { target: document.body, props: { sourceId: "local:src:library" } });

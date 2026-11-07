// Synthetic records in memoryDatabase only. Never calls library.open(), so the owner's shelf is
// never read. Run with tests/manual/library-menu-browser.mjs against Vite.
import { mount } from "svelte";
import Fixture from "./LibraryMenuFixture.svelte";
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
import type { Series, Chapter, Source } from "../../src/api/source";

const store = new LibraryStore(memoryDatabase());
const rows: Series[] = [
  { id: "local:one", provider: "local", title: "Fixture One", categoryIds: [] },
  { id: "local:two", provider: "local", title: "Fixture Two", categoryIds: [] },
  { id: "local:three", provider: "local", title: "Fixture Three", categoryIds: [] },
];
const sources: Source[] = [{ id: "local:src:library", provider: "local", name: "Fixture Local Source" }];
const chapters: Chapter[] = rows.map((row) => ({
  id: `${row.id}:ch`,
  seriesId: row.id,
  name: `${row.title} issue`,
  number: 1,
  pageCount: 10,
  read: false,
}));
for (const row of rows) {
  await store.addSeries(row);
  await store.putChapters(row.id, chapters.filter((chapter) => chapter.seriesId === row.id));
}
const provider = {
  kind: "local" as const,
  name: "Fixture provider",
  ownsProgress: true,
  search: async () => ({ items: rows, hasNext: false }),
  details: async (id: string) => rows.find((row) => row.id === id)!,
  chapters: async (id: string) => chapters.filter((chapter) => chapter.seriesId === id),
};
library.profile = { store, providers: [provider], warnings: [] } as any;
library.library = rows;
library.sources = sources;
library.ready = true;
downloads.load = async () => {};
downloads.knownTotals = async () => ({});
downloads.rows = [];
library.chapters = async (id) => chapters.filter((chapter) => chapter.seriesId === id);
library.pages = async () => [];
library.ownsProgress = () => true;
library.remember = async () => {};
library.beginSession = async () => null;
library.endSession = async () => {};
library.continueReading = async () => rows.map((row) => ({
  seriesId: row.id,
  chapterId: `${row.id}:ch`,
  page: 2,
  title: row.title,
  chapterName: "Fixture issue",
}));
library.viewState = async () => undefined;
library.saveViewState = async () => {};

// The real settings store: `settings.set` writes `settings.*` rows, so the fold's round-trip is
// what the app would do, not a fixture stub.
await settings.load(store);
settings.showContinue = true;
settings.continuePosition = "above";
settings.continueMax = 10;
settings.continueSize = "small";
settings.continueCollapsed = false;

await categories.load(store);
await sourceMarks.load(store);

(window as any).libraryMenuFixture = {
  settings,
  store,
  library,
  /** Simulate a relaunch: read every pref again from the same store. */
  reload: () => settings.load(store),
};

mount(Fixture, { target: document.body });

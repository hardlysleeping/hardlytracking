// Isolated issue-list fixture: memory store, six generated chapters, no real library or downloads.
import { mount } from "svelte";
import "../../src/app.css";
import Series from "../../src/views/Series.svelte";
import { library } from "../../src/state/library.svelte";
import { settings } from "../../src/state/settings.svelte";
import { orderChapters } from "../../src/lib/chapter-order";

const args = new URLSearchParams(location.search);
const order = (args.get("order") === "oldest" ? "oldest" : "newest") as "oldest" | "newest";
const series = { id: "fixture:series", provider: "archive", title: "Fixture collection", categoryIds: [] };

// Six issues; handed over unsorted so the view's own ordering is what the test measures.
const chapters = [1, 2, 3, 4, 5, 6].map((n) => ({
  id: `fixture:series:${n}`,
  name: `Issue ${n}`,
  number: n,
  pageCount: 20 + n,
  read: false,
}));

const prefs: Array<{ key: string; value: unknown }> = [];
const store = {
  getSeries: async () => series,
  listChapters: async () => [],
  getPosition: async () => undefined,
  listPrefs: async () => prefs,
  setRead: async (id: string, read: boolean) => {
    const key = `read:${id}`;
    const at = prefs.findIndex((row) => row.key === key);
    if (read) {
      if (at >= 0) prefs[at].value = true;
      else prefs.push({ key, value: true });
    } else if (at >= 0) prefs.splice(at, 1);
    (window as unknown as { holdFixture: { marks: unknown[] } }).holdFixture.marks = [...prefs];
  },
  getProgress: async () => undefined,
  isRead: async (id: string) => prefs.some((row) => row.key === `read:${id}`),
  listBooks: async () => [],
  listMappings: async () => [],
  saveMapping: async () => {},
  removeMapping: async () => {},
};

(library as unknown as Record<string, unknown>).profile = { store, providers: [] };
library.details = async () => series as never;
library.chapters = async () => chapters as never;
library.isSaved = async () => true;
library.rememberSeriesMeta = async () => {};
library.ownsProgress = () => true;
library.advance = async () => {};
settings.continueAfterFinish = "nothing";
settings.chapterOrder = order;

(window as unknown as { holdFixture: unknown }).holdFixture = {
  marks: [],
  /** The ids in the order they are drawn — the order "above" and "below" must mean. */
  drawn: orderChapters(chapters as never, order).map((chapter: { id: string }) => chapter.id),
};

mount(Series, { target: document.querySelector("#qa") as HTMLElement, props: { seriesId: series.id } });

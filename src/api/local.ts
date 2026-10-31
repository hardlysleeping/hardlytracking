/**
 * LocalProvider — the library that lives on this device.
 *
 * It exists for two reasons: the app must be usable with no runtime at all, and it
 * is the only provider whose progress we own (`ownsProgress: true`). Everything it
 * answers comes out of `LibraryStore`, so it is also the honest test double for the
 * seam: if the UI works against this, it is not secretly talking to Suwayomi.
 */
import { joinId, nativeId, paged, type Chapter, type Paged, type Series, type Source, type SourceProvider } from "./source";
import type { LibraryStore } from "../lib/db/store";
import { openComic } from "../lib/files/index";

export const LOCAL_SOURCE_ID = "local:src:library";

export function createLocalProvider(store: LibraryStore): SourceProvider {
  const page = async (items: Series[], index: number): Promise<Paged<Series>> => {
    const size = 60;
    const start = (index - 1) * size;
    return paged(items.slice(start, start + size), start + size < items.length);
  };

  return {
    kind: "local",
    ownsProgress: true,

    async sources(): Promise<Source[]> {
      return [{ id: LOCAL_SOURCE_ID, provider: "local", name: "On this device", supportsLatest: false }];
    },

    async popular(_sourceId, index) {
      return page(await store.listSeries(), index);
    },

    async latest(_sourceId, index) {
      return page(await store.listSeries(), index);
    },

    async search(_sourceId, query, index) {
      const needle = query.trim().toLowerCase();
      const all = await store.listSeries();
      const hits = needle === "" ? all : all.filter((s) => s.title.toLowerCase().includes(needle));
      return page(hits, index);
    },

    async details(seriesId) {
      nativeId(seriesId, "local");
      const series = await store.getSeries(seriesId);
      if (!series) throw new Error(`not in the library: ${seriesId}`);
      return series;
    },

    async chapters(seriesId) {
      nativeId(seriesId, "local");
      const rows = await store.listChapters(seriesId);
      return Promise.all(rows.map(async (c) => ({ ...c, read: await store.isRead(c.id) })));
    },

    async pages(chapterId) {
      nativeId(chapterId, "local");
      // A book the user picked off their own disk: its pages are produced from the file on demand,
      // never unpacked up front. Anything else local is a chapter we already hold as page blobs.
      const books = await store.listBooks();
      const book = books.find((row) => row.chapterId === chapterId);
      if (book === undefined) return store.getPages(chapterId);
      const comic = await openComic(book.blob, book.name);
      return Array.from({ length: comic.pageCount }, (_, index) => ({
        index,
        // A stable pseudo-URL: `pageSrc` keys its blob cache on it, so a page keeps one URL while the
        // reader's window holds it.
        url: `book:${book.seriesId}#${index}`,
        open: () => comic.open(index),
      }));
    },

    async setRead(chapterId, read) {
      nativeId(chapterId, "local");
      await store.setRead(chapterId, read);
    },
  };
}

/** Ids for rows this provider invents (nothing is created here yet; kept for symmetry). */
export function localSeriesId(native: string): string {
  return joinId("local", native);
}

export type { Chapter };

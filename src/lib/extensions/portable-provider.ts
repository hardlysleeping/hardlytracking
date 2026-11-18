/**
 * `SourceProvider` over a portable extension's Worker.
 *
 * The seam does not move: the UI asks the same nine questions and receives the same objects. What is
 * different is where the answers come from, and one rule makes the two sides safe to join —
 *
 * **Naming is the host's job.** A package works entirely in its own native ids (`server1:series1`);
 * the provider namespaces what comes back (`komga:server1:series1`) and strips what goes down. If the
 * package were asked to spell our ids, a port could rename one and orphan every library row, read
 * mark and page position keyed by it.
 *
 * Payloads are validated on the way in for the same reason: a series without an id is not a series
 * with an empty id, it is a broken package, and the failure must name it rather than draw a row that
 * cannot be opened.
 */
import {
  joinId,
  nativeId,
  type BrowseTab,
  type Chapter,
  type Page,
  type Paged,
  type ProviderKind,
  type RemoteRead,
  type Series,
  type Source,
  type SourceFilter,
  type SourceFilterSelection,
  type SourceProvider,
} from "../../api/source";
import type { PortableMethod } from "./worker/protocol";

/** The smallest surface the provider needs from a Worker. A fake one is enough to unit-test it. */
export interface PortableRuntime {
  /** Whether the package declares this method at all. */
  supports(method: PortableMethod): boolean;
  call<T>(method: PortableMethod, args: readonly unknown[]): Promise<T>;
  /** Stop the worker. Called when its extension row is removed or disabled. */
  close?(): void;
}

export interface PortableProviderOptions {
  /** The kind the package declared, and the namespace every id is emitted under. */
  kind: ProviderKind;
  /** For messages: which package answered badly. */
  packageId: string;
  /**
   * Whether *our* database owns reading progress.
   *
   * `false` for Komga and Suwayomi, whose servers keep it and whose `readState` we mirror; `true` for
   * Internet Archive, which has no server. Two writers on one row is what this flag prevents.
   */
  ownsProgress: boolean;
  runtime: PortableRuntime;
  /**
   * Whether this provider answers for an id that several providers share a kind with (several Komga
   * servers). Absent means the kind alone is enough.
   */
  owns?: (id: string) => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function required(raw: Record<string, unknown>, field: string, what: string, packageId: string): string {
  const value = raw[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${packageId} answered a ${what} without an ${field === "id" ? "id" : field}`);
  }
  return value;
}

/** One `Series`, namespaced, with every optional field carried through untouched. */
function seriesOf(kind: ProviderKind, packageId: string, raw: unknown): Series {
  if (!isRecord(raw)) throw new Error(`${packageId} answered a series that is not an object`);
  const id = required(raw, "id", "series", packageId);
  const out: Series = {
    id: joinId(kind, id),
    provider: kind,
    title: typeof raw.title === "string" && raw.title !== "" ? raw.title : id,
  };
  if (typeof raw.cover === "string" && raw.cover !== "") out.cover = raw.cover;
  if (isRecord(raw.coverHeaders)) out.coverHeaders = raw.coverHeaders as Record<string, string>;
  if (typeof raw.author === "string") out.author = raw.author;
  if (typeof raw.description === "string") out.description = raw.description;
  if (typeof raw.status === "string") out.status = raw.status;
  if (typeof raw.url === "string" && raw.url !== "") out.url = raw.url;
  // A source row id is ours, so it is namespaced like every other id the UI holds.
  if (typeof raw.sourceId === "string" && raw.sourceId !== "") out.sourceId = joinId(kind, raw.sourceId);
  return out;
}

function chapterOf(kind: ProviderKind, packageId: string, seriesId: string, raw: unknown): Chapter {
  if (!isRecord(raw)) throw new Error(`${packageId} answered a chapter that is not an object`);
  const id = required(raw, "id", "chapter", packageId);
  const out: Chapter = {
    id: joinId(kind, id),
    seriesId,
    name: typeof raw.name === "string" && raw.name !== "" ? raw.name : id,
    number: typeof raw.number === "number" && Number.isFinite(raw.number) ? raw.number : 0,
    pageCount: typeof raw.pageCount === "number" && Number.isFinite(raw.pageCount) ? raw.pageCount : 0,
    read: raw.read === true,
  };
  if (typeof raw.uploadedAt === "number" && Number.isFinite(raw.uploadedAt)) out.uploadedAt = raw.uploadedAt;
  return out;
}

/**
 * One page of a chapter, numbered by where the package put it.
 *
 * The package's own `index` is ignored on purpose: a third-party package is free to number from 1,
 * to skip, or to repeat a number, and this client addresses pages by position (the reader's notes,
 * `data-page`, progress and resume all do). `index` is the position in the list the package answered.
 */
function pageOf(packageId: string, raw: unknown, index: number): Page {
  if (!isRecord(raw)) throw new Error(`${packageId} answered a page that is not an object`);
  if (typeof raw.url !== "string" || raw.url === "") {
    throw new Error(`${packageId} answered a page without a url`);
  }
  const out: Page = { index, url: raw.url };
  if (isRecord(raw.headers)) out.headers = raw.headers as Record<string, string>;
  return out;
}

function pagedOf<T>(packageId: string, raw: unknown, map: (item: unknown) => T): Paged<T> {
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new Error(`${packageId} answered a page of results that is not { items, hasNext }`);
  }
  return { items: raw.items.map(map), hasNext: raw.hasNext === true };
}

export function createPortableProvider(options: PortableProviderOptions): SourceProvider {
  const { kind, packageId, runtime } = options;
  const native = (id: string): string => nativeId(id, kind);

  const provider: SourceProvider = {
    kind,
    ownsProgress: options.ownsProgress,

    sources: async (): Promise<Source[]> => {
      const raw = await runtime.call<unknown[]>("sources", []);
      if (!Array.isArray(raw)) throw new Error(`${packageId} answered a source list that is not an array`);
      return raw.map((item) => {
        if (!isRecord(item)) throw new Error(`${packageId} answered a source that is not an object`);
        const id = required(item, "id", "source", packageId);
        const source: Source = {
          id: joinId(kind, id),
          provider: kind,
          name: typeof item.name === "string" && item.name !== "" ? item.name : id,
        };
        if (typeof item.lang === "string") source.lang = item.lang;
        if (item.nsfw === true) source.nsfw = true;
        if (typeof item.supportsLatest === "boolean") source.supportsLatest = item.supportsLatest;
        if (typeof item.baseUrl === "string" && item.baseUrl !== "") source.baseUrl = item.baseUrl;
        // A package may put Trending first, or offer it at all, by declaring its own row. Unknown
        // names are dropped: the host draws only listings it can actually call.
        if (Array.isArray(item.browseTabs)) {
          const tabs = item.browseTabs.filter(
            (tab): tab is BrowseTab => tab === "trending" || tab === "popular" || tab === "latest",
          );
          if (tabs.length > 0) source.browseTabs = tabs;
        }
        return source;
      });
    },

    popular: async (sourceId, page) =>
      pagedOf(packageId, await runtime.call("popular", [native(sourceId), page]), (item) => seriesOf(kind, packageId, item)),

    latest: async (sourceId, page) =>
      pagedOf(packageId, await runtime.call("latest", [native(sourceId), page]), (item) => seriesOf(kind, packageId, item)),

    search: async (sourceId, query, page, filters?: SourceFilterSelection) =>
      pagedOf(
        packageId,
        await runtime.call("search", filters === undefined ? [native(sourceId), query, page] : [native(sourceId), query, page, filters]),
        (item) => seriesOf(kind, packageId, item),
      ),

    details: async (seriesId) => seriesOf(kind, packageId, await runtime.call("details", [native(seriesId)])),

    chapters: async (seriesId) => {
      const raw = await runtime.call<unknown[]>("chapters", [native(seriesId)]);
      if (!Array.isArray(raw)) throw new Error(`${packageId} answered a chapter list that is not an array`);
      return raw.map((item) => chapterOf(kind, packageId, seriesId, item));
    },

    pages: async (chapterId) => {
      const raw = await runtime.call<unknown[]>("pages", [native(chapterId)]);
      if (!Array.isArray(raw)) throw new Error(`${packageId} answered a page list that is not an array`);
      return raw.map((item, index) => pageOf(packageId, item, index));
    },

    // `page` is the bookmark the server keeps; a package that has none ignores it.
    setRead: async (chapterId, read, page) => {
      if (!runtime.supports("setRead")) throw new Error(`${packageId} cannot write read state (setRead is absent)`);
      await runtime.call("setRead", page === undefined ? [native(chapterId), read] : [native(chapterId), read, page]);
    },
  };

  // Optional members are attached only when the package has them, so an absent filter form stays
  // absent instead of becoming an empty sheet.
  if (runtime.supports("filters")) {
    provider.filters = async (sourceId): Promise<SourceFilter[]> => {
      const raw = await runtime.call<unknown[]>("filters", [native(sourceId)]);
      if (!Array.isArray(raw)) throw new Error(`${packageId} answered a filter list that is not an array`);
      return raw as SourceFilter[];
    };
  }
  if (runtime.supports("readState")) {
    provider.readState = async (seriesId): Promise<RemoteRead[]> => {
      const raw = await runtime.call<unknown[]>("readState", [native(seriesId)]);
      if (!Array.isArray(raw)) throw new Error(`${packageId} answered a read-state list that is not an array`);
      return raw as RemoteRead[];
    };
  }
  if (options.owns !== undefined) provider.owns = options.owns;
  // Assigned only when the package defines it, so the tab row can trust the presence of `trending`:
  // a chip is never drawn for a listing that would throw on tap.
  if (runtime.supports("trending")) {
    provider.trending = async (sourceId, page) =>
      pagedOf(packageId, await runtime.call("trending", [native(sourceId), page]), (item) => seriesOf(kind, packageId, item));
  }

  return provider;
}

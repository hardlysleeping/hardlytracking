/**
 * The seam.
 *
 * Everything the app reads comes through a `SourceProvider`. The UI never learns
 * whether a series lives in a Mihon extension host, a Komga server or a folder on
 * this device — it asks the same nine questions and renders the same objects.
 *
 * This is HardlyReader's `ReaderBackend` idea (`~/apps/hardlyread/src/api/backend.ts`)
 * applied to comics. Two rules keep it honest:
 *
 * 1. **Ids are namespaced strings.** `mihon:12`, `mihon:ch:1`, `local:src:library`.
 *    A provider strips its own prefix and nothing else, so a row drawn from the
 *    runtime and a row drawn from our own database can never collide.
 * 2. **A provider that cannot honour an operation rejects.** It never resolves to
 *    something plausible: a wrong "read" mark is worse than a visible failure.
 */

/**
 * `mihon` is the Suwayomi runtime and `dalvik` a M-Extension-Server host. They run the
 * same extension format but they are two different servers with two different id spaces,
 * so they get two kinds: sharing `mihon` would make `providerFor` hand a dalvik id to
 * Suwayomi (first match wins) and every lookup would land on the wrong host.
 */
export type ProviderKind = "mihon" | "dalvik" | "komga" | "local";

export interface Source {
  /** Namespaced: `mihon:src:0`. */
  id: string;
  provider: ProviderKind;
  name: string;
  lang?: string;
  nsfw?: boolean;
  supportsLatest?: boolean;
}

export interface Series {
  /** Namespaced: `mihon:12`. */
  id: string;
  provider: ProviderKind;
  title: string;
  cover?: string;
  author?: string;
  description?: string;
  status?: string;
  /** Ids of the local categories this row is filed under. Empty/absent = uncategorised. */
  categoryIds?: string[];
}

export interface Chapter {
  /** Namespaced: `mihon:ch:1`. */
  id: string;
  seriesId: string;
  name: string;
  number: number;
  pageCount: number;
  read: boolean;
  /**
   * When the chapter was published, in ms, when the host says so.
   *
   * Optional because the runtime does not always know: a missing date is left missing rather than
   * filled with "now", which would make every chapter look new on every refresh.
   */
  uploadedAt?: number;
}

export interface Page {
  index: number;
  url: string;
  /**
   * Headers the source requires to serve this image (`Referer`, `Origin`, …).
   *
   * An `<img>` cannot send them, so a page that carries headers is fetched through the app's
   * `/api/img` route instead of being pointed at directly. Absent means "plain URL, load it".
   */
  headers?: Record<string, string>;
}

export interface Paged<T> {
  items: T[];
  hasNext: boolean;
}

/**
 * Who owns reading progress for a provider's series.
 *
 * `ownsProgress: false` means the server already keeps it (Suwayomi, Komga) and
 * our database only mirrors it for offline display; `true` means the library is
 * ours to write. Two writers on one row is the failure this flag exists to stop.
 */
export interface SourceProvider {
  readonly kind: ProviderKind;
  readonly ownsProgress: boolean;

  sources(): Promise<Source[]>;
  popular(sourceId: string, page: number): Promise<Paged<Series>>;
  latest(sourceId: string, page: number): Promise<Paged<Series>>;
  search(sourceId: string, query: string, page: number): Promise<Paged<Series>>;
  details(seriesId: string): Promise<Series>;
  chapters(seriesId: string): Promise<Chapter[]>;
  pages(chapterId: string): Promise<Page[]>;
  /** No-op semantics are not allowed: when `ownsProgress` is false this writes through to the server. */
  setRead(chapterId: string, read: boolean): Promise<void>;
}

const KINDS: ProviderKind[] = ["mihon", "dalvik", "komga", "local"];

export function joinId(provider: ProviderKind, native: string | number): string {
  return `${provider}:${native}`;
}

/** `mihon:ch:1` -> `{ provider: "mihon", native: "ch:1" }`. Throws on a foreign id. */
export function splitId(id: string): { provider: ProviderKind; native: string } {
  const at = id.indexOf(":");
  if (at < 1) throw new Error(`not a namespaced id: ${id}`);
  const provider = id.slice(0, at) as ProviderKind;
  if (!KINDS.includes(provider)) throw new Error(`unknown provider in id: ${id}`);
  return { provider, native: id.slice(at + 1) };
}

/** The bare id a provider's API expects, or an error naming the mismatch. */
export function nativeId(id: string, expected: ProviderKind): string {
  const { provider, native } = splitId(id);
  if (provider !== expected) throw new Error(`${id} is not a ${expected} id`);
  return native;
}

export function paged<T>(items: T[], hasNext: boolean): Paged<T> {
  return { items, hasNext };
}

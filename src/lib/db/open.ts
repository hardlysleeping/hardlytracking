/**
 * Where the app's own database lives.
 *
 * Same rule as HardlyReader's `openLocalDatabase` (`~/apps/hardlyread/src/api/local/open.ts`):
 * SQLite inside the packaged apps, IndexedDB in a browser tab. The rest of the app
 * only sees `Database`, so a store written for one engine runs on both.
 *
 * Only two engines exist: IndexedDB in a browser tab, SQLite (`sqlite.ts`) in the packaged desktop
 * app. Both are reached from here so that the store is written once.
 */

export const STORES = [
  "series",
  "chapters",
  "progress",
  "prefs",
  "pages",
  "categories",
  "sourceMarks",
  "extensions",
  "extensionPrefs",
  "history",
  "sessions",
  "position",
  "mappings",
  "repos",
  "downloads",
  "downloadPages",
  /** The bytes behind a `downloadPages` row, keyed by the same id. */
  "downloadPageData",
  /** The bytes behind an `imageCache` row. Kept apart so a touch is a metadata write. */
  "imageCacheData",
  /** The bytes of a `books` row, so listing a shelf never reads a comic file. */
  "bookFiles",
  "viewState",
  "syncMeta",
  "tombstones",
  "imageCache",
  "searchCache",
  "knownSeries",
  "cookies",
  "trackers",
  "trackerAccounts",
  /** A comic file this device holds: the bytes, the page count, nothing decoded. */
  "books",
  /** An installed community plugin: its manifest, its grant and its failure count. */
  "plugins",
  /** The plugin's own package bytes, keyed `<id>@<version>` so a rollback needs no download. */
  "pluginPackages",
  /** A plugin's own key/value space. Namespaced by plugin id in the row key. */
  "pluginStorage",
] as const;
export type StoreName = (typeof STORES)[number];

/**
 * The primary key of each store, in one place.
 *
 * Two engines read this map — IndexedDB's `createObjectStore` and the in-memory double — and
 * they used to keep their own copies of the same ternary. They drifted, and the symptom was
 * invisible in tests (the double happily keyed every row "undefined") while the browser threw
 * `DataError: key path did not yield a value`. One map, both engines.
 */
const KEY_PATH: Record<StoreName, string> = {
  series: "id",
  chapters: "id",
  progress: "chapterId",
  prefs: "key",
  pages: "chapterId",
  categories: "id",
  sourceMarks: "id",
  extensions: "extensionId",
  extensionPrefs: "key",
  history: "chapterId",
  sessions: "id",
  position: "seriesId",
  mappings: "seriesId",
  repos: "url",
  books: "seriesId",
  plugins: "id",
  pluginPackages: "id",
  pluginStorage: "key",
  downloads: "chapterId",
  downloadPages: "id",
  downloadPageData: "id",
  imageCacheData: "key",
  bookFiles: "seriesId",
  viewState: "key",
  syncMeta: "key",
  tombstones: "key",
  imageCache: "key",
  searchCache: "key",
  knownSeries: "id",
  cookies: "key",
  trackers: "id",
  trackerAccounts: "service",
};

export function keyPathOf(store: StoreName): string {
  return KEY_PATH[store];
}

/**
 * The field that says which row a store's rows belong to, where that is not the key.
 *
 * A chapter is keyed by its own id and carries `seriesId`, so "this series' chapters" was a whole
 * store read plus a filter — 48 000 rows and 129 ms per pane pick on a large library, paid again for
 * every title opened. A projection of that field is what both engines can answer cheaply from:
 * IndexedDB an index on the store, SQLite a column in the same row, in the same statement as the
 * document. Neither can drift, because both are derived from the row that is being written.
 */
const OWNER_PATH: Partial<Record<StoreName, string>> = {
  chapters: "seriesId",
};

/** The index's name in IndexedDB and SQLite's column both use this word. */
export const OWNER_INDEX = "owner";

export function ownerPathOf(store: StoreName): string | undefined {
  return OWNER_PATH[store];
}

/** Every store that has an owner field, for the engine that has to create and fill it. */
export function ownerStores(): Array<[StoreName, string]> {
  return Object.entries(OWNER_PATH) as Array<[StoreName, string]>;
}

export interface Database {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put(store: StoreName, value: Record<string, unknown>): Promise<void>;
  all<T>(store: StoreName): Promise<T[]>;
  /**
   * Every row whose key starts with `prefix`, without reading the rest of the store.
   *
   * A downloaded chapter's pages are keyed `${chapterId}#${index}`, so "this chapter's pages" is a
   * prefix question. It used to be answered by reading every page row on the device and filtering in
   * JavaScript — with the image blobs attached, because they lived in the same row. One chapter's
   * pages must cost one chapter, not the whole download folder.
   */
  prefix<T>(store: StoreName, prefix: string): Promise<T[]>;
  /**
   * Every row of `store` whose owner field equals `owner`, without reading the rest.
   *
   * The counterpart to `prefix` for stores whose owner is a field rather than the key: a chapter's
   * series. It is what keeps opening a title proportional to that title instead of to the library.
   * Throws for a store that has no owner field — the question has no answer there, and a silent
   * `[]` would read as "this series has no chapters".
   */
  byOwner<T>(store: StoreName, owner: string): Promise<T[]>;
  remove(store: StoreName, key: string): Promise<void>;
}

const DB_NAME = "hardlytracking";
// 18: the `owner` index — see `byOwner`, and 17: the bytes stores (`bookFiles`, `downloadPageData`,
// `imageCacheData`) — see `STORES`.
const DB_VERSION = 18;

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb request failed"));
  });
}

export async function openDatabase(options: { connect?: import("./sqlite").SqlConnector } = {}): Promise<Database> {
  // A Tauri window can have IndexedDB and must still get SQLite: a library in the webview's origin
  // storage is invisible to the user, awkward to back up, and cleared by accident. Imported
  // dynamically so a browser build never pulls the plugin into the bundle.
  if ("__TAURI_INTERNALS__" in globalThis) {
    const { SqliteDatabase, LOCAL_DATABASE_FILE } = await import("./sqlite");
    return SqliteDatabase.open(LOCAL_DATABASE_FILE, options.connect);
  }
  return openIndexedDb();
}

function openIndexedDb(): Promise<Database> {
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    // A webview that has no IndexedDB at all (storage disabled by policy, a private context, or a
    // custom-scheme origin WebKit refuses to persist) must say so, not hang: `indexedDB.open` on an
    // undefined global throws a ReferenceError inside the executor, which is a rejection the caller
    // can act on — but only if the message is a sentence rather than "indexedDB is not defined".
    if (typeof indexedDB === "undefined") {
      reject(new Error("this webview has no local database to open"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        const keyPath = KEY_PATH[name];
        let store: IDBObjectStore | undefined;
        if (db.objectStoreNames.contains(name)) {
          // A store whose key path changed cannot be keyed correctly, so it is rebuilt rather
          // than left to fail on the first write (that is what `DataError: key path did not
          // yield a value` meant for `extensions`). The row shape changed with the key, so the
          // old rows are unreadable anyway.
          const existing = request.transaction?.objectStore(name);
          if (existing !== undefined && existing.keyPath === keyPath) store = existing;
          else db.deleteObjectStore(name);
        }
        store ??= db.createObjectStore(name, { keyPath });
        // The owner index is added to an existing store in place: its rows already carry the
        // field, and IndexedDB fills the index from them as it is created, so no migration pass.
        const ownerPath = OWNER_PATH[name];
        if (ownerPath !== undefined && !store.indexNames.contains(OWNER_INDEX)) {
          store.createIndex(OWNER_INDEX, ownerPath);
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("could not open indexeddb"));
    // A second connection holding an older version blocks the upgrade, and `onblocked` is the only
    // notice there is: without it the request never settles and boot waits forever. A rejection is
    // an answer the library can work around; a pending promise is the dead screen.
    request.onblocked = () =>
      reject(new Error("another window is holding this device's library database open"));
  });

  return opening.then((db) => {
    const tx = (name: StoreName, mode: IDBTransactionMode) => db.transaction(name, mode).objectStore(name);
    return {
      get: <T,>(store: StoreName, key: string) => wrap<T | undefined>(tx(store, "readonly").get(key) as IDBRequest<T | undefined>),
      put: (store: StoreName, value: Record<string, unknown>) => wrap(tx(store, "readwrite").put(value)).then(() => undefined),
      all: <T,>(store: StoreName) => wrap<T[]>(tx(store, "readonly").getAll() as IDBRequest<T[]>),
      // A key range, not a scan: `getAll` on a bounded range reads only the rows in it.
      prefix: <T,>(store: StoreName, prefix: string) =>
        wrap<T[]>(
          tx(store, "readonly").getAll(
            IDBKeyRange.bound(prefix, `${prefix}\uffff`),
          ) as IDBRequest<T[]>,
        ),
      byOwner: <T,>(store: StoreName, owner: string) => {
        const ownerPath = ownerPathOf(store);
        if (ownerPath === undefined) {
          return Promise.reject(new Error(`${store} rows have no owner to read by`));
        }
        return wrap<T[]>(tx(store, "readonly").index(OWNER_INDEX).getAll(owner) as IDBRequest<T[]>);
      },
      remove: (store: StoreName, key: string) => wrap(tx(store, "readwrite").delete(key)).then(() => undefined),
    };
  });
}

/** In-memory engine for tests and for a browser without IndexedDB. */
export function memoryDatabase(): Database {
  const tables = new Map<StoreName, Map<string, Record<string, unknown>>>();
  const table = (store: StoreName) => {
    let t = tables.get(store);
    if (!t) {
      t = new Map();
      tables.set(store, t);
    }
    return t;
  };
  const keyOf = (store: StoreName, value: Record<string, unknown>): string => {
    const key = value[KEY_PATH[store]];
    // The browser refuses a row whose key path is empty; the double must refuse it too, or a
    // test passes on rows the real database would have rejected.
    if (key === undefined || key === null || key === "") {
      throw new Error(`${store} row has no ${KEY_PATH[store]}`);
    }
    return String(key);
  };
  return {
    async get<T,>(store: StoreName, key: string) {
      return table(store).get(key) as T | undefined;
    },
    async put(store: StoreName, value: Record<string, unknown>) {
      table(store).set(keyOf(store, value), value);
    },
    async all<T,>(store: StoreName) {
      return [...table(store).values()] as T[];
    },
    async prefix<T,>(store: StoreName, prefix: string) {
      return [...table(store).entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value) as T[];
    },
    async byOwner<T,>(store: StoreName, owner: string) {
      const ownerPath = ownerPathOf(store);
      // The double answers the same question the engines do, and refuses the same one they refuse.
      if (ownerPath === undefined) throw new Error(`${store} rows have no owner to read by`);
      return [...table(store).values()].filter((value) => value[ownerPath] === owner) as T[];
    },
    async remove(store: StoreName, key: string) {
      table(store).delete(key);
    },
  };
}

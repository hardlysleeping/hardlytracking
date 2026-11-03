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

export interface Database {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put(store: StoreName, value: Record<string, unknown>): Promise<void>;
  all<T>(store: StoreName): Promise<T[]>;
  remove(store: StoreName, key: string): Promise<void>;
}

const DB_NAME = "hardlytracking";
const DB_VERSION = 16;

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
        if (db.objectStoreNames.contains(name)) {
          // A store whose key path changed cannot be keyed correctly, so it is rebuilt rather
          // than left to fail on the first write (that is what `DataError: key path did not
          // yield a value` meant for `extensions`). The row shape changed with the key, so the
          // old rows are unreadable anyway.
          const existing = request.transaction?.objectStore(name).keyPath;
          if (existing === keyPath) continue;
          db.deleteObjectStore(name);
        }
        db.createObjectStore(name, { keyPath });
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
    async remove(store: StoreName, key: string) {
      table(store).delete(key);
    },
  };
}

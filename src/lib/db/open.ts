/**
 * Where the app's own database lives.
 *
 * Same rule as HardlyReader's `openLocalDatabase` (`~/apps/hardlyread/src/api/local/open.ts`):
 * SQLite inside the packaged apps, IndexedDB in a browser tab. The rest of the app
 * only sees `Database`, so a store written for one engine runs on both.
 *
 * Only the browser engine is written today; the packaged one arrives with the
 * desktop card (T6) and must land here, not in a second store.
 */

export const STORES = ["series", "chapters", "progress", "prefs", "pages", "categories", "extensions", "history", "position", "mappings", "repos"] as const;
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
  extensions: "extensionId",
  history: "chapterId",
  position: "seriesId",
  mappings: "seriesId",
  repos: "url",
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
const DB_VERSION = 6;

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb request failed"));
  });
}

export async function openDatabase(): Promise<Database> {
  if ("__TAURI_INTERNALS__" in globalThis) {
    throw new Error("the packaged database is not wired yet (card T6); run the web build");
  }
  return openIndexedDb();
}

function openIndexedDb(): Promise<Database> {
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
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

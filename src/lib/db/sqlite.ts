/**
 * The desktop store: SQLite, through the Tauri SQL plugin.
 *
 * Same rule as the browser engine in `open.ts` — the rest of the app only sees `Database`, so this
 * file is the only one that knows SQL. The sibling project's driver (`~/apps/hardlyread/src/api/
 * local/sqlite-db.ts`) already proved the plugin's two traps, and both are honoured here:
 *
 * - **Placeholders are `$1`, `$2`, …** The plugin uses sqlx, whose SQLite driver numbers its
 *   arguments; a `?` looks right and binds nothing.
 * - **Writes are serialised.** Two concurrent writes would interleave on the plugin's pool. The
 *   chain below is enough because the app is one thread.
 *
 * Two decisions are this app's own:
 *
 * - **One table, not twenty-four.** The interface is `get`/`put`/`all`/`remove` by key — nothing in
 *   the app queries a store by anything else. So a store is a namespace in `records`, not a schema,
 *   and adding the next store is a line in `STORES` with no migration.
 * - **Documents are JSON, blobs are base64.** `imageCache` and `downloadPages` store `Blob`s, and
 *   `JSON.stringify(blob)` is `{}` — silently writing empty rows. The plugin's values cross IPC as
 *   JSON, so binary cannot ride alongside; it is encoded, tagged, and rebuilt on the way out.
 */
import { keyPathOf, ownerPathOf, ownerStores, OWNER_INDEX, type Database, type StoreName } from "./open";

/** The file inside the app's data directory. */
export const LOCAL_DATABASE_FILE = "hardlytracking.db";

/**
 * The slice of `@tauri-apps/plugin-sql` this engine uses.
 *
 * Declared rather than imported so this file can be read on its own, and so the package stays a
 * runtime import: a browser build must never pull it into the bundle.
 */
export interface SqlDatabase {
  execute(query: string, values?: unknown[]): Promise<unknown>;
  select<T>(query: string, values?: unknown[]): Promise<T>;
  close?(): Promise<boolean>;
}

/**
 * How the plugin is reached, given a file name.
 *
 * Injectable for one reason: the statements below are the ones the desktop build runs, and the only
 * way to run them without launching the app is to hand this engine something that speaks the same
 * three-method slice. A test passes a real SQLite (`node:sqlite`) and the SQL under test is still
 * this file's.
 */
export type SqlConnector = (name: string) => Promise<SqlDatabase>;

async function connectPlugin(name: string): Promise<SqlDatabase> {
  let Database: typeof import("@tauri-apps/plugin-sql").default;
  try {
    Database = (await import("@tauri-apps/plugin-sql")).default;
  } catch {
    throw new Error(
      "the SQLite plugin is not in this build, so the desktop library cannot be opened; run the desktop app",
    );
  }
  return (await Database.load(`sqlite:${name}`)) as unknown as SqlDatabase;
}

const CREATE = `CREATE TABLE IF NOT EXISTS records (
  store TEXT NOT NULL,
  key TEXT NOT NULL,
  doc TEXT NOT NULL,
  owner TEXT,
  PRIMARY KEY (store, key)
)`;

/**
 * The owner column, for a library written before it existed.
 *
 * `owner` is a projection of a field inside the document (a chapter's `seriesId`), so it can always
 * be rebuilt from the row: one `UPDATE` with `json_extract` fills 48 000 rows inside SQLite instead
 * of parsing them in JavaScript. A very old or unusual SQLite build without the JSON functions gets
 * the same result one row at a time — slower, once, and only on the path where it is needed.
 */
async function ensureOwnerColumn(db: SqlDatabase): Promise<void> {
  const columns = await db.select<Array<{ name: string }>>("PRAGMA table_info(records)");
  if (!columns.some((column) => column.name === OWNER_INDEX)) {
    await db.execute(`ALTER TABLE records ADD COLUMN ${OWNER_INDEX} TEXT`);
  }
  await db.execute(`CREATE INDEX IF NOT EXISTS records_owner ON records (store, ${OWNER_INDEX})`);
  for (const [store, field] of ownerStores()) {
    try {
      await db.execute(
        `UPDATE records SET ${OWNER_INDEX} = json_extract(doc, '$."${field}"')
         WHERE store = $1 AND ${OWNER_INDEX} IS NULL`,
        [store],
      );
    } catch {
      const rows = await db.select<Array<{ key: string; doc: string }>>(
        `SELECT key, doc FROM records WHERE store = $1 AND ${OWNER_INDEX} IS NULL`,
        [store],
      );
      for (const row of rows) {
        const owner = (JSON.parse(row.doc) as Record<string, unknown>)[field];
        if (typeof owner !== "string") continue;
        await db.execute(`UPDATE records SET ${OWNER_INDEX} = $3 WHERE store = $1 AND key = $2`, [
          store,
          row.key,
          owner,
        ]);
      }
    }
  }
}

/** Marks a binary value on the wire. A document cannot contain this key by accident. */
const BLOB = "__hardlytracking_blob__";

interface WireBlob {
  [BLOB]: string;
  data: string;
}

function isWireBlob(value: unknown): value is WireBlob {
  return (
    typeof value === "object" &&
    value !== null &&
    BLOB in (value as Record<string, unknown>) &&
    typeof (value as Record<string, unknown>).data === "string"
  );
}

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  // `String.fromCharCode(...view)` blows the argument limit on a page-sized image.
  const chunk = 0x8000;
  for (let offset = 0; offset < view.length; offset += chunk) {
    binary += String.fromCharCode(...view.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function unbase64(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

/** A row as JSON, with every `Blob` replaced by its bytes. */
async function toWire(value: unknown): Promise<unknown> {
  if (value instanceof Blob) {
    return { [BLOB]: value.type, data: base64(await value.arrayBuffer()) } satisfies WireBlob;
  }
  if (value instanceof ArrayBuffer) {
    return { [BLOB]: "", data: base64(value) } satisfies WireBlob;
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => toWire(item)));
  if (value !== null && typeof value === "object") {
    const entries = await Promise.all(
      Object.entries(value as Record<string, unknown>).map(async ([key, item]) => [key, await toWire(item)] as const),
    );
    return Object.fromEntries(entries);
  }
  return value;
}

/** The same row back, with every tagged binary rebuilt as a `Blob`. */
function fromWire(value: unknown): unknown {
  if (isWireBlob(value)) return new Blob([unbase64(value.data)], { type: value[BLOB] });
  if (Array.isArray(value)) return value.map((item) => fromWire(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, fromWire(item)]));
  }
  return value;
}

export class SqliteDatabase implements Database {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly db: SqlDatabase;

  private constructor(db: SqlDatabase) {
    this.db = db;
  }

  static async open(name = LOCAL_DATABASE_FILE, connect: SqlConnector = connectPlugin): Promise<SqliteDatabase> {
    const db = await connect(name);
    await db.execute(CREATE);
    await ensureOwnerColumn(db);
    return new SqliteDatabase(db);
  }

  /** One write at a time: the plugin's pool has no ordering of its own. */
  private write<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    const rows = await this.db.select<Array<{ doc: string }>>(
      "SELECT doc FROM records WHERE store = $1 AND key = $2",
      [store, key],
    );
    if (rows.length === 0) return undefined;
    return fromWire(JSON.parse(rows[0].doc)) as T;
  }

  put(store: StoreName, value: Record<string, unknown>): Promise<void> {
    return this.write(async () => {
      const key = value[keyPathOf(store)];
      if (typeof key !== "string" || key === "") {
        // The browser engine throws `DataError: key path did not yield a value` here; a row that
        // cannot be keyed must not become a row nobody can find.
        throw new Error(`a ${store} row has no ${keyPathOf(store)} to key it by`);
      }
      const doc = JSON.stringify(await toWire(value));
      // The owner is written from the row being written, in the same statement as the document,
      // so an updated row cannot keep a stale one.
      const ownerField = ownerPathOf(store);
      const owner = ownerField === undefined ? null : value[ownerField];
      await this.db.execute(
        `INSERT INTO records (store, key, doc, ${OWNER_INDEX}) VALUES ($1, $2, $3, $4)
         ON CONFLICT(store, key) DO UPDATE SET doc = excluded.doc, ${OWNER_INDEX} = excluded.${OWNER_INDEX}`,
        [store, key, doc, typeof owner === "string" ? owner : null],
      );
    });
  }

  async all<T>(store: StoreName): Promise<T[]> {
    const rows = await this.db.select<Array<{ doc: string }>>("SELECT doc FROM records WHERE store = $1", [store]);
    return rows.map((row) => fromWire(JSON.parse(row.doc)) as T);
  }

  /**
   * The rows whose key starts with `prefix`.
   *
   * `substr(key, 1, length($2)) = $2` rather than `LIKE $2 || '%'`: a chapter id may contain `%` or
   * `_`, which `LIKE` would treat as wildcards and quietly match another chapter's pages.
   */
  async prefix<T>(store: StoreName, prefix: string): Promise<T[]> {
    const rows = await this.db.select<Array<{ doc: string }>>(
      "SELECT doc FROM records WHERE store = $1 AND substr(key, 1, length($2)) = $2",
      [store, prefix],
    );
    return rows.map((row) => fromWire(JSON.parse(row.doc)) as T);
  }

  /** One series' chapters, from the indexed column: a lookup, not a pass over the library. */
  async byOwner<T>(store: StoreName, owner: string): Promise<T[]> {
    if (ownerPathOf(store) === undefined) throw new Error(`${store} rows have no owner to read by`);
    const rows = await this.db.select<Array<{ doc: string }>>(
      `SELECT doc FROM records WHERE store = $1 AND ${OWNER_INDEX} = $2`,
      [store, owner],
    );
    return rows.map((row) => fromWire(JSON.parse(row.doc)) as T);
  }

  remove(store: StoreName, key: string): Promise<void> {
    return this.write(async () => {
      await this.db.execute("DELETE FROM records WHERE store = $1 AND key = $2", [store, key]);
    });
  }
}

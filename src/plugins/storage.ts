/**
 * A plugin's own storage: its keys, its quota, and nothing else's.
 *
 * Isolated twice. Keys are namespaced by plugin id in a way a plugin cannot express (the namespace
 * separator is a NUL, and a key containing one is refused), and the *values* are JSON the host
 * serialises — a plugin cannot hand over a function, a DOM node or an ArrayBuffer to be stored.
 *
 * A quota exists because the alternative is one plugin filling the device: the app's own database is
 * shared with the library, the cache and the reader, and a plugin that grows without limit takes the
 * space a download needed. 256 KB per plugin is enough for settings and small caches, and small
 * enough that hitting it is a plugin bug rather than a device problem.
 */
import type { Database } from "../lib/db/open";

export const PLUGIN_STORAGE_STORE = "pluginStorage" as const;

/** Per plugin, summed over its keys, as JSON. */
export const PLUGIN_STORAGE_LIMIT_BYTES = 256 * 1024;

/** One key's name. Short, printable, and free of the namespace separator. */
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

/** The row key. NUL cannot appear in a plugin-supplied key, so the namespace cannot be forged. */
function rowKey(pluginId: string, key: string): string {
  return `${pluginId}\u0000${key}`;
}

export class PluginStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginStorageError";
  }
}

export interface PluginStorageRow {
  readonly key: string;
  readonly pluginId: string;
  readonly name: string;
  readonly value: string;
  readonly bytes: number;
}

/** One plugin's key/value space, over the app's database. */
export class PluginStorage {
  private readonly db: Database;
  private readonly pluginId: string;

  constructor(db: Database, pluginId: string) {
    this.db = db;
    this.pluginId = pluginId;
  }

  async get(key: string): Promise<unknown> {
    this.checkKey(key);
    const row = await this.db.get<PluginStorageRow>(PLUGIN_STORAGE_STORE, rowKey(this.pluginId, key));
    if (row === undefined) return undefined;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    this.checkKey(key);
    let encoded: string;
    try {
      encoded = JSON.stringify(value ?? null);
    } catch {
      throw new PluginStorageError("That value cannot be stored — it is not plain data.");
    }
    if (typeof encoded !== "string") {
      // `JSON.stringify` answers `undefined` for a function or a symbol rather than throwing, which
      // would otherwise be stored as nothing and read back as nothing — a silent data loss.
      throw new PluginStorageError("That value cannot be stored — it is not plain data.");
    }

    const bytes = encoded.length;
    if (bytes > PLUGIN_STORAGE_LIMIT_BYTES) {
      throw new PluginStorageError(`One value may be ${Math.round(PLUGIN_STORAGE_LIMIT_BYTES / 1024)} KB.`);
    }
    const used = await this.usedBytes();
    const existing = await this.db.get<PluginStorageRow>(PLUGIN_STORAGE_STORE, rowKey(this.pluginId, key));
    const after = used - (existing?.bytes ?? 0) + bytes;
    if (after > PLUGIN_STORAGE_LIMIT_BYTES) {
      throw new PluginStorageError(
        `This plugin has used its ${Math.round(PLUGIN_STORAGE_LIMIT_BYTES / 1024)} KB of settings space.`,
      );
    }
    await this.db.put(PLUGIN_STORAGE_STORE, {
      key: rowKey(this.pluginId, key),
      pluginId: this.pluginId,
      name: key,
      value: encoded,
      bytes,
    });
  }

  async delete(key: string): Promise<void> {
    this.checkKey(key);
    await this.db.remove(PLUGIN_STORAGE_STORE, rowKey(this.pluginId, key));
  }

  /** Everything this plugin has stored, as parsed values. For its own panel, not for the app. */
  async entries(): Promise<Record<string, unknown>> {
    const rows = await this.rows();
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        out[row.name] = JSON.parse(row.value) as unknown;
      } catch {
        /* a corrupt row is dropped, not handed over */
      }
    }
    return out;
  }

  /** Bytes this plugin has used. The panel shows it next to the quota. */
  async usedBytes(): Promise<number> {
    return (await this.rows()).reduce((total, row) => total + row.bytes, 0);
  }

  /** Removes everything this plugin stored. Called on uninstall — a reinstall starts clean. */
  async clear(): Promise<void> {
    for (const row of await this.rows()) {
      await this.db.remove(PLUGIN_STORAGE_STORE, row.key);
    }
  }

  private async rows(): Promise<PluginStorageRow[]> {
    const all = await this.db.all<PluginStorageRow>(PLUGIN_STORAGE_STORE);
    return all.filter((row) => row.pluginId === this.pluginId);
  }

  private checkKey(key: string): void {
    if (!KEY_PATTERN.test(key)) {
      throw new PluginStorageError(
        "A storage key is 1–120 characters of letters, digits, dot, dash or underscore.",
      );
    }
  }
}

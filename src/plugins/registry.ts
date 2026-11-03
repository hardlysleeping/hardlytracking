/**
 * The installed set: what this device has, what it may do, and which version it is running.
 *
 * A record is the whole truth about one plugin on one device. It carries the granted permissions
 * rather than re-reading them from the manifest, because a grant is the *user's* decision and a new
 * package that asks for more must not inherit it.
 *
 * The package bytes live beside their record, keyed `<id>@<version>`, so a rollback is a pointer
 * change rather than a download — and so an update that crashes can put back exactly the bytes that
 * worked. Only two versions are kept: the running one and its last known good one. A plugin and its
 * previous version are not an archive.
 */
import type { Database } from "../lib/db/open";
import type { Permission, PluginManifest } from "./manifest";

/** The store names. Added to `STORES` in `lib/db/open.ts`; the DB version went up with them. */
export const PLUGIN_STORE = "plugins" as const;
export const PLUGIN_PACKAGE_STORE = "pluginPackages" as const;

/** Three consecutive failed starts and the plugin is switched off, with its last good version back. */
export const START_FAILURE_LIMIT = 3;

export interface InstalledPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly sha256: string;
  readonly enabled: boolean;
  readonly grantedPermissions: readonly Permission[];
  readonly installedAt: number;
  readonly manifest: PluginManifest;
  /** The version that ran cleanly before the current one, when there is one. */
  readonly lastKnownGoodVersion?: string;
  /** Starts that failed in a row since the last good one. Reset by a successful handshake. */
  readonly failures: number;
}

export interface StoredPackage {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

/** A row, as it is written. Arrays are copied: a rune proxy in a field is a `DataCloneError`. */
function rowOf(plugin: InstalledPlugin): Record<string, unknown> {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    sha256: plugin.sha256,
    enabled: plugin.enabled,
    grantedPermissions: [...plugin.grantedPermissions],
    installedAt: plugin.installedAt,
    manifest: plugin.manifest,
    failures: plugin.failures,
    ...(plugin.lastKnownGoodVersion === undefined
      ? {}
      : { lastKnownGoodVersion: plugin.lastKnownGoodVersion }),
  };
}

function packageKey(id: string, version: string): string {
  return `${id}@${version}`;
}

/** The registry, over the app's own database. */
export class PluginRegistry {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async all(): Promise<InstalledPlugin[]> {
    const rows = await this.db.all<Record<string, unknown>>(PLUGIN_STORE);
    return rows
      .map((row) => row as unknown as InstalledPlugin)
      .sort((one, two) => one.name.localeCompare(two.name));
  }

  async get(id: string): Promise<InstalledPlugin | null> {
    const row = await this.db.get<Record<string, unknown>>(PLUGIN_STORE, id);
    return row === undefined ? null : (row as unknown as InstalledPlugin);
  }

  /** The plugins that should be running: enabled, and with a package to run. */
  async enabled(): Promise<InstalledPlugin[]> {
    return (await this.all()).filter((plugin) => plugin.enabled);
  }

  async put(plugin: InstalledPlugin): Promise<void> {
    await this.db.put(PLUGIN_STORE, rowOf(plugin));
  }

  /**
   * Writes a package and its record, keeping the version being replaced.
   *
   * The new package is stored *before* the record points at it, so a crash between the two leaves
   * an orphan package (harmless, cleaned on the next install) rather than a record naming bytes that
   * are not there.
   */
  async install(plugin: InstalledPlugin, bytes: Uint8Array): Promise<void> {
    await this.db.put(PLUGIN_PACKAGE_STORE, {
      id: packageKey(plugin.id, plugin.version),
      pluginId: plugin.id,
      version: plugin.version,
      sha256: plugin.sha256,
      bytes,
    });
    await this.put({ ...plugin, failures: 0 });
    await this.prune(plugin);
  }

  /** The bytes for a version, or null when they were cleared away. */
  async package(id: string, version: string): Promise<StoredPackage | null> {
    const row = await this.db.get<Record<string, unknown>>(
      PLUGIN_PACKAGE_STORE,
      packageKey(id, version),
    );
    if (row === undefined) return null;
    const stored = row as unknown as StoredPackage & { pluginId?: string };
    return stored;
  }

  /** Everything but the running version and its last good one, so a plugin costs two packages. */
  private async prune(plugin: InstalledPlugin): Promise<void> {
    const keep = new Set([packageKey(plugin.id, plugin.version)]);
    if (plugin.lastKnownGoodVersion !== undefined) {
      keep.add(packageKey(plugin.id, plugin.lastKnownGoodVersion));
    }
    const rows = await this.db.all<Record<string, unknown>>(PLUGIN_PACKAGE_STORE);
    for (const row of rows) {
      const key = String(row.id ?? "");
      if (!key.startsWith(`${plugin.id}@`)) continue;
      if (keep.has(key)) continue;
      await this.db.remove(PLUGIN_PACKAGE_STORE, key);
    }
  }

  /** Off, without losing the grant or the bytes: the user may switch it back on. */
  async disable(id: string): Promise<void> {
    const plugin = await this.get(id);
    if (plugin === null) return;
    await this.put({ ...plugin, enabled: false });
  }

  async enable(id: string, granted?: readonly Permission[]): Promise<void> {
    const plugin = await this.get(id);
    if (plugin === null) return;
    await this.put({
      ...plugin,
      enabled: true,
      ...(granted === undefined ? {} : { grantedPermissions: [...granted] }),
      failures: 0,
    });
  }

  /** Removes the record and every package for that id. Storage is cleared by the caller. */
  async uninstall(id: string): Promise<void> {
    const rows = await this.db.all<Record<string, unknown>>(PLUGIN_PACKAGE_STORE);
    for (const row of rows) {
      const key = String(row.id ?? "");
      if (key.startsWith(`${id}@`)) await this.db.remove(PLUGIN_PACKAGE_STORE, key);
    }
    await this.db.remove(PLUGIN_STORE, id);
  }

  /**
   * A start that did not reach its handshake.
   *
   * Returns what the caller should do: `disabled` once the limit is reached, and whether a rollback
   * happened. The last good version is what a crash costs — not the whole plugin.
   */
  async recordFailure(
    id: string,
  ): Promise<{ failures: number; disabled: boolean; rolledBackTo: string | null }> {
    const plugin = await this.get(id);
    if (plugin === null) return { failures: 0, disabled: false, rolledBackTo: null };
    const failures = plugin.failures + 1;
    const previous = plugin.lastKnownGoodVersion;
    const rollback =
      failures >= START_FAILURE_LIMIT && previous !== undefined && previous !== plugin.version;
    const next: InstalledPlugin = {
      ...plugin,
      failures,
      ...(rollback ? { version: previous } : {}),
      enabled: failures < START_FAILURE_LIMIT,
    };
    await this.put(next);
    return { failures, disabled: failures >= START_FAILURE_LIMIT, rolledBackTo: rollback ? previous : null };
  }

  /** A start that reached its handshake: the running version becomes the one to come back to. */
  async recordSuccess(id: string): Promise<void> {
    const plugin = await this.get(id);
    if (plugin === null) return;
    if (plugin.failures === 0 && plugin.lastKnownGoodVersion === plugin.version) return;
    await this.put({ ...plugin, failures: 0, lastKnownGoodVersion: plugin.version });
  }
}

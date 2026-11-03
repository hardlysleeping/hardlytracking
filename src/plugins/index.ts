/**
 * The plugin system's front door.
 *
 * A caller should not have to know whether something is a store name, a validator or a frame: it
 * asks the manager. The manager owns the running hosts, starts the enabled set, refreshes those hosts
 * to another version, and makes sure a plugin that is switched off leaves nothing behind in memory.
 *
 * Nothing here runs at import time. A build with no plugins installed constructs this once and never
 * starts a frame, which is what keeps the feature free for people who do not use it.
 */
import type { Database } from "../lib/db/open";
import type { LibraryProfile } from "../api/profile";
import { PluginHost, type HostHooks, type RegisteredAction } from "./host";
import { PluginRegistry, type InstalledPlugin } from "./registry";
import { PluginStorage } from "./storage";
import { installPackage, type InstallOutcome, type InstallRequest } from "./installer";

export { PLUGIN_API_VERSION, MANIFEST_VERSION, PERMISSIONS, PERMISSION_LABELS, PLATFORM_SUPPORT, newPermissions, readManifest } from "./manifest";
export type { Permission, PluginManifest, ManifestProblem, Contribution } from "./manifest";
export { PACKAGE_LIMITS, readPackage, entryOf, sha256, writePackage } from "./validate";
export { PluginRegistry, START_FAILURE_LIMIT, PLUGIN_STORE, PLUGIN_PACKAGE_STORE } from "./registry";
export type { InstalledPlugin, StoredPackage } from "./registry";
export { PluginStorage, PLUGIN_STORAGE_STORE, PLUGIN_STORAGE_LIMIT_BYTES, PluginStorageError } from "./storage";
export { PluginHost } from "./host";
export { METHODS, EVENTS, MAX_MESSAGE_BYTES, RPC_TIMEOUT_MS, newChannel, readEnvelope, pluginDocument } from "./bridge";
export type { RegisteredAction, SeriesSummary, LibraryQuery } from "./host";
export { installPackage };
export type { InstallOutcome, InstallRequest, InstallDecision } from "./installer";

/** One host per running plugin, for as long as it runs. */
export class PluginManager {
  private readonly db: Database;
  private readonly profile: () => LibraryProfile | null;
  private readonly appVersion: string;
  private readonly mount: HTMLElement | null;
  private readonly hooks: HostHooks;
  private readonly hosts = new Map<string, PluginHost>();
  private readonly listeners = new Set<() => void>();
  readonly registry: PluginRegistry;

  constructor(options: {
    database: Database;
    profile: () => LibraryProfile | null;
    appVersion: string;
    mount?: HTMLElement | null;
    hooks?: HostHooks;
  }) {
    this.db = options.database;
    this.profile = options.profile;
    this.appVersion = options.appVersion;
    this.mount = options.mount ?? null;
    this.hooks = options.hooks ?? {};
    this.registry = new PluginRegistry(options.database);
  }

  /** Installed plugins, sorted. The manager's list is the registry's list. */
  async installed(): Promise<InstalledPlugin[]> {
    return this.registry.all();
  }

  /** Every action the running plugins have registered, for the menus. */
  actions(): RegisteredAction[] {
    return [...this.hosts.values()].flatMap((host) => [...host.contributions]);
  }

  /** Re-renders whoever is showing plugins. Cheap, so the UI subscribes instead of polling. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** Installs or updates a package. The frame for the old version is stopped first. */
  async install(request: InstallRequest): Promise<InstallOutcome> {
    const outcome = await installPackage(this.db, request);
    if (!outcome.ok) return outcome;
    await this.stop(outcome.plugin.id);
    if (outcome.plugin.enabled) await this.start(outcome.plugin.id);
    this.changed();
    return outcome;
  }

  /**
   * Starts one plugin.
   *
   * A failed start is recorded, and the third in a row switches the plugin off with its last good
   * version back — the plugin does not get to crash the app's boot every launch.
   */
  async start(id: string): Promise<{ ok: boolean; problem?: string }> {
    const plugin = await this.registry.get(id);
    if (plugin === null || !plugin.enabled) return { ok: false, problem: "This plugin is switched off." };
    if (this.hosts.has(id)) return { ok: true };

    const host = new PluginHost({
      plugin,
      appVersion: this.appVersion,
      profile: this.profile,
      registry: this.registry,
      hooks: this.hooks,
      mount: this.mount,
    });
    const started = await host.start();
    if (!started.ok) {
      const failure = await this.registry.recordFailure(id);
      this.changed();
      return { ok: false, problem: started.problem, ...(failure.rolledBackTo === null ? {} : { rolledBackTo: failure.rolledBackTo }) };
    }
    await this.registry.recordSuccess(id);
    this.hosts.set(id, host);
    this.changed();
    return { ok: true };
  }

  /** Stops one plugin, leaving its record and storage in place. */
  async stop(id: string): Promise<void> {
    const host = this.hosts.get(id);
    if (host === undefined) return;
    host.dispose();
    this.hosts.delete(id);
    this.changed();
  }

  /** Starts everything enabled. Called once, when the library is open. */
  async startEnabled(): Promise<void> {
    for (const plugin of await this.registry.enabled()) await this.start(plugin.id);
  }

  async enable(id: string): Promise<void> {
    await this.registry.enable(id);
    await this.start(id);
  }

  async disable(id: string): Promise<void> {
    await this.stop(id);
    await this.registry.disable(id);
    this.changed();
  }

  /** Removes the plugin, its packages and its own storage. Nothing of it is left on the device. */
  async uninstall(id: string): Promise<void> {
    await this.stop(id);
    const storage = new PluginStorage(this.db, id);
    await storage.clear();
    await this.registry.uninstall(id);
    this.changed();
  }

  /** Pushes one library event to every running plugin that asked for events. */
  notify(event: "library.opened" | "library.added" | "library.removed", params: unknown): void {
    for (const host of this.hosts.values()) host.notify(event, params);
  }

  /** Runs one action on the plugin that registered it. */
  invoke(pluginId: string, actionId: string): void {
    this.hosts.get(pluginId)?.invoke(actionId);
  }

  /** Stops every frame. Called when the library closes or the shell is torn down. */
  disposeAll(): void {
    for (const host of this.hosts.values()) host.dispose();
    this.hosts.clear();
    this.changed();
  }
}

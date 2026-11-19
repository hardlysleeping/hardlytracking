/**
 * The plugin manager, as the app holds it.
 *
 * One instance for the run, created when the library opens (it needs the database and the profile)
 * and attached to no view in particular: the manager screen reads it, a series menu reads its
 * actions, and nothing else knows it exists.
 *
 * Two rules that keep the feature quiet for people who do not use it:
 *
 * - **Nothing starts until there is something enabled.** No frame, no timer, no work.
 * - **A failure is a line, not a crash.** A package that will not start is switched off by the
 *   registry after three attempts; the screen says so in one sentence and the app carries on.
 */
import { PluginManager, type InstallOutcome, type Permission } from "../plugins/index";
import type { RegisteredAction } from "../plugins/host";
import type { LibraryProfile } from "../api/profile";
import { appVersion, platform } from "../lib/app-info";

/** Shown while a package is being unpacked, validated and stored. */
export interface ApprovalRequest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly fresh: readonly Permission[];
  readonly requested: readonly Permission[];
  readonly resolve: (approved: boolean) => void;
}

class PluginState {
  manager = $state<PluginManager | null>(null);
  list = $state<Awaited<ReturnType<PluginManager["installed"]>>>([]);
  actions = $state<RegisteredAction[]>([]);
  /** The permissions a package is asking for right now, if any. The view renders this. */
  approval = $state<ApprovalRequest | null>(null);
  busy = $state(false);
  notice = $state("");
  error = $state("");

  /** Called once the library is open. Reads the installed set and starts what is enabled. */
  attach(profile: LibraryProfile): void {
    if (this.manager !== null) return;
    this.manager = new PluginManager({
      database: profile.store.database,
      profile: () => profile,
      appVersion: appVersion(),
      mount: typeof document === "undefined" ? null : document.body,
      hooks: {
        toast: (message) => {
          this.notice = message;
        },
        confirm: (message) => Promise.resolve(globalThis.confirm?.(message) ?? false),
        openPanel: (panelId, pluginId) => {
          this.notice = `${pluginId} opened ${panelId}`;
        },
        onAction: () => {
          this.actions = this.manager?.actions() ?? [];
        },
        onRefusal: (id, problem) => {
          // Diagnostics, not chrome: a refused message is the plugin's mistake to debug.
          console.warn(`[plugin ${id}] refused: ${problem}`);
        },
      },
    });
    void this.reload().then(() => this.startEnabled());
  }

  async reload(): Promise<void> {
    if (this.manager === null) return;
    this.list = await this.manager.installed();
    this.actions = this.manager.actions();
  }

  /** Starts every enabled plugin. Called by `attach` through `reload`, once. */
  async startEnabled(): Promise<void> {
    if (this.manager === null) return;
    this.list = await this.manager.installed();
    if (this.list.some((plugin) => plugin.enabled)) await this.manager.startEnabled();
    this.actions = this.manager.actions();
  }

  /**
   * Installs a package the user picked.
   *
   * The approval question is asked *by this method* through `approval`, which the screen renders —
   * not with `window.confirm`, so the prompt can list what each permission means.
   */
  async install(bytes: Uint8Array): Promise<InstallOutcome | null> {
    if (this.#refuseWhenClosed()) return null;
    const manager = this.manager;
    if (manager === null) return null;
    this.busy = true;
    this.error = "";
    this.notice = "";
    try {
      const outcome = await manager.install({
        bytes,
        appVersion: appVersion(),
        platform: platform(),
        decide: (context) =>
          new Promise((resolve) => {
            this.approval = {
              id: context.id,
              name: context.name,
              version: context.version,
              fresh: context.fresh,
              requested: context.requested,
              resolve: (approved) => {
                this.approval = null;
                resolve(approved ? { approve: context.fresh } : null);
              },
            };
          }),
      });
      if (!outcome.ok) this.error = outcome.problem;
      else this.notice = outcome.updated ? `${outcome.plugin.name} updated to ${outcome.plugin.version}.` : `${outcome.plugin.name} installed.`;
      await this.reload();
      return outcome;
    } finally {
      this.busy = false;
    }
  }

  /**
   * A manager that does not exist is not a silent success.
   *
   * These four actions are reachable before the library has opened (the manager is attached then),
   * and `manager?.enable(id)` answered "nothing happened" while the screen showed a switch that
   * moved. One sentence says why, and the screen can show it.
   */
  #refuseWhenClosed(): boolean {
    if (this.manager !== null) return false;
    this.error = "Plugins need an open library. Open your library and try again.";
    return true;
  }

  async enable(id: string): Promise<void> {
    if (this.#refuseWhenClosed()) return;
    await this.manager?.enable(id);
    await this.reload();
  }

  async disable(id: string): Promise<void> {
    if (this.#refuseWhenClosed()) return;
    await this.manager?.disable(id);
    await this.reload();
  }

  async uninstall(id: string): Promise<void> {
    if (this.#refuseWhenClosed()) return;
    await this.manager?.uninstall(id);
    await this.reload();
  }

  /** Runs one plugin action from a menu. */
  invoke(pluginId: string, actionId: string): void {
    if (this.#refuseWhenClosed()) return;
    this.manager?.invoke(pluginId, actionId);
  }

  /** The actions a given menu should show. */
  actionsFor(kind: RegisteredAction["kind"]): RegisteredAction[] {
    return this.actions.filter((action) => action.kind === kind);
  }

  dispose(): void {
    this.manager?.disposeAll();
    this.manager = null;
    this.list = [];
    this.actions = [];
  }
}

export const plugins = new PluginState();

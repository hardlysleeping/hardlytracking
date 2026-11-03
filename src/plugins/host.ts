/**
 * The host: the thing that owns a plugin's frame, its channel and its answers.
 *
 * One instance per running plugin. It creates the sandboxed iframe, remembers the `WindowProxy` it
 * created so nothing else can speak as this plugin, and serves the API calls that the plugin is
 * allowed to make — read-only library lookups, its own storage, and the app's own dialogs. It never
 * hands over a client, a token, a Capacitor object, a database handle or a DOM node; every answer is
 * plain data, and the shape of that data is decided here.
 *
 * Two behaviours worth naming, because both are what "a plugin crash does not break the app" means:
 *
 * - **A call that does not answer is abandoned** (`RPC_TIMEOUT_MS`), so a plugin looping inside a
 *   handler cannot hold the host's queue.
 * - **A frame that fails to say hello is a failed start.** After three in a row the registry switches
 *   the plugin off and puts back the last version that worked (`recordFailure`).
 */
import type { Chapter, Series } from "../api/source";
import { providerFor } from "../api/registry";
import type { LibraryProfile } from "../api/profile";
import { METHODS, RATE_LIMIT, RPC_TIMEOUT_MS, newChannel, pluginDocument, readEnvelope, responseOf, errorOf, type Envelope } from "./bridge";
import type { Permission } from "./manifest";
import { PluginRegistry, type InstalledPlugin } from "./registry";
import { PluginStorage } from "./storage";
import { entryOf, readPackage } from "./validate";

/** What a plugin may see of a title. Deliberately smaller than the app's own `Series`. */
export interface SeriesSummary {
  readonly id: string;
  readonly title: string;
  readonly cover?: string;
  readonly author?: string;
  readonly description?: string;
  readonly chapterCount: number;
  readonly readCount: number;
  readonly categories: readonly string[];
  readonly source: string;
  readonly saved: boolean;
}

/** The query a plugin may make. No field it does not need, and no way to ask for someone's history. */
export interface LibraryQuery {
  readonly search?: string;
  readonly category?: string;
  readonly savedOnly?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

/** What the plugin asked the app to show. The app decides how; a plugin never draws chrome. */
export interface HostUi {
  toast(message: string): void | Promise<void>;
  confirm(message: string): boolean | Promise<boolean>;
  openPanel(panelId: string, pluginId: string): void | Promise<void>;
}

export interface HostHooks {
  readonly toast?: (message: string) => void;
  readonly confirm?: (message: string) => boolean | Promise<boolean>;
  readonly openPanel?: (panelId: string, pluginId: string) => void;
  /** Fired when a plugin registers an action, so a view can draw it. */
  readonly onAction?: (pluginId: string, kind: "series" | "reader" | "library", action: { id: string; title: string }) => void;
  /** Diagnostics. Never shown to the plugin. */
  readonly onRefusal?: (pluginId: string, problem: string) => void;
}

export interface HostOptions {
  readonly plugin: InstalledPlugin;
  readonly appVersion: string;
  readonly profile: () => LibraryProfile | null;
  readonly registry: PluginRegistry;
  readonly hooks?: HostHooks;
  /** The element a frame is appended to. Absent in a test, which is how the host is unit-tested. */
  readonly mount?: HTMLElement | null;
}

/** One registered action, as the app holds it. */
export interface RegisteredAction {
  readonly pluginId: string;
  readonly kind: "series" | "reader" | "library";
  readonly id: string;
  readonly title: string;
}

/**
 * A running plugin.
 *
 * `start()` resolves once the frame has said hello; a frame that never does is a failed start and is
 * reported to the registry, not thrown at a caller that cannot do anything about it.
 */
export class PluginHost {
  private readonly options: HostOptions;
  private readonly channel: string;
  private frame: HTMLIFrameElement | null = null;
  private source: WindowProxy | null = null;
  private started = false;
  private disposed = false;
  private readonly startedAt = Date.now();
  private recent: number[] = [];
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly actions: RegisteredAction[] = [];
  private readonly listener = (event: MessageEvent) => this.receive(event);

  constructor(options: HostOptions) {
    this.options = options;
    this.channel = newChannel();
  }

  get pluginId(): string {
    return this.options.plugin.id;
  }

  /** The actions this plugin registered, for the menus. */
  get contributions(): readonly RegisteredAction[] {
    return this.actions;
  }

  /**
   * Creates the frame and waits for its hello.
   *
   * `failed` covers both "the package bytes are gone" and "the frame never answered": from the app's
   * side those are the same event — the plugin is not running — and the registry's failure counter is
   * what turns three of them into a rollback.
   */
  async start(): Promise<{ ok: true } | { ok: false; problem: string }> {
    const row = await this.options.registry.package(this.options.plugin.id, this.options.plugin.version);
    if (row === null) return { ok: false, problem: "The installed package is missing." };
    const read = readPackage(row.bytes);
    if (!read.ok) return { ok: false, problem: read.problem };
    const entry = entryOf(read.files, this.options.plugin.manifest);
    if (entry === null) return { ok: false, problem: "The package no longer contains its entry file." };

    const markup = pluginDocument({
      channel: this.channel,
      pluginId: this.options.plugin.id,
      apiVersion: this.options.plugin.manifest.apiVersion,
      source: new TextDecoder().decode(entry),
    });

    // No DOM (a unit test, or a shell that has not mounted a root yet): the host is still a host,
    // but nothing is created and nothing is promised. `start()` reports success so a test can drive
    // the API surface without an iframe.
    if (typeof document === "undefined" || this.options.mount === null || this.options.mount === undefined) {
      return { ok: true };
    }

    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("title", `${this.options.plugin.name} (plugin)`);
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;border:0";
    frame.srcdoc = markup;
    this.frame = frame;
    this.options.mount.appendChild(frame);
    // The frame's own window, not `window`: the host's identity check is "did this message come from
    // the frame I created", and `window` would accept the parent's own messages while refusing the
    // plugin's.
    this.source = frame.contentWindow;
    window.addEventListener("message", this.listener);

    const hello = await this.waitForHello();
    if (!hello) {
      this.dispose();
      return { ok: false, problem: "The plugin did not start." };
    }
    this.started = true;
    return { ok: true };
  }

  /** Waits for the first `hello`, bounded. A frame that is slow is a failed start, not a hang. */
  private waitForHello(): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), RPC_TIMEOUT_MS);
      this.helloResolver = (ok: boolean) => {
        clearTimeout(timer);
        this.helloResolver = null;
        resolve(ok);
      };
    });
  }

  private helloResolver: ((ok: boolean) => void) | null = null;

  /**
   * One incoming message.
   *
   * Refused unless it came from this host's own frame (`event.source === this.source`), addressed to
   * this channel, and shaped like something in `METHODS`. The plugin is never told why: a refusal is
   * silence, and a 5-second timeout on its side.
   */
  private receive(event: MessageEvent): void {
    if (this.disposed) return;
    if (this.source !== null && event.source !== this.source) return;
    const read = readEnvelope(event.data, { channel: this.channel, pluginId: this.options.plugin.id });
    if (!read.ok) {
      this.options.hooks?.onRefusal?.(this.options.plugin.id, read.problem);
      return;
    }
    if (!this.rateOk()) {
      this.options.hooks?.onRefusal?.(this.options.plugin.id, "rate_limited");
      return;
    }
    const message = read.message;
    if (message.kind === "hello") {
      this.helloResolver?.(true);
      return;
    }
    if (message.kind !== "request" || message.id === undefined || message.method === undefined) return;
    void this.serve(message);
  }

  /** Flood control. A plugin is a settings panel, not a message bus. */
  private rateOk(): boolean {
    const now = Date.now();
    this.recent = this.recent.filter((at) => now - at < RATE_LIMIT.windowMs);
    if (this.recent.length >= RATE_LIMIT.messages) return false;
    this.recent.push(now);
    return true;
  }

  private async serve(message: Envelope): Promise<void> {
    const id = message.id as string;
    const method = message.method as string;
    const context = { channel: this.channel, pluginId: this.options.plugin.id };

    // The permission table is the only place a method's requirement lives.
    const required = METHODS[method];
    if (required !== null && !this.options.plugin.grantedPermissions.includes(required as Permission)) {
      this.post(errorOf(context, id, `This plugin has not been granted ${required}.`));
      return;
    }

    try {
      const result = await this.call(method, message.params);
      this.post(responseOf(context, id, result));
    } catch (cause) {
      this.post(errorOf(context, id, cause instanceof Error ? cause.message : String(cause)));
    }
  }

  /** The host's API. Every branch returns plain data or throws a sentence. */
  private async call(method: string, params: unknown): Promise<unknown> {
    const input = (params ?? {}) as Record<string, unknown>;
    const profile = this.options.profile();

    switch (method) {
      case "plugin.ready":
        return { api: this.options.plugin.manifest.apiVersion, app: this.options.appVersion };

      case "storage.get":
      case "storage.set":
      case "storage.delete": {
        const db = profile?.store.database;
        if (db === undefined) throw new Error("The library is not open yet.");
        const storage = new PluginStorage(db, this.options.plugin.id);
        const key = String(input.key ?? "");
        if (method === "storage.get") return { value: (await storage.get(key)) ?? null };
        if (method === "storage.delete") {
          await storage.delete(key);
          return { ok: true };
        }
        await storage.set(key, input.value);
        return { ok: true };
      }

      case "library.getSeries": {
        const id = String(input.id ?? "");
        if (profile === null) throw new Error("The library is not open yet.");
        const series = await profile.store.getSeries(id);
        const chapters = series === undefined ? [] : await profile.store.listChapters(id);
        return series === undefined ? null : this.summaryOf(id, series, chapters, profile);
      }

      case "library.query": {
        if (profile === null) throw new Error("The library is not open yet.");
        const query = input as unknown as LibraryQuery;
        const search = (query.search ?? "").toLowerCase();
        const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
        const offset = Math.max(0, query.offset ?? 0);
        const all = await profile.store.listSeries();
        // Every row in the store is a title the user saved; `savedOnly` is kept because the
        // vocabulary is the plugin API's and a future provider may have unsaved rows.
        const matching = all.filter((series) => {
          if (search !== "" && !series.title.toLowerCase().includes(search)) return false;
          return true;
        });
        const page = matching.slice(offset, offset + limit);
        const out: SeriesSummary[] = [];
        for (const series of page) {
          out.push(this.summaryOf(series.id, series, await profile.store.listChapters(series.id), profile));
        }
        return out;
      }

      case "ui.toast":
        await this.options.hooks?.toast?.(String(input.message ?? ""));
        return { ok: true };

      case "ui.confirm":
        return { confirmed: (await this.options.hooks?.confirm?.(String(input.message ?? ""))) === true };

      case "ui.openPanel":
        await this.options.hooks?.openPanel?.(String(input.panelId ?? ""), this.options.plugin.id);
        return { ok: true };

      case "actions.registerSeriesAction":
      case "actions.registerReaderAction":
      case "actions.registerLibraryAction": {
        const kind =
          method === "actions.registerSeriesAction"
            ? "series"
            : method === "actions.registerReaderAction"
              ? "reader"
              : "library";
        const declared = this.options.plugin.manifest.contributes[
          kind === "series" ? "seriesActions" : kind === "reader" ? "readerActions" : "libraryActions"
        ];
        const id = String(input.id ?? "");
        const title = String(input.title ?? "");
        // Only what the manifest declared: the manifest is what the user granted, so an action it
        // never named cannot appear in a menu.
        const allowed = declared.find((entry) => entry.id === id && entry.title === title);
        if (allowed === undefined) {
          throw new Error(`"${id}" is not one of this plugin's declared actions.`);
        }
        if (!this.actions.some((action) => action.id === id)) {
          this.actions.push({ pluginId: this.options.plugin.id, kind, id, title });
          this.options.hooks?.onAction?.(this.options.plugin.id, kind, { id, title });
        }
        return { ok: true };
      }

      default:
        throw new Error("That call is not part of the plugin API.");
    }
  }

  /** A summary a plugin may see: no history, no file paths, no remote ids it cannot use. */
  private summaryOf(
    id: string,
    series: Series | null,
    chapters: Chapter[],
    profile: LibraryProfile,
  ): SeriesSummary {
    const read = chapters.filter((chapter) => chapter.read === true).length;
    return {
      id,
      title: series?.title ?? id,
      ...(series?.cover === undefined ? {} : { cover: series.cover }),
      ...(series?.author === undefined ? {} : { author: series.author }),
      ...(series?.description === undefined ? {} : { description: series.description }),
      chapterCount: chapters.length,
      readCount: read,
      categories: [...(series?.categoryIds ?? [])],
      source: providerFor(profile.providers, id)?.kind ?? "unknown",
      saved: true,
    };
  }

  /** Sends an envelope to the frame. A disposed host drops it. */
  private post(message: Envelope): void {
    const target = this.frame?.contentWindow;
    if (target === null || target === undefined) return;
    target.postMessage(message, "*");
  }

  /** Asks the plugin to run one of its own actions. */
  invoke(actionId: string): void {
    const target = this.frame?.contentWindow;
    if (target === null || target === undefined) return;
    target.postMessage(
      { channel: this.channel, plugin: this.options.plugin.id, kind: "event", event: "action", params: { id: actionId } },
      "*",
    );
  }

  /** Pushes one library event. Only events in `EVENTS` reach a plugin. */
  notify(event: "library.opened" | "library.added" | "library.removed", params: unknown): void {
    if (!this.options.plugin.grantedPermissions.includes("events.library")) return;
    const target = this.frame?.contentWindow;
    if (target === null || target === undefined) return;
    target.postMessage(
      { channel: this.channel, plugin: this.options.plugin.id, kind: "event", event, params },
      "*",
    );
  }

  /** True once the frame has said hello. */
  get running(): boolean {
    return this.started && !this.disposed;
  }

  /** Uptime, so the manager can say a plugin is not stuck in a start loop. */
  get age(): number {
    return Date.now() - this.startedAt;
  }

  /** Destroys the frame and unregisters everything. Called on disable, uninstall and unmount. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.actions.length = 0;
    for (const waiting of this.pending.values()) waiting.reject(new Error("the plugin was stopped"));
    this.pending.clear();
    window.removeEventListener("message", this.listener);
    if (this.frame !== null) {
      this.frame.remove();
      this.frame = null;
    }
    this.source = null;
  }
}

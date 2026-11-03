/**
 * What the app knows right now: the open profile, the sources, the library.
 *
 * One state object, so the views never hold their own copy of the library and two
 * views cannot disagree about whether a series is saved.
 */
import { openLibraryProfile, progressWriter, type LibraryProfile } from "../api/profile";
import { providerFor, type DalvikHost } from "../api/registry";
import { packageIdFromApkName, type InstalledExtension } from "../api/dalvik";
import { installOnHtServer, setHtServerExtensionEnabled, uninstallOnHtServer } from "../api/htserver";
import { downloadApk, loadRepository, type Repository } from "../lib/extensions/repository";
import { remoteHost } from "../lib/host";
import type { ExtensionEntry } from "../lib/extensions/index";
import type { RepoRow, ViewStateRow } from "../lib/db/store";
import { BACKGROUND_GRACE_MS, viewStateKey } from "../lib/history";
import { nextUnread, seriesOfPosition } from "../lib/library/continue";
import { settings } from "./settings.svelte";
import { installTrackerSync } from "../lib/trackers/sync";
import { planReadState, remoteReadCount } from "../lib/read-state";
import { providerLabel } from "../api/source";
import type { RemoteRead, SourceProvider } from "../api/source";
import { sourceKeyOfMapping } from "../lib/marks";
import { applyMigration, type AppliedMigration } from "../lib/migrate-apply";
import {
  describeMigration,
  mappingFromId,
  planMigration,
  type MigrationFacts,
  type MigrationPlan,
  type MigrationTarget,
  type SummaryRow,
} from "../lib/migrate";
import { startNativeRuntime, shellFetch } from "../lib/mihon-runtime";
import { openDatabase, memoryDatabase, type Database } from "../lib/db/open";
import { detectPlatform } from "../lib/webview/index";
import { plugins } from "./plugins.svelte";
import { watchOpenedFiles } from "../lib/files/opened";
import { imageCache } from "../lib/cache/images";
import type { Chapter, Page, Series, Source } from "../api/source";

/**
 * What a migration would do, or why it will not.
 *
 * `rows` is the confirm panel, built from the same plan the write uses — the panel cannot promise a
 * number the migration does not deliver.
 */
export type MigrationPreview =
  | { ok: true; plan: MigrationPlan; rows: SummaryRow[]; pages: Map<string, number> }
  | { ok: false; message: string };

/** What a migration did. A refusal is the same shape as a failure: nothing moved. */
export type MigrationOutcome = ({ ok: true } & AppliedMigration) | { ok: false; message: string };

/** One row of the Updates list: a chapter, and the title it belongs to. */
export interface UpdateRow {
  seriesId: string;
  title: string;
  cover?: string;
  chapter: Chapter;
}

/**
 * How long a boot step may take before the app stops waiting for it.
 *
 * Every one of these is a database or in-process call on a device, so minutes are not a plausible
 * duration for any of them — and a step that never answers is what "Opening the library…" forever
 * looked like on an iPhone. A timeout is reported with the step's own name, so the sentence on the
 * boot screen says which pump was dry rather than "something failed".
 */
const BOOT_STEP_DEADLINE_MS = 20_000;
/** The whole open, not one step. Said as a sentence; nothing is cancelled by it. */
const BOOT_OVERALL_DEADLINE_MS = 60_000;

/** The steps are named the way a person reads them, because that name is shown. */
/**
 * The step the boot is in right now.
 *
 * "Opening the library…" is a sentence that cannot be diagnosed: it is the same words whether the
 * database is busy, the extension host is wedged, or nothing was ever called. Printing the step by
 * name, with the build and the seconds spent, is what makes one screenshot enough to say where it
 * stopped — and it costs a phone user nothing to ignore.
 */
let runningStep = $state<string | null>(null);
let bootStartedAt = $state(0);

export const bootReport = {
  /** The step now running, or null between steps and after the open settles. */
  get step(): string | null {
    return runningStep;
  },
  /** When `open()` began, so a screen can count from there rather than from its own mount. */
  get startedAt(): number {
    return bootStartedAt;
  },
};

async function bootStep<T>(label: string, work: () => Promise<T>, ms = BOOT_STEP_DEADLINE_MS): Promise<T> {
  runningStep = label;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not answer in ${Math.round(ms / 1000)} s.`)), ms);
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (runningStep === label) runningStep = null;
  }
}

/** Said when the library never opened, in the words of the thing that is actually missing. */
const NOT_OPEN_MESSAGE =
  "The library has not finished opening, so nothing can be saved yet. If this message stays, the boot screen names the step that is stuck.";

class LibraryState {
  /**
   * The open profile, as an opaque handle: replaced wholesale, never mutated through this field.
   *
   * `$state.raw` and not `$state`: a deep proxy would hand views a *copy* of the arrays inside — the
   * host's extension list among them — and a push through the proxy would not reach the array the
   * provider reads. The lists a view draws are the `$state` fields below.
   */
  profile = $state.raw<LibraryProfile | null>(null);
  ready = $state(false);
  /** Set when the user clears the reading log, so a screen showing it can react. */
  historyClearedAt = $state(0);
  /** A provider that did not answer. A warning, not a failure: the library is still ours. */
  error = $state<string | null>(null);
  /** The library itself could not be opened. This one is fatal, and the shell says so. */
  openError = $state<string | null>(null);
  sources = $state<Source[]>([]);
  library = $state<Series[]>([]);
  /** The APKs installed on the extension host, newest install last. */
  extensions = $state<InstalledExtension[]>([]);
  /**
   * The paired HT-Server, when one answered. Its own provider, its own id space.
   *
   * `null` is the ordinary standalone case: this device runs everything itself. A PC in the list is
   * not this device's extension — nothing here is ever handed to this device's runtime.
   */
  htServer = $state.raw<DalvikHost | null>(null);
  /** What the PC has installed, as its own registry last answered. Managed from here, owned there. */
  hostExtensions = $state<InstalledExtension[]>([]);
  /**
   * True when the device's storage refused to open and the library is running in memory.
   *
   * A separate flag from `error` because it is a state the user has to be told about on every screen
   * — "nothing you do now is being kept" — while `error` is also used for messages that belong to one
   * screen (a dead extension host, a source that did not answer).
   */
  storageFallback = $state(false);
  /** Stops listening for files the system hands over (iOS only). */
  stopOpenedFiles: (() => void) | null = null;
  /** Repositories the user added, oldest first. */
  repos = $state<RepoRow[]>([]);
  /** Indexes read this session, by repository URL — one fetch per repository per run. */
  private indexes = new Map<string, ExtensionEntry[]>();

  /** The open in flight, so a second call joins it instead of starting a second boot. */
  private opening: Promise<void> | null = null;

  open(): Promise<void> {
    if (this.profile !== null) return Promise.resolve();
    if (this.opening !== null) return this.opening;
    this.opening = this.runOpen().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  /**
   * Start this device's extension host and fold it into an already-open library.
   *
   * Every failure here is a sentence, not a boot screen: the library is open either way. A host that
   * never answers costs the extensions and their sources this session, which is exactly what the
   * message says.
   */
  private async attachHost(ownHost: boolean): Promise<void> {
    if (!ownHost) return;
    const base = await startNativeRuntime();
    const profile = this.profile;
    if (profile === null) return;
    if (base === null) {
      this.error =
        "The on-device extension host did not start. Extensions and their sources are unavailable this session; your library still opens.";
      return;
    }
    const warning = await profile.attachDalvik(base);
    if (warning !== null) this.error = warning;
    // The provider list grew, so the chips and the extension rows have to be read again.
    await this.loadSources();
    this.extensions = await profile.listExtensions();
  }

  /**
   * Try again from the boot screen.
   *
   * A wedged start used to be terminal for the session: the only cure was killing the app, which on a
   * sideloaded IPA means re-installing it. Clearing the state and running the same path again is the
   * whole retry — the extension host is asked again, and the database is asked again.
   */
  async retry(): Promise<void> {
    if (this.opening !== null) return;
    this.profile = null;
    this.ready = false;
    this.openError = null;
    this.storageFallback = false;
    this.error = null;
    await this.open();
  }

  private async runOpen(): Promise<void> {
    if (this.profile !== null) return;
    bootStartedAt = Date.now();
    /**
     * An overall ceiling, above the per-step ones.
     *
     * Each step has its own deadline, but a step that never starts — an `await` before the first
     * `bootStep` that the native bridge never answers — has nobody watching it. This one only
     * speaks: it names how long it has been and which step was running, and leaves the work alone.
     */
    const watchdog = setTimeout(() => {
      if (this.ready) return;
      const step = runningStep;
      this.openError =
        `The library did not finish opening in ${Math.round(BOOT_OVERALL_DEADLINE_MS / 1000)} s` +
        `${step === null ? "" : ` — it was stuck at “${step}”`}.`;
    }, BOOT_OVERALL_DEADLINE_MS);
    try {
      /**
       * The library opens from its own database, and the extension host joins afterwards.
       *
       * It used to be the other way round: this process started the host, waited for it, and only then
       * opened the database and built the providers — so a phone whose embedded JVM was slow, wedged
       * or never registered held every saved title, every file and the whole reading history behind
       * "Opening the library…". The host is one *source*; the library is not its property.
       *
       * A shell with a host of its own (iPhone, desktop) therefore opens with `dalvikBase: null` and
       * attaches the host in the background, once it answers. A browser build keeps its own fast
       * `/api/dalvik` proxy in the open path: it is local and answers immediately.
       */
      const shell = detectPlatform();
      const ownHost = shell === "capacitor" || shell === "tauri";
      // The desktop shell needs Rust's HTTP client for loopback (CORS), and that same client is what
      // makes a repository index reachable with no `/api/repo` proxy in the app.
      const fetchImpl = await shellFetch();
      const options = {
        localFirst: ownHost,
        ...(ownHost ? { dalvikBase: null, mihonBase: null } : {}),
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
      };

      /**
       * The library opens even when the device's own storage does not.
       *
       * A phone whose webview refuses IndexedDB (or blocks its upgrade behind another connection)
       * used to sit on "Opening the library…" for the whole session, because the database was
       * treated as a precondition rather than as one thing that can fail. Storage failing must cost
       * *saving*, not the app: an in-memory library opens, browses, reads and searches, and says
       * plainly that nothing will be kept. Silence was the bug; a working screen with a sentence is
       * the fix.
       */
      let database: Database;
      try {
        database = await bootStep("Opening the library database", () => openDatabase());
      } catch (cause) {
        const reason = message(cause);
        database = memoryDatabase();
        this.storageFallback = true;
        this.error = `This device's library storage did not open (${reason}), so nothing can be saved this session — your library, reading and browsing all still work. Reload to try again.`;
      }
      // Provider failures must never replace a successfully opened persistent database with memory.
      this.profile = await bootStep("Preparing the library", () => openLibraryProfile({ ...options, database }));
      this.library = await bootStep("Reading the saved titles", () => this.profile!.store.listSeries());
      this.extensions = await bootStep("Listing extensions", () => this.profile!.listExtensions());
      this.htServer = this.profile.htServer;
      this.hostExtensions = [...(this.profile.htServer?.extensions ?? [])];
      this.repos = await bootStep("Listing repositories", () => this.profile!.store.listRepos());
      this.ready = true;
      // Started, not awaited: the screen is usable from here on, and the host's arrival only adds
      // sources to it. On a phone the JVM may take a minute or never come up; neither is the library's
      // business any more.
      void this.attachHost(ownHost).catch((error) => { this.error = message(error); });
      if (ownHost) {
        const profile = this.profile;
        void profile.refreshHtServer().then(async (warning) => {
          if (this.profile !== profile) return;
          this.htServer = profile.htServer;
          this.hostExtensions = [...(profile.htServer?.extensions ?? [])];
          if (warning !== null) this.error = warning;
          await this.loadSources();
        }).catch((error) => { this.error = message(error); });
      }
      // Covers and page images live in the same database, behind the user's ceiling.
      imageCache.attach(this.profile.store.database);
      void imageCache.prune();
      void this.pruneSessions();
      // Arm the tracker hook: a read mark becomes a queued push once a service is connected
      // (T26–T28). With no adapter registered this is inert, and the day one lands nothing else
      // has to be rewired.
      installTrackerSync(this.profile.store);
      // A comic the system handed over (Files, iCloud Drive, a share sheet). Inert off iOS, and it
      // is installed after the library is open so an import has somewhere to land.
      void watchOpenedFiles(this.profile.store, async (result) => {
        if (result.added > 0) await this.refreshLibrary();
      }).then((stop) => {
        this.stopOpenedFiles = stop ?? null;
      });
      void this.loadSources();
      // Plugins come last: they read the library through the profile, so nothing of theirs runs
      // before there is a library to read. A build with none installed starts no frame at all.
      plugins.attach(this.profile);
    } catch (error) {
      this.openError = message(error);
    } finally {
      clearTimeout(watchdog);
      runningStep = null;
    }
  }

  /**
   * Install an APK the user picked, then let its sources appear.
   *
   * Reading the file is the whole "repo index" step: the host never fetches anything, so the
   * bytes have to come from somewhere the user chose. `installApk` keeps the row; reloading
   * sources is what turns it into chips on this page.
   */
  /**
   * Remember a title we saw, so History and Continue can name it later.
   *
   * Called wherever a series object exists anyway (its own page, a source list, search results) —
   * never as an extra network call just to fill a label.
   */
  async rememberSeriesMeta(series: Pick<Series, "id" | "title" | "cover">): Promise<void> {
    const store = this.profile?.store;
    if (store === undefined) return;
    await store.putKnownSeries({ id: series.id, title: series.title, ...(series.cover === undefined ? {} : { cover: series.cover }), at: Date.now() });
  }

  /**
   * A title and cover for an id, from the cheapest place that has one.
   *
   * library row → a title seen before → the provider itself. The last step is a network call, so it
   * is only made when the first two miss, and the answer is kept.
   */
  async resolveSeriesMeta(seriesId: string): Promise<{ title: string; cover?: string } | null> {
    const store = this.profile?.store;
    if (store === undefined) return null;
    const saved = this.library.find((row) => row.id === seriesId);
    if (saved !== undefined) return { title: saved.title, ...(saved.cover === undefined ? {} : { cover: saved.cover }) };
    const known = await store.getKnownSeries(seriesId);
    if (known !== undefined) return { title: known.title, ...(known.cover === undefined ? {} : { cover: known.cover }) };
    try {
      const provider = providerFor(this.profile!.providers, seriesId);
      const series = await provider.details(seriesId);
      await this.rememberSeriesMeta(series);
      return { title: series.title, ...(series.cover === undefined ? {} : { cover: series.cover }) };
    } catch {
      return null;
    }
  }

  /** Turn an installed extension on or off; its sources appear or disappear with it. */
  async setExtensionEnabled(extensionId: string, enabled: boolean): Promise<void> {
    if (this.profile === null) return;
    await this.profile.setExtensionEnabled(extensionId, enabled);
    this.extensions = await this.profile.listExtensions();
    await this.loadSources();
  }

  /** Uninstall: the row goes, and its sources with it. */
  async uninstallExtension(extensionId: string): Promise<void> {
    if (this.profile === null) return;
    await this.profile.uninstallExtension(extensionId);
    this.extensions = await this.profile.listExtensions();
    await this.loadSources();
  }

  // ---- the HT-Server's own extensions ---------------------------------------
  //
  // A paired PC is a source, and its extensions are managed from here: what is installed on it, what
  // to add to it, and what to switch off. The list is the PC's registry, so every call below goes to
  // the PC — this device's own list is never touched, which is the whole point of the two kinds.
  //
  // **Every change re-probes the host** instead of patching the array in place. The provider reads the
  // array it was built with, and that array is not something a view can be trusted to have kept in
  // step: re-reading the PC's own list is one GET, it is what the card's Reload does, and it means the
  // PC's screen and the phone's agree even when the change was made on the PC.

  /** Re-probe the paired host: its runtime, its list, and the sources this device offers from it. */
  /**
   * Rebuild the Komga provider from the saved address and login, and say so when it did not answer.
   *
   * The sources list is reloaded too: Browse groups by source, and a provider swapped underneath it
   * would otherwise keep drawing the old server's sources.
   */
  async refreshKomga(): Promise<void> {
    if (this.profile === null) return;
    this.error = await this.profile.refreshKomga();
    await this.loadSources();
  }

  /** Re-ask the WebDAV card's folder after its address or login changes. */
  async refreshWebdav(): Promise<void> {
    if (this.profile === null) return;
    this.error = await this.profile.refreshWebdav();
    await this.loadSources();
  }

  async refreshHost(): Promise<void> {
    if (this.profile === null) return;
    this.error = await this.profile.refreshHtServer();
    this.htServer = this.profile.htServer;
    this.hostExtensions = [...(this.profile.htServer?.extensions ?? [])];
    await this.loadSources();
  }

  /** Install a repository entry on the PC. The bytes travel once; the PC keeps them from then on. */
  async installOnHost(entry: ExtensionEntry, repoUrl: string): Promise<InstalledExtension> {
    if (this.htServer === null) throw new Error("no HT-Server is paired");
    const apk = await downloadApk(entry);
    const row = await installOnHtServer(remoteHost(), apk, entry.pkg, {
      name: entry.name,
      ...(entry.iconUrl === undefined ? {} : { iconUrl: entry.iconUrl }),
      repoUrl,
      versionName: entry.version,
      ...(entry.versionCode === undefined ? {} : { versionCode: entry.versionCode }),
    });
    await this.refreshHost();
    return row;
  }

  /** Turn one of the PC's extensions on or off. Its row stays; its sources stop being offered. */
  async setHostExtensionEnabled(extensionId: string, enabled: boolean): Promise<void> {
    if (this.htServer === null) return;
    await setHtServerExtensionEnabled(remoteHost(), extensionId, enabled);
    await this.refreshHost();
  }

  /** Uninstall one of the PC's extensions, from this phone. */
  async uninstallHostExtension(extensionId: string): Promise<void> {
    if (this.htServer === null) return;
    await uninstallOnHtServer(remoteHost(), extensionId);
    await this.refreshHost();
  }

  /** The library-less refusal, said once so every write path reads the same. */
  private get notOpenMessage(): string {
    return this.openError === null ? NOT_OPEN_MESSAGE : `${NOT_OPEN_MESSAGE} (${this.openError})`;
  }

  async installApk(file: File): Promise<InstalledExtension> {
    if (this.profile === null) throw new Error(this.notOpenMessage);
    const apk = new Uint8Array(await file.arrayBuffer());
    const installed = await this.profile.installApk(apk, packageIdFromApkName(file.name));
    this.extensions = await this.profile.listExtensions();
    await this.loadSources();
    return installed;
  }

  /**
   * Add a repository by URL and read its index.
   *
   * The index is read here rather than on the browse screen so a bad URL fails at the moment
   * it is added — with both candidate URLs in the message — instead of leaving a repository
   * row that never works.
   */
  /**
   * Store a repository.
   *
   * `preloaded` is the index the screen already read to show its confirmation panel — passing it
   * back means the user's one tap does not download the same index a second time. Callers that add
   * without a panel (none, today) leave it out and the index is fetched here.
   */
  async addRepository(url: string, preloaded?: Repository): Promise<Repository> {
    if (this.profile === null) throw new Error(this.notOpenMessage);
    const repository = preloaded ?? (await loadRepository(url));
    const row: RepoRow = { url: repository.url, indexUrl: repository.indexUrl, name: repository.name, at: Date.now() };
    await this.profile.store.putRepo(row);
    this.repos = await this.profile.store.listRepos();
    this.indexes.set(repository.url, repository.extensions);
    return repository;
  }

  async removeRepository(url: string): Promise<void> {
    if (this.profile === null) return;
    await this.profile.store.removeRepo(url);
    this.indexes.delete(url);
    this.repos = await this.profile.store.listRepos();
  }

  /** The entries of a repository, read once and kept for the session. */
  async repoEntries(url: string): Promise<ExtensionEntry[]> {
    const cached = this.indexes.get(url);
    if (cached !== undefined) return cached;
    const repository = await loadRepository(url);
    this.indexes.set(repository.url, repository.extensions);
    return repository.extensions;
  }

  /**
   * Install one entry from a repository: the index gave the APK URL, the host turns the bytes
   * into an installed extension, and the row keeps the version so an update is a comparison
   * rather than a guess.
   */
  async installEntry(entry: ExtensionEntry, repoUrl: string): Promise<InstalledExtension> {
    if (this.profile === null) throw new Error(this.notOpenMessage);
    const apk = await downloadApk(entry);
    const installed = await this.profile.installApk(apk, entry.pkg, {
      name: entry.name,
      iconUrl: entry.iconUrl,
      repoUrl,
      versionName: entry.version,
      versionCode: entry.versionCode,
    });
    this.extensions = await this.profile.listExtensions();
    await this.loadSources();
    return installed;
  }

  /** A runtime that is down is a banner, never an empty source list. */
  async loadSources(): Promise<void> {
    if (this.profile === null) return;
    const found: Source[] = [];
    for (const provider of this.profile.providers) {
      try {
        found.push(...(await provider.sources()));
      } catch (error) {
        this.error = `${provider.kind}: ${message(error)}`;
      }
    }
    this.sources = found;
  }

  async refreshLibrary(): Promise<void> {
    if (this.profile === null) return;
    this.library = await this.profile.store.listSeries();
  }

  async isSaved(seriesId: string): Promise<boolean> {
    if (this.profile === null) return false;
    return (await this.profile.store.getSeries(seriesId)) !== undefined;
  }

  async save(series: Series, chapters: Chapter[] = []): Promise<void> {
    if (this.profile === null) return;
    await this.profile.store.addSeries(series);
    // Mirror what we already fetched, so the series page opens instantly next time.
    if (chapters.length > 0) await this.profile.store.putChapters(series.id, chapters);
    await this.recordMapping(series.id);
    await this.refreshLibrary();
  }

  async unsave(seriesId: string): Promise<void> {
    if (this.profile === null) return;
    await this.profile.store.removeSeries(seriesId);
    await this.refreshLibrary();
  }

  /** The source's own page for a series: what a pasted link is turned into before it is queued. */
  async details(seriesId: string): Promise<Series> {
    if (this.profile === null) throw new Error("no library is open");
    const target = await this.remoteOf(seriesId);
    const series = await target.provider.details(target.seriesId);
    // A migrated title answers with the target's metadata under *our* id: the entry keeps its
    // identity, so a link, a category or a position that names this series still names it.
    return target.seriesId === seriesId ? series : { ...series, id: seriesId };
  }

  /**
   * Where this entry actually lives now.
   *
   * Normally that is the series id itself. After a migration it is the target source's series,
   * recorded on the mapping row — and every read of the title (details, chapters, the server's own
   * read state) goes through here, so nothing else has to know a migration happened.
   */
  async remoteOf(seriesId: string): Promise<{ seriesId: string; provider: SourceProvider }> {
    if (this.profile === null) throw new Error("no library is open");
    const providers = this.profile.providers;
    const mapping = await this.profile.store.getMapping(seriesId);
    const remote = mapping?.remoteSeriesId;
    if (remote !== undefined && remote !== "" && remote !== seriesId) {
      try {
        return { seriesId: remote, provider: providerFor(providers, remote) };
      } catch {
        // The target's provider is gone (its extension was uninstalled). The title falls back to
        // its own id, which is where it came from — a warning, not a title that cannot be opened.
      }
    }
    return { seriesId, provider: providerFor(providers, seriesId) };
  }

  /** One page of a source's search, for a link that names a site rather than a series. */
  async searchSource(sourceId: string, query: string): Promise<Series[]> {
    if (this.profile === null) return [];
    const result = await providerFor(this.profile.providers, sourceId).search(sourceId, query, 1);
    return result.items;
  }

  async chapters(seriesId: string): Promise<Chapter[]> {
    if (this.profile === null) return [];
    const target = await this.remoteOf(seriesId);
    const chapters = await target.provider.chapters(target.seriesId);
    // Mirror the server's list locally: the series page opens instantly next time. The rows are
    // stored under *our* id, so a migrated title's chapters are its chapters whichever source
    // answered — that is what keeps unread counts, Continue and Updates on one entry.
    if (target.provider.ownsProgress || (await this.isSaved(seriesId))) {
      await this.profile.store.putChapters(seriesId, chapters);
    }
    // The server keeps its own read state, so the list just fetched is also the answer to "what is
    // read" — reconciled here, on the response already in hand, rather than by a sweep later.
    await this.pullReadState(seriesId, target.provider, chapters, target.seriesId).catch(() => undefined);
    return chapters;
  }

  /**
   * Take the server's read state into ours.
   *
   * Quiet on purpose (`setRead(..., { push: false })`): a chapter read in the server's own web UI
   * is not a read that just happened on this device, and announcing it would push it back through
   * the tracker queue on every open. Returns what changed, so a caller can say so.
   *
   * `remoteId` is the series id the provider answers to when it is not ours (a migrated title); the
   * history row it writes is still keyed by the library entry, so History keeps one title.
   */
  async pullReadState(
    seriesId: string,
    provider: SourceProvider,
    chapters: Chapter[],
    remoteId: string = seriesId,
  ): Promise<{ read: number; pages: number; remoteRead: number }> {
    if (this.profile === null || provider.readState === undefined) return { read: 0, pages: 0, remoteRead: 0 };
    const remote: RemoteRead[] = await provider.readState(remoteId);
    if (remote.length === 0) return { read: 0, pages: 0, remoteRead: 0 };

    const store = this.profile.store;
    const known = new Set(chapters.map((chapter) => chapter.id));
    const localRead = new Set<string>();
    const localPage = new Map<string, number>();
    for (const chapter of chapters) {
      if (await store.isRead(chapter.id)) localRead.add(chapter.id);
      const progress = await store.getProgress(chapter.id);
      if (progress !== undefined && progress.page > 0) localPage.set(chapter.id, progress.page);
    }

    const plan = planReadState(remote, { read: localRead, page: localPage }, known);

    for (const row of plan.markRead) {
      await store.setRead(row.chapterId, true, { push: false });
      // The server's own timestamp, so History says when it was read rather than when we noticed.
      if (row.at !== undefined && !settings.historyPaused) {
        await store.recordHistory(seriesId, row.chapterId, row.at);
      }
    }

    for (const row of plan.movePage) {
      const chapter = chapters.find((candidate) => candidate.id === row.chapterId);
      if (chapter === undefined) continue;
      const total = chapter.pageCount > 0 ? chapter.pageCount : row.page;
      await store.setProgress(row.chapterId, row.page, total);
      await store.setPosition(seriesId, row.chapterId, row.page);
    }

    return { read: plan.markRead.length, pages: plan.movePage.length, remoteRead: remoteReadCount(remote) };
  }

  async pages(chapterId: string): Promise<Page[]> {
    if (this.profile === null) return [];
    const provider = providerFor(this.profile.providers, chapterId);
    const pages = await provider.pages(chapterId);
    await this.profile.store.putPages(chapterId, pages);
    return pages;
  }

  /**
   * One call for "I am here".
   *
   * Position, history and progress are three questions about the same moment, so they are
   * written together: a reader that remembered the page but not the chapter would offer
   * "continue" at the wrong place, and one that remembered neither would offer nothing.
   */
  async remember(seriesId: string, chapterId: string, page: number, total: number): Promise<void> {
    if (this.profile === null) return;
    const store = this.profile.store;
    // Progress and position are bookmarks, not a log: they are written even when the user has
    // turned history off, because Continue Reading is not surveillance.
    await store.setProgress(chapterId, page, total);
    await store.setPosition(seriesId, chapterId, page);
    if (settings.historyPaused) return;
    await store.recordHistory(seriesId, chapterId);
  }

  // ---- reading sessions -----------------------------------------------------
  //
  // A session is opened when a chapter opens and closed when the reader goes away. It is what
  // Stats and History are built from, and the only place "how long" is answerable. When the user
  // has turned history off, no session is written at all.

  /**
   * Open a session for a chapter.
   *
   * A return to the same chapter within the background grace continues the session that is still
   * open rather than writing a second row — that is what stops a glance at another app becoming
   * its own "reading session" in History.
   */
  async beginSession(seriesId: string, chapterId: string, page: number): Promise<string | null> {
    if (this.profile === null || settings.historyPaused) return null;
    const store = this.profile.store;
    try {
      const last = await store.lastSessionFor(chapterId);
      if (last !== undefined && last.endedAt === undefined && Date.now() - last.startedAt < BACKGROUND_GRACE_MS) {
        return last.id;
      }
      const mapping = await store.getMapping(seriesId);
      return await store.beginSession({ seriesId, sourceId: mapping?.sourceId, chapterId, startPage: page });
    } catch {
      return null; // a session is a nicety; never let it break opening a chapter
    }
  }

  async endSession(id: string | null, endPage: number, completed = false): Promise<void> {
    if (id === null || this.profile === null) return;
    try {
      await this.profile.store.endSession(id, { endPage, completed });
    } catch {
      /* ignore */
    }
  }

  /**
   * Apply the retention preference. Runs at launch and when the setting changes — no background
   * service, because the app is the only thing that ever needs to be right about this.
   */
  async pruneSessions(): Promise<void> {
    const store = this.profile?.store;
    if (store === undefined) return;
    try {
      await store.pruneSessions(settings.historyRetentionDays);
    } catch {
      /* retention is housekeeping */
    }
  }

  /** What one collection looked like when it was left. */
  async viewState(collectionId: string | null): Promise<ViewStateRow | undefined> {
    return this.profile?.store.getViewState(viewStateKey(collectionId));
  }

  async saveViewState(collectionId: string | null, state: Omit<ViewStateRow, "key" | "collectionId" | "at">): Promise<void> {
    const store = this.profile?.store;
    if (store === undefined) return;
    await store.setViewState({ ...state, collectionId: viewStateKey(collectionId) });
  }

  /**
   * Forget the reading log, keep every bookmark. An optional range clears only older activity.
   *
   * This is deliberately *not* "reset progress": progress, positions and read marks survive, so a
   * cleared history never changes where a chapter resumes or what is marked read.
   */
  async clearHistory(range: { since?: number; until?: number } = {}): Promise<{ sessions: number; history: number }> {
    const store = this.profile?.store;
    if (store === undefined) return { sessions: 0, history: 0 };
    const removed = await store.clearHistory(range);
    this.historyClearedAt = Date.now();
    return removed;
  }

  /** The library's continue strip: newest positions, with the titles we already know. */
  async continueReading(limit = 5): Promise<Array<{ seriesId: string; title: string; cover?: string; chapterId: string; page: number; chapterName: string }>> {
    if (this.profile === null) return [];
    const [positions, series, known] = await Promise.all([
      this.profile.store.listPositions(),
      this.profile.store.listSeries(),
      this.profile.store.listKnownSeries(),
    ]);
    const titles = new Map(series.map((row) => [row.id, row.title]));
    const covers = new Map<string, string | undefined>(series.map((row) => [row.id, row.cover]));
    for (const row of known) {
      if (!titles.has(row.id)) titles.set(row.id, row.title);
      if (covers.get(row.id) === undefined && row.cover !== undefined) covers.set(row.id, row.cover);
    }
    const chapterRows = new Map((await this.profile.store.listAllChapters()).map((chapter) => [chapter.id, chapter]));
    // Positions arrive newest first, and Continue is one card per title. Two rows can resolve to
    // the same series when a bad link wrote a second position under the wrong id — and a duplicate
    // is not cosmetic here: the strip is keyed by series id, so it failed to render at all
    // (`each_key_duplicate`) and took the whole Library screen with it.
    const seen = new Set<string>();
    const rows: Array<{ seriesId: string; title: string; cover?: string; chapterId: string; page: number; chapterName: string }> = [];
    for (const row of positions) {
      // The stored id is the series the reader was opened under; the chapter mirror says which
      // series the chapter actually belongs to, and it wins when they disagree (see
      // `seriesOfPosition`). Otherwise one stale link leaves a resume row pointing at a series that
      // was never in the library: an unnamed title, a back link to nowhere, no prev/next.
      const seriesId = seriesOfPosition(row.seriesId, chapterRows.get(row.chapterId));
      if (seen.has(seriesId)) continue;
      seen.add(seriesId);
      rows.push({
        seriesId,
        chapterId: row.chapterId,
        page: row.page,
        // A title we have seen beats an id; an id is never shown as a title.
        title: titles.get(seriesId) ?? "Unknown title",
        ...(covers.get(seriesId) === undefined ? {} : { cover: covers.get(seriesId) }),
        chapterName: chapterRows.get(row.chapterId)?.name ?? "",
      });
      if (rows.length === limit) break;
    }
    return rows;
  }

  /**
   * Point a series at its next unread chapter after one is finished (§7).
   *
   * The position row is ours, so this is a local write — nothing goes to the runtime. When there
   * is no next unread chapter it does nothing at all: the finished chapter stays the bookmark,
   * which is honest, and a wrap to chapter 1 would lose the reader's place.
   */
  async advance(seriesId: string, chapterId: string): Promise<void> {
    const store = this.profile?.store;
    if (store === undefined) return;
    const next = nextUnread(await store.listChapters(seriesId), chapterId);
    if (next === null) return;
    await store.setPosition(seriesId, next.id, 0);
  }

  /**
   * Remember where a series came from, at the moment it is added.
   *
   * The id already carries the provider and, for a Mihon host, the source id and the
   * manga's own url — so the mapping is derived from the id rather than guessed, and a
   * source we cannot name is left out instead of being invented.
   *
   * **An existing mapping is never overwritten here.** A migrated title's mapping names the source
   * it reads from now, which is not what its id spells; re-deriving it on the next save would undo
   * the migration quietly.
   */
  async recordMapping(seriesId: string, packageId?: string): Promise<void> {
    if (this.profile === null) return;
    const derived = mappingFromId(seriesId, packageId);
    if (derived === null) return;
    if ((await this.profile.store.getMapping(seriesId)) !== undefined) return;
    await this.profile.store.putMapping({ seriesId, ...derived, at: Date.now() });
  }

  // ---- migrating a title to another source ---------------------------------
  //
  // The rules are in `lib/migrate.ts`; this is the sequence, and the order of the writes is part of
  // the design. The per-chapter facts (marks, positions, history, downloads) and the chapter list go
  // first and the mapping last, so a write that dies half way leaves the title still reading from the
  // source its mapping names — the mirror rows are refetched on the next open, so nothing is stuck.

  /**
   * What a migration would move, without moving anything.
   *
   * Everything the confirm panel says comes from here, so the panel cannot promise a number the
   * write does not deliver. A refusal is a message, not an exception: the entry stays where it is.
   */
  async previewMigration(seriesId: string, target: MigrationTarget): Promise<MigrationPreview> {
    if (this.profile === null) return { ok: false, message: "No library is open." };
    const store = this.profile.store;
    const saved = await store.getSeries(seriesId);
    if (saved === undefined) return { ok: false, message: "Only a title in your library can be migrated — add it first." };

    let from: Chapter[];
    try {
      from = await this.chapters(seriesId);
    } catch (error) {
      return { ok: false, message: `The source this title is on did not answer: ${message(error)}` };
    }
    let to: Chapter[];
    try {
      to = await providerFor(this.profile.providers, target.seriesId).chapters(target.seriesId);
    } catch (error) {
      return { ok: false, message: `${target.sourceName} did not answer: ${message(error)}` };
    }

    const read = new Set<string>();
    const pages = new Map<string, number>();
    for (const chapter of from) {
      if (await store.isRead(chapter.id)) read.add(chapter.id);
      const progress = await store.getProgress(chapter.id);
      if (progress !== undefined && progress.page > 0) pages.set(chapter.id, progress.page);
    }

    const current = await this.remoteOf(seriesId);
    const result = planMigration({ seriesId, target, currentSeriesId: current.seriesId, from, to, read, pages });
    if (!result.ok) return { ok: false, message: result.message };
    const plan = result.plan;

    const pairs = new Map(plan.pairs.map((pair) => [pair.from.id, pair.to]));
    let downloadsKeep = 0;
    let downloadsDrop = 0;
    for (const row of (await store.listDownloads()).filter((download) => download.seriesId === seriesId)) {
      const counterpart = pairs.get(row.chapterId);
      if (counterpart !== undefined && counterpart.pageCount === row.pages) downloadsKeep += 1;
      else downloadsDrop += 1;
    }

    const mapping = await store.getMapping(seriesId);
    const fromKey = mapping === undefined ? undefined : sourceKeyOfMapping(mapping.provider, mapping.sourceId);
    const fromSource = this.sources.find((source) => source.id === fromKey)?.name ?? providerLabel(saved.provider);

    const facts: MigrationFacts = {
      fromSource,
      toSource: target.sourceName,
      categories: (saved.categoryIds ?? []).length,
      trackers: (await store.listTrackersForSeries(seriesId)).length,
      history: (await store.listHistory(Number.POSITIVE_INFINITY)).filter((row) => row.seriesId === seriesId).length,
      downloadsKeep,
      downloadsDrop,
    };

    return { ok: true, plan, pages, rows: describeMigration(plan, facts, pages) };
  }

  /**
   * Move a library entry to another source, keeping its identity.
   *
   * The entry's id does not change — categories, hidden/pinned marks, tracker links, the position row
   * and every history row keep pointing at it. What changes is which series it reads from, and that
   * is one mapping row; the old home is kept as an alternate so the move can be reversed.
   */
  async migrate(seriesId: string, target: MigrationTarget): Promise<MigrationOutcome> {
    if (this.profile === null) return { ok: false, message: "No library is open." };
    const preview = await this.previewMigration(seriesId, target);
    if (!preview.ok) return preview;

    const packageId = this.extensions.find((extension) => extension.sources.some((source) => source.id === target.sourceId))?.packageId;
    try {
      // The sequence lives in `lib/migrate-apply.ts`: one clock, one order, and a test that can run
      // it against a memory database without a view or a provider.
      const applied = await applyMigration({
        store: this.profile.store,
        plan: preview.plan,
        target,
        ...(packageId === undefined ? {} : { packageId }),
      });
      await this.refreshLibrary();
      return { ok: true, ...applied };
    } catch (error) {
      return { ok: false, message: message(error) };
    }
  }

  /**
   * Ask every saved title for its chapters, and return the newest of them.
   *
   * Updates is not a separate feed the server pushes: it is the library's own chapter lists, read
   * again. Four titles at a time, because a phone asking sixty extensions at once is a stall, and a
   * title that fails is skipped rather than failing the refresh.
   */
  async refreshUpdates(limit = 150): Promise<UpdateRow[]> {
    if (this.profile === null) return [];
    const queue = this.library.slice(0, limit);
    const rows: UpdateRow[] = [];
    const worker = async (): Promise<void> => {
      for (;;) {
        const series = queue.shift();
        if (series === undefined) return;
        try {
          for (const chapter of await this.chapters(series.id)) {
            if (chapter.uploadedAt === undefined) continue;
            rows.push({ seriesId: series.id, title: series.title, cover: series.cover, chapter });
          }
        } catch {
          // One source down is one title missing from the list, not an empty screen.
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return rows.sort((a, b) => (b.chapter.uploadedAt ?? 0) - (a.chapter.uploadedAt ?? 0));
  }

  /** True when this chapter's position is ours to write. */
  ownsProgress(chapterId: string): boolean {
    if (this.profile === null) return false;
    return progressWriter(providerFor(this.profile.providers, chapterId)) === "device";
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const library = new LibraryState();

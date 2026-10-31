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
import { nextUnread } from "../lib/library/continue";
import { settings } from "./settings.svelte";
import { installTrackerSync } from "../lib/trackers/sync";
import { startNativeRuntime, shellFetch } from "../lib/mihon-runtime";
import { imageCache } from "../lib/cache/images";
import type { Chapter, Page, Series, Source } from "../api/source";

/** One row of the Updates list: a chapter, and the title it belongs to. */
export interface UpdateRow {
  seriesId: string;
  title: string;
  cover?: string;
  chapter: Chapter;
}

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
  /** Repositories the user added, oldest first. */
  repos = $state<RepoRow[]>([]);
  /** Indexes read this session, by repository URL — one fetch per repository per run. */
  private indexes = new Map<string, ExtensionEntry[]>();

  async open(): Promise<void> {
    if (this.profile !== null) return;
    try {
      // On the iPhone shell the extension host is inside this process, so it has to be serving
      // before the providers are built. Everywhere else this resolves to `null` without doing any
      // work, and the app's own `/api/dalvik` proxy stays the default host.
      const nativeBase = await startNativeRuntime();
      // The desktop shell needs Rust's HTTP client for loopback (CORS), and that same client is what
      // makes a repository index reachable with no `/api/repo` proxy in the app.
      const fetchImpl = await shellFetch();
      this.profile = await openLibraryProfile({
        ...(nativeBase === null ? {} : { dalvikBase: nativeBase }),
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
      });
      this.library = await this.profile.store.listSeries();
      this.extensions = await this.profile.listExtensions();
      this.htServer = this.profile.htServer;
      this.hostExtensions = [...(this.profile.htServer?.extensions ?? [])];
      this.repos = await this.profile.store.listRepos();
      this.ready = true;
      // Covers and page images live in the same database, behind the user's ceiling.
      imageCache.attach(this.profile.store.database);
      void imageCache.prune();
      void this.pruneSessions();
      // Arm the tracker hook: a read mark becomes a queued push once a service is connected
      // (T26–T28). With no adapter registered this is inert, and the day one lands nothing else
      // has to be rewired.
      installTrackerSync(this.profile.store);
      void this.loadSources();
    } catch (error) {
      this.openError = message(error);
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

  async installApk(file: File): Promise<InstalledExtension> {
    if (this.profile === null) throw new Error("the library is not open yet");
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
  async addRepository(url: string): Promise<Repository> {
    if (this.profile === null) throw new Error("the library is not open yet");
    const repository = await loadRepository(url);
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
    if (this.profile === null) throw new Error("the library is not open yet");
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

  async chapters(seriesId: string): Promise<Chapter[]> {
    if (this.profile === null) return [];
    const provider = providerFor(this.profile.providers, seriesId);
    const chapters = await provider.chapters(seriesId);
    // Mirror the server's list locally: the series page opens instantly next time.
    if (provider.ownsProgress || (await this.isSaved(seriesId))) {
      await this.profile.store.putChapters(seriesId, chapters);
    }
    return chapters;
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
    const chapterNames = new Map((await this.profile.store.listAllChapters()).map((chapter) => [chapter.id, chapter.name]));
    return positions.slice(0, limit).map((row) => ({
      seriesId: row.seriesId,
      chapterId: row.chapterId,
      page: row.page,
      // A title we have seen beats an id; an id is never shown as a title.
      title: titles.get(row.seriesId) ?? "Unknown title",
      ...(covers.get(row.seriesId) === undefined ? {} : { cover: covers.get(row.seriesId) }),
      chapterName: chapterNames.get(row.chapterId) ?? "",
    }));
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
   */
  async recordMapping(seriesId: string, packageId?: string): Promise<void> {
    if (this.profile === null) return;
    const [provider, ...rest] = seriesId.split(":");
    const native = rest.join(":");
    if (provider === undefined || native === "") return;
    // `dalvik:<sourceId>:<url>` — the source id is the first segment after the kind. The HT-Server's
    // rows have the same shape under its own kind, and a row that came from a PC is still a row whose
    // source we want to name.
    const sourceId =
      provider === "dalvik" || provider === "htserver" ? native.split(":")[0] : provider === "mihon" ? "" : native;
    if (sourceId === undefined || sourceId === "") return;
    await this.profile.store.putMapping({
      seriesId,
      provider,
      sourceId,
      ...(packageId === undefined ? {} : { packageId }),
      at: Date.now(),
    });
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

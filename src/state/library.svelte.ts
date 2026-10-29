/**
 * What the app knows right now: the open profile, the sources, the library.
 *
 * One state object, so the views never hold their own copy of the library and two
 * views cannot disagree about whether a series is saved.
 */
import { openLibraryProfile, progressWriter, type LibraryProfile } from "../api/profile";
import { providerFor } from "../api/registry";
import { packageIdFromApkName, type InstalledExtension } from "../api/dalvik";
import { downloadApk, loadRepository, type Repository } from "../lib/extensions/repository";
import type { ExtensionEntry } from "../lib/extensions/index";
import type { RepoRow, ViewStateRow } from "../lib/db/store";
import { BACKGROUND_GRACE_MS, pruneSessions as keepSessions, viewStateKey } from "../lib/history";
import { settings } from "./settings.svelte";
import type { Chapter, Page, Series, Source } from "../api/source";

/** One row of the Updates list: a chapter, and the title it belongs to. */
export interface UpdateRow {
  seriesId: string;
  title: string;
  cover?: string;
  chapter: Chapter;
}

class LibraryState {
  profile = $state<LibraryProfile | null>(null);
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
  /** Repositories the user added, oldest first. */
  repos = $state<RepoRow[]>([]);
  /** Indexes read this session, by repository URL — one fetch per repository per run. */
  private indexes = new Map<string, ExtensionEntry[]>();

  async open(): Promise<void> {
    if (this.profile !== null) return;
    try {
      this.profile = await openLibraryProfile();
      this.library = await this.profile.store.listSeries();
      this.extensions = await this.profile.store.listExtensions();
      this.repos = await this.profile.store.listRepos();
      this.ready = true;
      void this.pruneSessions();
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
  async installApk(file: File): Promise<InstalledExtension> {
    if (this.profile === null) throw new Error("the library is not open yet");
    const apk = new Uint8Array(await file.arrayBuffer());
    const installed = await this.profile.installApk(apk, packageIdFromApkName(file.name));
    this.extensions = await this.profile.store.listExtensions();
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
      repoUrl,
      versionName: entry.version,
      versionCode: entry.versionCode,
    });
    this.extensions = await this.profile.store.listExtensions();
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
    if (!settings.recordHistory) return;
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
    if (this.profile === null || !settings.recordHistory) return null;
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

  /** Drop sessions past the retention window. Runs once per launch, in the background. */
  async pruneSessions(): Promise<void> {
    const store = this.profile?.store;
    if (store === undefined) return;
    try {
      const kept = keepSessions(await store.listSessions(Number.POSITIVE_INFINITY));
      const keep = new Set(kept.map((row) => row.id));
      for (const row of await store.listSessions(Number.POSITIVE_INFINITY)) {
        if (!keep.has(row.id)) await store.clearSession(row.id);
      }
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

  /** Forget the reading log, keep every bookmark. */
  async clearHistory(): Promise<void> {
    const store = this.profile?.store;
    if (store === undefined) return;
    await store.clearHistory();
    this.historyClearedAt = Date.now();
  }

  /** The library's continue strip: newest positions, with the titles we already know. */
  async continueReading(limit = 5): Promise<Array<{ seriesId: string; title: string; chapterId: string; page: number }>> {
    if (this.profile === null) return [];
    const [positions, series] = await Promise.all([this.profile.store.listPositions(), this.profile.store.listSeries()]);
    const titles = new Map(series.map((row) => [row.id, row.title]));
    return positions.slice(0, limit).map((row) => ({
      seriesId: row.seriesId,
      chapterId: row.chapterId,
      page: row.page,
      title: titles.get(row.seriesId) ?? row.seriesId,
    }));
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
    // `dalvik:<sourceId>:<url>` — the source id is the first segment after the kind.
    const sourceId = provider === "dalvik" ? native.split(":")[0] : provider === "mihon" ? "" : native;
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

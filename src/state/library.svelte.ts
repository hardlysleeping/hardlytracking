/**
 * What the app knows right now: the open profile, the sources, the library.
 *
 * One state object, so the views never hold their own copy of the library and two
 * views cannot disagree about whether a series is saved.
 */
import { openLibraryProfile, progressWriter, type LibraryProfile } from "../api/profile";
import { providerFor } from "../api/registry";
import type { Chapter, Page, Series, Source } from "../api/source";

class LibraryState {
  profile = $state<LibraryProfile | null>(null);
  ready = $state(false);
  error = $state<string | null>(null);
  sources = $state<Source[]>([]);
  library = $state<Series[]>([]);

  async open(): Promise<void> {
    if (this.profile !== null) return;
    try {
      this.profile = await openLibraryProfile();
      this.library = await this.profile.store.listSeries();
      this.ready = true;
      void this.loadSources();
    } catch (error) {
      this.error = message(error);
    }
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

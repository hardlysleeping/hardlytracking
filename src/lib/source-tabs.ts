/**
 * Which listing chips a source's page draws, and in what order.
 *
 * Kept out of the view because it is the one part with a wrong answer that looks right: a source
 * that declares Trending but whose provider cannot answer it would show a tab that fails on tap, and
 * a source that declares nothing must still get the Popular/Latest pair every screen has shipped.
 */
import type { BrowseTab, Source, SourceProvider } from "../api/source";

/** The pair every source had before a source could declare its own. */
export const DEFAULT_BROWSE_TABS: readonly BrowseTab[] = ["popular", "latest"];

/**
 * The tabs to draw for one source.
 *
 * `declared` wins when the provider can actually answer every tab: a declared tab the provider has
 * no method for is dropped rather than drawn, because a chip that always errors is worse than a chip
 * that is not there. An empty result falls back to the default pair — a page with no listings at all
 * is not what "absent" means.
 */
export function browseTabsOf(
  source: Pick<Source, "browseTabs"> | null,
  provider: Pick<SourceProvider, "trending" | "latest"> | null | undefined,
): BrowseTab[] {
  const declared = source?.browseTabs ?? [];
  if (declared.length > 0) {
    const usable = declared.filter((tab) => {
      if (tab === "trending") return provider?.trending !== undefined;
      // Popular and latest are required members of the seam, so they are always answerable.
      return true;
    });
    if (usable.length > 0) return [...new Set(usable)];
  }
  return [...DEFAULT_BROWSE_TABS];
}

/** What to call a tab on screen. */
export function browseTabLabel(tab: BrowseTab): string {
  return tab === "trending" ? "Trending" : tab === "popular" ? "Popular" : "Latest";
}

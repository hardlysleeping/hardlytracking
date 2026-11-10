/**
 * The repository the app ships with.
 *
 * Every other repository is the user's: pasted, confirmed, removable. This one is the app's own
 * provider code — Internet Archive, Komga and Suwayomi arrive from here as ordinary extensions — so
 * it is seeded before anything reads the list and it cannot be deleted. Its *extensions* are still
 * the user's to install, disable and uninstall; only the list itself is not removable.
 *
 * Kept separate from `builtin.ts` on purpose. A built-in has no package at all; this row is a
 * repository that happens to be preinstalled, and the whole point is that what it lists updates
 * without a new build.
 */
import type { RepoRow } from "../db/store";
import type { LibraryStore } from "../db/store";

/**
 * The official index, addressed directly.
 *
 * A GitHub repository page is not an index: `loadRepository` appends `index.json`/`index.min.json`
 * to a root, and `github.com/.../tree/repo` answers HTML. Naming the raw file avoids inventing a
 * GitHub-specific rule in the loader.
 */
export const OFFICIAL_REPO_INDEX_URL =
  "https://raw.githubusercontent.com/hardlysleeping/hardlytracking-extensions/repo/index.json";

/** What the user pasted, which is what a repository is remembered by. Same value here: it is ours. */
export const OFFICIAL_REPO_URL = OFFICIAL_REPO_INDEX_URL;

export const OFFICIAL_REPO_NAME = "HardlyTracking Extensions";

export function officialRepoRow(at: number): RepoRow {
  return {
    url: OFFICIAL_REPO_URL,
    indexUrl: OFFICIAL_REPO_INDEX_URL,
    name: OFFICIAL_REPO_NAME,
    at,
    pinned: true,
  };
}

/**
 * Make sure the official repository is in the list, and leave an existing row alone.
 *
 * One rule, the same one the built-in switches follow: a boot repairs what is missing and never
 * overrides what the user chose. Re-pinning an existing row is a repair (an older build has no
 * `pinned` flag); the row's position is kept, so the list does not reshuffle on every launch.
 */
export async function ensurePinnedRepo(store: LibraryStore): Promise<RepoRow[]> {
  const rows = await store.listRepos();
  const existing = rows.find((row) => row.url === OFFICIAL_REPO_URL);
  if (existing === undefined) {
    await store.putRepo(officialRepoRow(Date.now()));
  } else if (existing.pinned !== true || existing.indexUrl !== OFFICIAL_REPO_INDEX_URL) {
    await store.putRepo({ ...existing, indexUrl: OFFICIAL_REPO_INDEX_URL, pinned: true });
  }
  return store.listRepos();
}

export function isPinnedRepo(url: string): boolean {
  return url === OFFICIAL_REPO_URL;
}

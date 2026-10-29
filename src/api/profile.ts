/**
 * Who is reading, and where the library lives.
 *
 * A profile is the honest answer to "is there a server behind this?" — the same
 * shape as HardlyReader's `ReaderProfile`, minus the sync half: a library on this
 * device is not a session with a fake token, it is a profile whose database is
 * local and whose providers are whatever the build configured.
 */
import { createProviders } from "./registry";
import type { SourceProvider } from "./source";
import { openDatabase, type Database } from "../lib/db/open";
import { LibraryStore } from "../lib/db/store";

export interface LibraryProfile {
  readonly kind: "device";
  /** Stable, secret-free tag for scoping device keys. */
  readonly slug: string;
  readonly label: string;
  readonly store: LibraryStore;
  readonly providers: SourceProvider[];
}

export const LOCAL_PROFILE_SLUG = "device://library";

export interface OpenProfileOptions {
  database?: Database;
  label?: string;
  mihonBase?: string | null;
}

/**
 * Opens (or creates) the library on this device. First launch is this call and
 * nothing else: an empty IndexedDB opens in milliseconds, where a runtime probe is
 * a network round-trip that can fail.
 */
export async function openLibraryProfile(options: OpenProfileOptions = {}): Promise<LibraryProfile> {
  const database = options.database ?? (await openDatabase());
  const store = new LibraryStore(database);
  return {
    kind: "device",
    slug: LOCAL_PROFILE_SLUG,
    label: options.label ?? "HardlyTracking",
    store,
    providers: createProviders({
      store,
      // `null` is the local-only build; only an absent option means "the default runtime".
      mihonBase: options.mihonBase === undefined ? "/api/mihon" : options.mihonBase,
    }),
  };
}

/**
 * Authority, stated once.
 *
 * `ownsProgress: false` (Mihon, Komga) means the server is the writer and our row is
 * a mirror; `true` (local) means we are. Every progress write in the app goes through
 * this function, so "who owns this row" is never re-decided at a call site.
 */
export function progressWriter(provider: SourceProvider): "server" | "device" {
  return provider.ownsProgress ? "device" : "server";
}

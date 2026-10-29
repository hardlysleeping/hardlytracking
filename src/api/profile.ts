/**
 * Who is reading, and where the library lives.
 *
 * A profile is the honest answer to "is there a server behind this?" — the same
 * shape as HardlyReader's `ReaderProfile`, minus the sync half: a library on this
 * device is not a session with a fake token, it is a profile whose database is
 * local and whose providers are whatever the build configured.
 */
import { createProviders, type DalvikHost } from "./registry";
import type { InstalledExtension } from "./dalvik";
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
  /** The extension host, when one answered `/capabilities`. */
  readonly dalvik: DalvikHost | null;
  /** Configured hosts that did not answer — a banner, not silence. */
  readonly warnings: string[];
  /**
   * Install an APK's bytes on the host and remember what it exposes.
   *
   * The bytes are the install: the runtime has no install route, so this is one `/dalvik`
   * call carrying base64, and the id it answers with (sha256 of those bytes) is what every
   * later call names. The row lands in our database because the runtime keeps no list.
   */
  installApk(apk: Uint8Array, packageId: string, meta?: InstallMeta): Promise<InstalledExtension>;
}

export const LOCAL_PROFILE_SLUG = "device://library";

/** What a repository knows about an APK that the host cannot tell us. */
export interface InstallMeta {
  repoUrl?: string;
  versionName?: string;
  versionCode?: number;
  enabled?: boolean;
}

export interface OpenProfileOptions {
  database?: Database;
  label?: string;
  mihonBase?: string | null;
  /** Where the dalvik host answers; `undefined` = the app's own `/api/dalvik` proxy. */
  dalvikBase?: string | null;
  /** Probe override for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Opens (or creates) the library on this device. First launch is this call and
 * nothing else: an empty IndexedDB opens in milliseconds, where a runtime probe is
 * a network round-trip that can fail. The one probe that does happen — `/capabilities`
 * on the dalvik host — is bounded to 4 s and its failure is a warning, never a throw:
 * the library must open with no server at all.
 */
export async function openLibraryProfile(options: OpenProfileOptions = {}): Promise<LibraryProfile> {
  const database = options.database ?? (await openDatabase());
  const store = new LibraryStore(database);
  const registry = await createProviders({
    store,
    // `null` is the local-only build; only an absent option means "the default runtime".
    mihonBase: options.mihonBase === undefined ? "/api/mihon" : options.mihonBase,
    dalvikBase: options.dalvikBase === undefined ? "/api/dalvik" : options.dalvikBase,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  const dalvik = registry.dalvik;
  return {
    kind: "device",
    slug: LOCAL_PROFILE_SLUG,
    label: options.label ?? "HardlyTracking",
    store,
    providers: registry.providers,
    dalvik,
    warnings: registry.warnings,
    async installApk(apk: Uint8Array, packageId: string, meta: InstallMeta = {}): Promise<InstalledExtension> {
      if (dalvik === null) {
        throw new Error("no extension host answered /capabilities, so there is nothing to install onto");
      }
      const installed = await dalvik.client.install(apk);
      const row: InstalledExtension = {
        extensionId: installed.extensionId,
        packageId,
        sources: installed.sources,
        enabled: meta.enabled ?? true,
        ...(meta.repoUrl === undefined ? {} : { repoUrl: meta.repoUrl }),
        ...(meta.versionName === undefined ? {} : { versionName: meta.versionName }),
        ...(meta.versionCode === undefined ? {} : { versionCode: meta.versionCode }),
      };
      await store.putExtension(row);
      // The provider reads this same array, so the new sources are live on the next call —
      // and the same APK twice replaces its own row instead of duplicating 61 sources.
      const at = dalvik.extensions.findIndex((extension) => extension.extensionId === row.extensionId);
      if (at >= 0) dalvik.extensions[at] = row;
      else dalvik.extensions.push(row);
      return row;
    },
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

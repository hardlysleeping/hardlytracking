/**
 * Who is reading, and where the library lives.
 *
 * A profile is the honest answer to "is there a server behind this?" — the same
 * shape as HardlyReader's `ReaderProfile`, minus the sync half: a library on this
 * device is not a session with a fake token, it is a profile whose database is
 * local and whose providers are whatever the build configured.
 */
import { apiUrl } from "../lib/host";
import { createProviders, type DalvikHost } from "./registry";
import { BUILTIN_ARCHIVE_ID, BUILTIN_READ_SERVER_ID, ensureBuiltinExtensions, isBuiltin } from "./builtin";
import { readServerEnabled, setReadServerEnabled } from "../lib/host";
import type { InstalledExtension } from "./dalvik";
import type { SourceProvider } from "./source";
import { openDatabase, type Database } from "../lib/db/open";
import { LibraryStore } from "../lib/db/store";
import { dbCookieJar, type CookieJar } from "../lib/webview/store";
import { hostOf } from "../lib/webview/cookies";
import { loginSource, type LoginResult } from "./mihon-bridge";

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
  /** Turn an installed extension on or off. Its row and its APK stay; its sources stop appearing. */
  setExtensionEnabled(extensionId: string, enabled: boolean): Promise<void>;
  /** Forget an extension: its row, and its sources with it. The APK is the host's to drop. */
  uninstallExtension(extensionId: string): Promise<void>;
  /** Where source cookies live on this device. */
  readonly cookies: CookieJar;
  /**
   * Log a source in through the in-app webview and hand what it set to the runtime.
   *
   * Resolves to what happened — `ok`, `cancelled`, `unsupported`, `failed`, `rejected` — because a
   * login that did not take has to be visible in the UI, not thrown away (matrix rows WEB-07/09).
   */
  login(sourceId: string, options?: { loginUrl?: string | null }): Promise<LoginResult>;
}

export const LOCAL_PROFILE_SLUG = "device://library";

/** What a repository knows about an APK that the host cannot tell us. */
export interface InstallMeta {
  repoUrl?: string;
  /** The index's name and icon, so the card says "MangaFire" instead of a package id. */
  name?: string;
  iconUrl?: string;
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
  // One jar per profile: cookies outlive the runtime process, which is the point of keeping them
  // here rather than trusting a `MemoryCookieJar` on the other side of a loopback port.
  const jar = dbCookieJar(database);
  // The webview's user agent, remembered so a later call looks like the client that logged in
  // (matrix row WEB-10). Per device, not per source: it is one webview.
  let sessionUserAgent = await store.getPref<string>("webview.userAgent");
  // Built-ins are installed before the providers are built, because a provider's switch is its row:
  // the first launch of a fresh install must already know that archive.org is on.
  const builtins = await ensureBuiltinExtensions(store);
  const switches = {
    archive: builtins.find((row) => row.extensionId === BUILTIN_ARCHIVE_ID)?.enabled !== false,
    readServer: readServerEnabled(),
  };
  const registry = await createProviders({
    store,
    // `null` is the local-only build; only an absent option means "the default runtime".
    mihonBase: options.mihonBase === undefined ? apiUrl("/api/mihon") : options.mihonBase,
    dalvikBase: options.dalvikBase === undefined ? apiUrl("/api/dalvik") : options.dalvikBase,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    archiveEnabled: () => switches.archive,
    // The session: the jar this device keeps, and the UA the webview logged in with. Read on every
    // call, because the runtime's own jar is memory-only and has no read route (matrix row HTTP-07).
    cookies: jar,
    userAgent: () => sessionUserAgent,
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
        ...(meta.name === undefined ? {} : { name: meta.name }),
        ...(meta.iconUrl === undefined ? {} : { iconUrl: meta.iconUrl }),
        sources: installed.sources,
        enabled: meta.enabled ?? true,
        ...(meta.repoUrl === undefined ? {} : { repoUrl: meta.repoUrl }),
        ...(meta.versionName === undefined ? {} : { versionName: meta.versionName }),
        ...(meta.versionCode === undefined ? {} : { versionCode: meta.versionCode }),
        // Kept on the row, not in memory: the runtime holds APKs only in memory, so this device is
        // what lets an extension survive a restart of the runtime the user never sees.
        apk: apk.buffer.slice(apk.byteOffset, apk.byteOffset + apk.byteLength) as ArrayBuffer,
      };
      await store.putExtension(row);
      // The provider reads this same array, so the new sources are live on the next call —
      // and the same APK twice replaces its own row instead of duplicating 61 sources.
      const at = dalvik.extensions.findIndex((extension) => extension.extensionId === row.extensionId);
      if (at >= 0) dalvik.extensions[at] = row;
      else dalvik.extensions.push(row);
      return row;
    },
    async setExtensionEnabled(extensionId: string, enabled: boolean): Promise<void> {
      const row = await store.getExtension(extensionId);
      if (row === undefined) return;
      const next: InstalledExtension = { ...row, enabled };
      await store.putExtension(next);
      // A built-in has no host to tell: its provider reads this flag on the next call.
      if (isBuiltin(extensionId)) {
        if (extensionId === BUILTIN_ARCHIVE_ID) switches.archive = enabled;
        // The read server's switch is the pairing decision: the address and token stay, the calls
        // stop going to them. Every later call re-reads it through apiUrl().
        if (extensionId === BUILTIN_READ_SERVER_ID) {
          switches.readServer = enabled;
          setReadServerEnabled(enabled);
        }
        return;
      }
      if (dalvik === null) return;
      const at = dalvik.extensions.findIndex((extension) => extension.extensionId === extensionId);
      if (at >= 0) dalvik.extensions[at] = next;
    },
    async uninstallExtension(extensionId: string): Promise<void> {
      // There is nothing to uninstall: the code is in the app. Refusing keeps a stray call from
      // deleting a row that would be re-seeded on the next launch and look like a bug.
      if (isBuiltin(extensionId)) throw new Error(`${extensionId} is built in; disable it instead`);
      await store.removeExtension(extensionId);
      if (dalvik === null) return;
      const at = dalvik.extensions.findIndex((extension) => extension.extensionId === extensionId);
      if (at >= 0) dalvik.extensions.splice(at, 1);
    },
    cookies: jar,
    async login(sourceId: string, loginOptions: { loginUrl?: string | null } = {}): Promise<LoginResult> {
      if (dalvik === null) {
        throw new Error("no extension host answered /capabilities, so there is no runtime to sign in to");
      }
      const bare = sourceId.replace(/^dalvik:/, "").replace(/^src:/, "");
      // The site comes from the installed extension's own source list — the same value the
      // provider hands the runtime as `source-base-url`, so both ends scope the cookies to one host.
      const found = dalvik.extensions
        .flatMap((extension) => extension.sources)
        .find((source) => source.id === bare);
      const baseUrl = found?.baseUrl;
      if (baseUrl === undefined || hostOf(baseUrl) === null) {
        throw new Error(`source ${bare} has no site address, so there is no page to log in on`);
      }
      const result = await loginSource(
        {
          sourceId: bare,
          baseUrl,
          ...(found?.name === undefined ? {} : { title: found.name }),
          ...(loginOptions.loginUrl === undefined ? {} : { loginUrl: loginOptions.loginUrl }),
        },
        { client: dalvik.client, extensions: dalvik.extensions, jar },
      );
      // The UA only comes back from a successful login, and it is a device fact, so it is kept even
      // though the cookies are the source's: the next login page will present the same client.
      if (result.status === "ok" && result.userAgent !== undefined) {
        sessionUserAgent = result.userAgent;
        await store.setPref("webview.userAgent", result.userAgent);
      }
      return result;
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

/**
 * Who is reading, and where the library lives.
 *
 * A profile is the honest answer to "is there a server behind this?" — the same
 * shape as HardlyReader's `ReaderProfile`, minus the sync half: a library on this
 * device is not a session with a fake token, it is a profile whose database is
 * local and whose providers are whatever the build configured.
 */
import { apiUrl } from "../lib/host";
import { createProviders, openHtServer, type DalvikHost, type RegistryConfig } from "./registry";
import { BUILTIN_ARCHIVE_ID, BUILTIN_HT_SERVER_ID, ensureBuiltinExtensions, isBuiltin } from "./builtin";
import { htServerEnabled, setHtServerEnabled } from "../lib/host";
import type { InstalledExtension } from "./dalvik";
import type { SourceProvider } from "./source";
import { openDatabase, type Database } from "../lib/db/open";
import { LibraryStore } from "../lib/db/store";
import { dbCookieJar, type CookieJar } from "../lib/webview/store";
import { hostOf } from "../lib/webview/cookies";
import { loginSource, type LoginConsent, type LoginResult } from "./mihon-bridge";
import { grantConsent, isGranted, revokeConsent, type ConsentGrant } from "../lib/webview/consent";

/** Where the cookie grants live in this device's preferences. */
const CONSENT_PREF = "settings.consentGrants";
import { openHostRegistry } from "../lib/extensions/host-registry";
import { komgaEnabled, komgaSettings } from "../lib/komga";
import { createKomgaProvider } from "./komga";

export interface LibraryProfile {
  readonly kind: "device";
  /** Stable, secret-free tag for scoping device keys. */
  readonly slug: string;
  readonly label: string;
  readonly store: LibraryStore;
  readonly providers: SourceProvider[];
  /** The extension host, when one answered `/capabilities`. */
  readonly dalvik: DalvikHost | null;
  /**
   * The paired HT-Server, when one answered.
   *
   * Replaced by `refreshHtServer()` when the address or the token changes — the pairing is a live
   * setting, and a card that saves an address while the provider keeps the old one reads as broken.
   */
  htServer: DalvikHost | null;
  /**
   * The cookie consent gate: which sources have been allowed to use which domains.
   *
   * On the profile rather than in a screen because the webview hand-off goes through `login()`,
   * and a permission that only some callers check is not a permission.
   */
  readonly consent: LoginConsent & { revoke(sourceId: string): Promise<void> };
  /** Where this build's APK extensions live: this device's database, or the host registry serving it. */
  readonly extensionWhere: "device" | "host";
  /** Every extension row the UI draws: the built-ins (this device's) plus the APK rows. */
  listExtensions(): Promise<InstalledExtension[]>;
  /** Re-probe the paired HT-Server. Resolves to a warning line, or `null` when it answered. */
  refreshHtServer(): Promise<string | null>;
  /**
   * Rebuild the Komga provider from the saved address and login.
   *
   * Called when the card is saved: a provider built from the old address would leave the card and
   * Browse disagreeing, which reads as "the setting did nothing".
   */
  refreshKomga(): Promise<string | null>;
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
    htServer: htServerEnabled(),
  };
  // Where the APK rows live. Asked once, at boot: a proxy answering `/api/host/extensions` means
  // this page is being served by a PC that is an HT-Server, and then its registry is the list — the
  // same list a paired phone reads, so the two screens cannot disagree.
  const hostRegistry = await openHostRegistry(store);
  const config: RegistryConfig = {
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
    ...(hostRegistry === null ? {} : { extensionList: () => hostRegistry.list() }),
  };
  const registry = await createProviders(config);

  const dalvik = registry.dalvik;
  const providers = registry.providers;

  /** The built-ins are this device's — the archive switch and the HT-Server pairing — so they never
   * come from a host registry, which holds APKs only. */
  async function listExtensions(): Promise<InstalledExtension[]> {
    if (hostRegistry === null) return store.listExtensions();
    const own = (await store.listExtensions()).filter((row) => row.builtin === true);
    return [...own, ...(await hostRegistry.list())];
  }

  /**
   * The consent gate, read from this device's own store.
   *
   * A grant is stored as a preference because it is a decision the user made and would expect to
   * survive a relaunch — and because a backup that carries it is a backup of the same person's
   * answers. `revoke` is what uninstalling a source calls.
   */
  const consent = {
    async isGranted(sourceId: string, domain: string): Promise<boolean> {
      return isGranted((await store.getPref<ConsentGrant[]>(CONSENT_PREF)) ?? [], sourceId, domain);
    },
    async grant(sourceId: string, domain: string): Promise<void> {
      const grants = (await store.getPref<ConsentGrant[]>(CONSENT_PREF)) ?? [];
      await store.setPref(CONSENT_PREF, grantConsent(grants, sourceId, domain, Date.now()));
    },
    async revoke(sourceId: string): Promise<void> {
      const grants = (await store.getPref<ConsentGrant[]>(CONSENT_PREF)) ?? [];
      const kept = revokeConsent(grants, sourceId);
      if (kept.length !== grants.length) await store.setPref(CONSENT_PREF, kept);
    },
  }

  const profile: LibraryProfile = {
    kind: "device",
    slug: LOCAL_PROFILE_SLUG,
    label: options.label ?? "HardlyTracking",
    store,
    providers,
    dalvik,
    htServer: registry.htServer,
    extensionWhere: hostRegistry === null ? "device" : "host",
    listExtensions,
    async refreshKomga(): Promise<string | null> {
      const at = providers.findIndex((provider) => provider.kind === "komga");
      if (at >= 0) providers.splice(at, 1);
      const saved = komgaSettings();
      if (saved === null || !komgaEnabled()) return null;
      const provider = createKomgaProvider({
        ...saved,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      try {
        const sources = await provider.sources();
        providers.push(provider);
        return sources.length === 0 ? `Komga ${saved.baseUrl}: signed in, but no libraries are visible to that user` : null;
      } catch (error) {
        return `Komga ${saved.baseUrl}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    async refreshHtServer(): Promise<string | null> {
      const next = await openHtServer(config);
      const at = providers.findIndex((provider) => provider.kind === "htserver");
      if (at >= 0) providers.splice(at, 1);
      if (next.provider !== null) providers.push(next.provider);
      this.htServer = next.host;
      return next.warning;
    },
    warnings: registry.warnings,
    async installApk(apk: Uint8Array, packageId: string, meta: InstallMeta = {}): Promise<InstalledExtension> {
      // Served by a PC that is an HT-Server: the registry is the host's, and the APK's bytes travel
      // once and stay there. This machine then owns them, which is what lets it hand them back to its
      // own runtime after a restart.
      if (hostRegistry !== null) {
        const row = await hostRegistry.install(apk, packageId, meta);
        if (dalvik !== null) {
          const at = dalvik.extensions.findIndex((extension) => extension.extensionId === row.extensionId);
          if (at >= 0) dalvik.extensions[at] = row;
          else dalvik.extensions.push(row);
        }
        return row;
      }
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
      // A built-in has no host to tell: its provider reads this flag on the next call.
      if (isBuiltin(extensionId)) {
        const row = await store.getExtension(extensionId);
        if (row !== undefined) await store.putExtension({ ...row, enabled });
        if (extensionId === BUILTIN_ARCHIVE_ID) switches.archive = enabled;
        // The HT-Server's switch is the pairing decision: the address and token stay, its sources
        // stop being offered. Nothing else on this device changes.
        if (extensionId === BUILTIN_HT_SERVER_ID) {
          switches.htServer = enabled;
          setHtServerEnabled(enabled);
          // Its provider was built (or not) from that switch, so the list follows it now instead of
          // at the next launch.
          const at = providers.findIndex((provider) => provider.kind === "htserver");
          if (at >= 0) providers.splice(at, 1);
          if (enabled) {
            const next = await openHtServer(config);
            if (next.provider !== null) providers.push(next.provider);
            this.htServer = next.host;
          } else {
            this.htServer = null;
          }
        }
        return;
      }
      if (hostRegistry !== null) {
        await hostRegistry.setEnabled(extensionId, enabled);
        const row = (await hostRegistry.list()).find((extension) => extension.extensionId === extensionId);
        if (row !== undefined && dalvik !== null) {
          const at = dalvik.extensions.findIndex((extension) => extension.extensionId === extensionId);
          if (at >= 0) dalvik.extensions[at] = row;
        }
        return;
      }
      const row = await store.getExtension(extensionId);
      if (row === undefined) return;
      const next: InstalledExtension = { ...row, enabled };
      await store.putExtension(next);
      if (dalvik === null) return;
      const at = dalvik.extensions.findIndex((extension) => extension.extensionId === extensionId);
      if (at >= 0) dalvik.extensions[at] = next;
    },
    async uninstallExtension(extensionId: string): Promise<void> {
      // There is nothing to uninstall: the code is in the app. Refusing keeps a stray call from
      // deleting a row that would be re-seeded on the next launch and look like a bug.
      if (isBuiltin(extensionId)) throw new Error(`${extensionId} is built in; disable it instead`);
      // Its sources' permissions go with it: a reinstall is a new question, and a grant for a source
      // that no longer exists is a permission nobody can see or take back.
      const leaving = (dalvik?.extensions.find((row) => row.extensionId === extensionId)?.sources ?? (await store.getExtension(extensionId))?.sources ?? []).map((source) => source.id);
      for (const id of leaving) await consent.revoke(id);
      if (hostRegistry !== null) {
        await hostRegistry.remove(extensionId);
        // The old row may still sit in this device's database from before the registry existed. It is
        // not the list any more, but leaving it there would resurrect the extension on a build with no
        // proxy behind it.
        await store.removeExtension(extensionId);
        if (dalvik !== null) {
          const at = dalvik.extensions.findIndex((extension) => extension.extensionId === extensionId);
          if (at >= 0) dalvik.extensions.splice(at, 1);
        }
        return;
      }
      await store.removeExtension(extensionId);
      if (dalvik === null) return;
      const at = dalvik.extensions.findIndex((extension) => extension.extensionId === extensionId);
      if (at >= 0) dalvik.extensions.splice(at, 1);
    },
    cookies: jar,
    consent,
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
        {
          client: dalvik.client,
          extensions: dalvik.extensions,
          jar,
          consent,
        },
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
  return profile;
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

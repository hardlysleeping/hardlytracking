/**
 * Which providers this build talks to.
 *
 * One list, built once, and a lookup by id prefix. A provider is only registered
 * when it is configured: an unconfigured Komga must not appear in the UI as an
 * empty shelf, because "no series" and "no server" are different answers.
 *
 * Two hosts are probed rather than assumed, because both are separate processes on another port
 * (or another machine): a M-Extension-Server answers `/capabilities`, and so does a paired HT-Server.
 * A host that answers gets a provider built from the APKs installed there; a host that does not is a
 * warning line, not a silent empty shelf.
 *
 * The two are **different kinds** (`dalvik`, `htserver`) on purpose. Both speak the same `/dalvik`
 * protocol and their extension ids are SHA-256s that are byte-identical on both machines, so one
 * shared kind would make `providerFor` hand a phone's id to the PC and every call land on the wrong
 * host.
 */
import { apiUrl, htServerBase, hostToken, remoteHost } from "../lib/host";
import { komgaEnabled, komgaSettings } from "../lib/komga";
import { browserMihonTransport, createMihonProvider } from "./mihon";
import { createSuwayomiProvider } from "./suwayomi";
import { suwayomiEnabled, suwayomiSettings } from "../lib/suwayomi";
import { createLocalProvider } from "./local";
import { createArchiveProvider } from "./archive";
import {
  DalvikClient,
  createDalvikProvider,
  type DalvikCapabilities,
  type DalvikReadState,
  type InstalledExtension,
} from "./dalvik";
import { listHtServerExtensions } from "./htserver";
import { createKomgaProvider } from "./komga";
import { createWebdavProvider } from "./webdav";
import { webdavEnabled, webdavSettings } from "../lib/webdav";
import { splitId, type SourceProvider } from "./source";
import type { LibraryStore } from "../lib/db/store";
import type { CookieJar } from "../lib/webview/store";
import { wirePreferences } from "../lib/extensions/prefs";

export interface RegistryConfig {
  store: LibraryStore;
  /** Build local providers without remote handshakes; attach hosts after the saved library opens. */
  localFirst?: boolean;
  /** Legacy/default Mihon runtime; `null` disables the fallback, not an explicitly saved Suwayomi. */
  mihonBase?: string | null;
  /**
   * Where the dalvik host is reachable: an absolute loopback URL in the packaged app,
   * the app's own `/api/dalvik` proxy in the browser. `null` disables it.
   */
  dalvikBase?: string | null;
  /** Probe override, so a test can hand the registry a stub host. */
  fetchImpl?: typeof fetch;
  /**
   * Whether the built-in archive.org extension is on. `undefined` means yes, so a test that does not
   * care about the switch still gets the provider.
   */
  archiveEnabled?: () => boolean;
  /**
   * Where this device keeps source cookies, so a logged-in source stays logged in across a runtime
   * restart (the runtime's own jar is memory-only). Absent means no session is carried.
   */
  cookies?: CookieJar;
  /** The user's own Komga, when one is configured; absent means "read the saved setting". */
  komga?: { baseUrl: string; username: string; password: string } | null;
  /** The user's own WebDAV folder; absent means "read the saved setting". */
  webdav?: { url: string; username: string; password: string } | null;
  /** Its switch, read live like Komga's. */
  webdavEnabled?: () => boolean;
  /** Its switch, read live so turning it off takes effect without a restart. */
  komgaEnabled?: () => boolean;
  /** The UA the webview logged in with, read per call (matrix row WEB-10). */
  userAgent?: () => string | undefined;
  /** Loopback port of the app's webview bridge, when this build hosts one. */
  webviewPort?: () => number | undefined;
  /**
   * Where this build's APK extensions are listed.
   *
   * Default: this device's database. A build that is itself an HT-Server passes the host registry
   * instead, so the PC's own Extensions screen and a paired phone read one list — two lists drift
   * the moment either side installs something.
   */
  extensionList?: () => Promise<InstalledExtension[]>;
}

/** A live host: the client to install through, and the list it reads. */
export interface DalvikHost {
  baseUrl: string;
  client: DalvikClient;
  capabilities: DalvikCapabilities;
  /** The same array the provider reads — installing an APK pushes into it. */
  extensions: InstalledExtension[];
}

/**
 * How long a host may take to answer a probe.
 *
 * `/capabilities` is the handshake that turns an address into a provider. A runtime that has bound its
 * port but wedged — a JVM stopped mid-start — accepts the connection and then says nothing, and a
 * request with no deadline waits for the session. That is how the *library* became hostage to the
 * *extension host*: the provider set was built before a single title was read.
 */
export const NET_PROBE_DEADLINE_MS = 8_000;

/** `work`, or a rejection naming `what` once `ms` pass. The timer never outlives the race. */
export async function withinDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer in ${Math.round(ms / 1000)} s`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface ProviderSet {
  providers: SourceProvider[];
  /** `null` when no host answered `/capabilities`. */
  dalvik: DalvikHost | null;
  /** The paired HT-Server, when one answered. Its own kind, its own ids. */
  htServer: DalvikHost | null;
  /** Configured hosts that did not answer. Shown, never swallowed. */
  warnings: string[];
}

/** This device's read marks, as the dalvik provider needs them. */
function readStateFor(store: LibraryStore): DalvikReadState {
  return {
    read: async (chapterIds) => {
      const marks = await Promise.all(chapterIds.map(async (id) => ((await store.isRead(id)) ? id : null)));
      return new Set(marks.filter((id): id is string => id !== null));
    },
    mark: (chapterId, read) => store.setRead(chapterId, read),
  };
}

/**
 * A source's saved settings, read on every call.
 *
 * The runtime's own preference store is memory-only, so this device is the store: a restart would
 * otherwise forget the address that makes a self-hosted source reachable at all. It is per device on
 * purpose — the phone's settings for a host source are the phone's, and the PC's own provider sends
 * the PC's.
 */
function preferencesFor(store: LibraryStore): (sourceId: string) => Promise<Array<Record<string, unknown>> | undefined> {
  return async (sourceId) => {
    const saved = await store.getSourcePrefs(sourceId);
    return saved === undefined ? undefined : wirePreferences(saved);
  };
}

export interface HtServerResult {
  host: DalvikHost | null;
  provider: SourceProvider | null;
  warning: string | null;
}

/**
 * The paired HT-Server, as a provider — or `null` when there is no pairing.
 *
 * The list comes from the PC's own routes (`/api/host/extensions`), not from a `/dalvik` call: the
 * protocol has no way to say what is installed. Those rows carry no APK bytes, so `apkResend` is off
 * — a phone must never hand its own APK to the PC.
 */
export async function openHtServer(config: RegistryConfig): Promise<HtServerResult> {
  const base = htServerBase();
  if (base === "") return { host: null, provider: null, warning: null };

  const client = new DalvikClient({
    baseUrl: base,
    // The PC's runtime mints `http://127.0.0.1:8792/image/…`, and 127.0.0.1 on the phone is the
    // phone. Every one of those addresses belongs to the PC's proxy here.
    rewriteRuntimeAssets: true,
    token: hostToken,
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });
  try {
    const capabilities = await client.capabilities();
    const extensions = await listHtServerExtensions(remoteHost());
    const provider = createDalvikProvider({
      client,
      extensions,
      kind: "htserver",
      apkResend: false,
      // The PC has no read-state API either, so the marks are this device's — the same store the
      // local provider writes to.
      readState: readStateFor(config.store),
      preferences: preferencesFor(config.store),
    });
    return { host: { baseUrl: base, client, capabilities, extensions }, provider, warning: null };
  } catch (error) {
    return {
      host: null,
      provider: null,
      warning: `HT-Server ${remoteHost()}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Build without a network gate: explicit hosted settings override only the legacy Mihon fallback. */
export function configuredMihonProvider(config: RegistryConfig): SourceProvider | null {
  if (!suwayomiEnabled()) return null;
  const saved = suwayomiSettings();
  if (saved !== null) return createSuwayomiProvider({
    ...saved, ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });
  const base = config.mihonBase === undefined ? apiUrl("/api/mihon") : config.mihonBase;
  return base === null ? null : createMihonProvider(browserMihonTransport(base, config.fetchImpl));
}

export async function createProviders(config: RegistryConfig): Promise<ProviderSet> {
  const providers: SourceProvider[] = [];
  const warnings: string[] = [];
  const extensionList = config.extensionList ?? (() => config.store.listExtensions());

  const mihon = configuredMihonProvider(config);
  if (mihon !== null) providers.push(mihon);

  providers.push(createLocalProvider(config.store));

  // archive.org needs no host, no token and no configuration: it is a public catalogue, so it is
  // always built and never appears as an empty shelf. Its switch is the built-in extension's own
  // row, read live, so turning it off in Extensions takes effect without a restart.
  providers.push(
    createArchiveProvider({
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
      ...(config.archiveEnabled === undefined ? {} : { enabled: config.archiveEnabled }),
      // Present so a downloaded volume is kept: the second read of a 40 MB scan must not be a
      // second download, and a library that survives a reload should not forget a book it fetched.
      ...(config.store === undefined ? {} : { store: config.store }),
    }),
  );

  /**
   * Komga, when the user has entered an address and a login.
   *
   * A Komga that is configured but unreachable is a *warning*, not a silent empty shelf: the
   * difference between "nothing here" and "your server is off" is the whole point of the flag.
   */
  const komga = config.komga === undefined ? komgaSettings() : config.komga;
  if (komga !== null && (config.komgaEnabled === undefined ? komgaEnabled() : config.komgaEnabled())) {
    const provider = createKomgaProvider({
      ...komga,
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    });
    if (config.localFirst) {
      providers.push(provider);
    } else try {
      // Explicit connection checks remain available outside local-first startup.
      const sources = await provider.sources();
      providers.push(provider);
      if (sources.length === 0) warnings.push(`Komga ${komga.baseUrl}: signed in, but no libraries are visible to that user`);
    } catch (error) {
      warnings.push(`Komga ${komga.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * A WebDAV folder, when one is configured.
   *
   * The probe is a real `PROPFIND`, because "configured" and "reachable" are different answers and
   * the user needs to know which one they have. Nothing is downloaded at boot: listing a folder is
   * one request, and a book is fetched the first time it is opened.
   */
  const webdav = config.webdav === undefined ? webdavSettings() : config.webdav;
  if (webdav !== null && (config.webdavEnabled === undefined ? webdavEnabled() : config.webdavEnabled())) {
    const provider = createWebdavProvider({
      ...webdav,
      store: config.store,
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    });
    providers.push(provider);
  }

  let dalvik: DalvikHost | null = null;
  const dalvikBase = config.dalvikBase === undefined ? apiUrl("/api/dalvik") : config.dalvikBase;
  if (dalvikBase !== null && !config.localFirst) {
    const attached = await openDalvik(config, dalvikBase, extensionList);
    if (attached.provider !== null) providers.push(attached.provider);
    if (attached.warning !== null) warnings.push(attached.warning);
    dalvik = attached.dalvik;
  }

  const htServer = config.localFirst
    ? { host: null, provider: null, warning: null }
    : await openHtServer(config);
  if (htServer.provider !== null) providers.push(htServer.provider);
  if (htServer.warning !== null) warnings.push(htServer.warning);

  return { providers, dalvik, htServer: htServer.host, warnings };
}

/**
 * Turn an address into the extension host, with a deadline on the handshake.
 *
 * Exported because the same step runs twice: at open, when a proxy answers immediately, and later in
 * the background, when an on-device runtime has finished starting. The library never waits on it.
 */
export async function openDalvik(
  config: RegistryConfig,
  baseUrl: string,
  extensionList: () => Promise<InstalledExtension[]> = () => config.store.listExtensions(),
  /** Overridable so a test can prove the deadline without waiting eight seconds. */
  deadlineMs = NET_PROBE_DEADLINE_MS,
): Promise<{ dalvik: DalvikHost | null; provider: SourceProvider | null; warning: string | null }> {
  const client = new DalvikClient({
    baseUrl,
    // Runtime-owned proxy URLs belong to the host we actually reached, even if its
    // advertised hostname/port differs (localhost versus the native bridge's 127.0.0.1).
    rewriteRuntimeAssets: true,
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  });
  try {
    const capabilities = await withinDeadline(client.capabilities(), deadlineMs, `the extension host at ${baseUrl}`);
    // Read once so the sources of an APK installed last launch are there before the first paint; the
    // array stays live afterwards. Built-ins are excluded: they have no APK and no runtime handle, so
    // feeding one to the host would ask it to run a package it never saw.
    const extensions = (await extensionList()).filter((row) => row.builtin !== true);
    const provider = createDalvikProvider({
      client,
      extensions,
      // The session travels on every call: cookies from this device's jar, the UA the webview used,
      // and — when this build hosts one — the port of the app's own webview bridge.
      ...(config.cookies === undefined ? {} : { cookies: config.cookies }),
      ...(config.userAgent === undefined ? {} : { userAgent: config.userAgent }),
      ...(config.webviewPort === undefined ? {} : { webviewPort: config.webviewPort }),
      preferences: preferencesFor(config.store),
      readState: readStateFor(config.store),
    });
    return { dalvik: { baseUrl, client, capabilities, extensions }, provider, warning: null };
  } catch (error) {
    return {
      dalvik: null,
      provider: null,
      warning: `dalvik: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function providerFor(providers: SourceProvider[], id: string): SourceProvider {
  const { provider } = splitId(id);
  const found = providers.find((p) => p.kind === provider);
  if (!found) throw new Error(`no ${provider} provider is configured`);
  return found;
}

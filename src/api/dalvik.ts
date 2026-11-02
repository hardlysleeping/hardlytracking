/**
 * The `/dalvik` bridge: how our app talks to a Mihon extension host that is not
 * Suwayomi.
 *
 * M-Extension-Server exposes exactly one call surface for extensions — `POST /dalvik`
 * with a `DataBody` — and no way to install over HTTP. Install is *the same call*: send
 * the APK bytes as base64 in `data`, and the response carries `X-Mangayomi-Extension-Id`,
 * which is the SHA-256 of those bytes. Every later call names that id instead of resending
 * the APK. That is the whole protocol, and it is why the packaged apps can do this on-device
 * with no server and no store.
 *
 * Verified against MExtensionServer v1.0.9 (Linux x64) with the real MangaDex APK:
 * `sourcesManga` returned 61 sources, `getPopularManga` a page with `hasNextPage`,
 * `getChapterList` 3 chapters, `getPageList` 21 pages.
 *
 * Two shapes worth knowing before reading the mapping code:
 *
 * - **Images come back through the runtime**, not from the site: `thumbnail_url` and a
 *   page's `imageUrl` are `http://<host>/image/<uuid>`. The runtime fetches with the
 *   source's own headers, so the reader never has to know them and the browser never hits
 *   a third-party origin. A page's `url` is a bridge memo (host, api url, timestamp), not
 *   an image address — do not use it as one.
 * - **`chapter_number` is a float**, and `-1` means the extension could not parse one.
 *   Keeping -1 as a number would sort specials to the top, so it becomes 0 and the name
 *   carries the truth.
 */
import { apiHeaders } from "../lib/host";
import type { CookieJar } from "../lib/webview/store";
import { hostOf } from "../lib/webview/cookies";
import { dalvikChanges, dalvikFilters, mapFilters, type DalvikRawFilter } from "../lib/source-filters";
import { joinId, nativeId, paged, providerLabel, type Chapter, type Page, type Paged, type ProviderKind, type Series, type Source, type SourceFilter, type SourceFilterSelection, type SourceProvider } from "./source";

export type DalvikMethod =
  | "sourcesManga"
  | "headersManga"
  | "filtersManga"
  | "supportLatestManga"
  | "getPopularManga"
  | "getLatestManga"
  | "getSearchManga"
  | "getDetailsManga"
  | "getChapterList"
  | "getPageList"
  | "preferencesManga"
  | "setPreferenceManga";

/** The runtime's own names, kept as they arrive so nothing is lost in translation. */
export interface DalvikSource {
  id: string;
  name: string;
  lang?: string;
  baseUrl?: string;
}

export interface DalvikManga {
  url: string;
  title?: string;
  artist?: string | null;
  author?: string | null;
  description?: string | null;
  genre?: string | null;
  status?: number | null;
  thumbnail_url?: string | null;
  initialized?: boolean;
}

export interface DalvikChapter {
  url: string;
  name: string;
  date_upload?: number;
  chapter_number?: number;
  scanlator?: string | null;
}

export interface DalvikPage {
  index: number;
  /** A bridge memo, not an image address. */
  url?: string;
  /** The address to load: the runtime's `/image/<uuid>` proxy. */
  imageUrl?: string;
  headers?: Record<string, string> | null;
}

export interface DalvikCall {
  method: DalvikMethod;
  /** Base64 APK bytes: installs (or re-installs) in the same request. */
  data?: string;
  /** The id the runtime handed back for an installed APK. */
  extensionId?: string;
  sourceId?: string;
  page?: number;
  search?: string;
  mangaData?: DalvikManga;
  chapterData?: DalvikChapter;
  filterList?: unknown[];
  preferences?: Array<Record<string, unknown>>;
  lang?: string;
  sourceBaseUrl?: string;
}

/**
 * What the app knows about the source's session, sent alongside a call.
 *
 * These are **request headers**, not body fields — M-Extension-Server reads them off the
 * `/dalvik` POST and applies them to the extension instance before the method runs (verified
 * against v1.0.9's `DalvikHandler.serve`):
 *
 * - `Cookie` → split on `;`, each pair becomes an `okhttp3.Cookie` on the source's own host and
 *   goes into that instance's `NetworkHelper` jar. This is the whole cookie hand-off: the runtime
 *   has no "here are my cookies" route, and its jar is memory-only, so the app re-sends this on
 *   every call.
 * - `User-Agent` → `NetworkHelper.setUA`, ignored when empty or when it starts with `Dart/`.
 *   Matrix row WEB-10: the runtime then looks like the webview that logged in.
 * - `source-base-url` → the source's site, when the extension declared one.
 * - `x-mangayomi-webview-port` → the port of the app's own webview bridge, so a challenge page the
 *   extension opens is rendered by us instead of the runtime's CEF.
 */
export interface DalvikAuth {
  /** A `Cookie:` header for the source's own site. */
  cookie?: string;
  /** The UA the webview used, so both ends present one identity. */
  userAgent?: string;
  /** The source's site; the runtime scopes cookies with its host. */
  sourceBaseUrl?: string;
  /** Loopback port of the app's webview bridge (`src/lib/webview/bridge.ts`). */
  webviewPort?: number;
}

export class DalvikError extends Error {
  readonly status: number;
  readonly runtimeCode: number | null;
  /**
   * The login page the source wants opened, when it names one.
   *
   * A WebView-login source answers 401 and the page to show; the app opens *that* page rather than
   * guessing `/login`. Absent means the caller falls back to the source's own base url.
   */
  readonly loginUrl: string | null;

  constructor(message: string, status: number, runtimeCode: number | null = null, loginUrl: string | null = null) {
    super(message);
    this.name = "DalvikError";
    this.status = status;
    this.runtimeCode = runtimeCode;
    this.loginUrl = loginUrl;
  }

  /** Whether this is the source saying "log in first" — matrix rows WEB-01 and WEB-09. */
  get needsLogin(): boolean {
    return this.status === 401 || this.runtimeCode === 401;
  }
}

export interface DalvikOptions {
  /** `http://127.0.0.1:<port>` — the bridge is loopback by design. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Rewrite the runtime's own `/image/`, `/video/` addresses onto this base whatever origin they
   * carry.
   *
   * True for a host on another machine: the PC's runtime mints `http://127.0.0.1:8792/image/abc`,
   * and `127.0.0.1` on the phone is the phone. The local client keeps the default, because there a
   * foreign origin in that shape really is a foreign host and must be left alone.
   */
  rewriteRuntimeAssets?: boolean;
  /**
   * The token for a host that wants one (the HT-Server), appended to asset URLs.
   *
   * A call can carry a header; an `<img src>` cannot, so the token has to ride in the query for
   * images and nothing else. Read per call so a re-pairing needs no rebuilt client.
   */
  token?: () => string;
}

export interface DalvikCallOptions {
  /** The session to carry on this call: cookies, UA, base url, webview bridge port. */
  auth?: DalvikAuth;
}

export interface DalvikResult<T> {
  body: T;
  /** Present when this call installed an APK; the key for every call after it. */
  extensionId: string | null;
  /** `Set-Cookie` values the host answered with, when it answered with any. */
  setCookie: string[];
}

/** What `/capabilities` answers. Only the field we rely on is required. */
export interface DalvikCapabilities {
  /** The `/dalvik` call surface itself — without it nothing else in this file works. */
  mangayomiMihonBridge: number;
  imageProxy?: boolean;
  extensionHandles?: boolean;
  [key: string]: unknown;
}

const EXTENSION_HEADER = "x-mangayomi-extension-id";
/**
 * The cookie header, sent twice.
 *
 * `Cookie` is a forbidden header for `fetch` in a browser tab — the browser drops it silently — so
 * the app's own proxy (`server/proxy.mjs`) promotes this private header onto the upstream request.
 * A packaged build talking to a loopback runtime sends both, and the runtime reads whichever
 * arrives (it checks `cookie` then `Cookie`). Two headers, one value, no build-specific branch.
 */
const COOKIE_HEADER = "x-hardlytracking-cookies";

/** A `DalvikAuth` as request headers. Absent fields are absent headers, never empty ones. */
export function authHeaders(auth: DalvikAuth | undefined): Record<string, string> {
  if (auth === undefined) return {};
  const headers: Record<string, string> = {};
  if (auth.cookie !== undefined && auth.cookie !== "") {
    headers["cookie"] = auth.cookie;
    headers[COOKIE_HEADER] = auth.cookie;
  }
  // Empty and `Dart/…` are ignored by the runtime anyway; not sending them keeps the intent clear.
  if (auth.userAgent !== undefined && auth.userAgent.trim() !== "") headers["user-agent"] = auth.userAgent.trim();
  if (auth.sourceBaseUrl !== undefined && auth.sourceBaseUrl !== "") headers["source-base-url"] = auth.sourceBaseUrl;
  if (auth.webviewPort !== undefined && auth.webviewPort > 0) headers["x-mangayomi-webview-port"] = String(auth.webviewPort);
  return headers;
}

/**
 * `Set-Cookie` off a response, as the individual values.
 *
 * `getSetCookie()` is the only lossless way (`headers.get` joins several cookies into one string,
 * and a cookie's `Expires` contains a comma, so splitting that string splits the wrong place). It
 * exists in Node 20+ and current browsers; where it does not, one header is taken whole rather
 * than mangled.
 */
function setCookieOf(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = response.headers.get("set-cookie");
  return single === null || single === "" ? [] : [single];
}

export class DalvikClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly token: (() => string) | undefined;
  private readonly rewriteRuntimeAssets: boolean;

  constructor(options: DalvikOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.rewriteRuntimeAssets = options.rewriteRuntimeAssets === true;
    // Never keep `window.fetch` itself: Chrome's is a method of `window`, and calling it
    // through a field throws "Illegal invocation" — in the browser only, so no unit test
    // catches it. Wrapping it keeps the receiver.
    this.fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /**
   * Ask the host what it can do, which is also the honest way to find out whether one is
   * there. A host that answers 200 with something else, or with a body that does not
   * advertise the bridge, is not a host we can register.
   */
  async capabilities(): Promise<DalvikCapabilities> {
    const controller = new AbortController();
    // A boot probe must not hang the app behind a dead port.
    const timer = setTimeout(() => controller.abort(), 4000);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/capabilities`, { signal: controller.signal, headers: apiHeaders() });
    } catch (error) {
      throw new DalvikError(`no extension host at ${this.baseUrl}: ${(error as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new DalvikError(`${this.baseUrl}/capabilities did not answer with JSON`, response.status);
    }
    const capabilities = body as DalvikCapabilities | null;
    if (!response.ok || capabilities === null || capabilities.mangayomiMihonBridge === undefined) {
      throw new DalvikError(`${this.baseUrl}/capabilities does not advertise the /dalvik bridge`, response.status);
    }
    return capabilities;
  }

  /**
   * One call, one body. Errors carry the runtime's own message, never a guess.
   *
   * `auth` is how a session travels: the runtime takes cookies, the user agent, the source's base
   * url and the app's webview bridge port as request headers on this call and nothing else.
   */
  async call<T = unknown>(call: DalvikCall, options: DalvikCallOptions = {}): Promise<DalvikResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/dalvik`, {
        method: "POST",
        headers: apiHeaders({ "content-type": "application/json", ...authHeaders(options.auth) }),
        body: JSON.stringify(call),
        signal: controller.signal,
      });
    } catch (error) {
      throw new DalvikError(`the extension host is not answering at ${this.baseUrl}: ${(error as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      throw new DalvikError(`the extension host answered ${response.status} with something that is not JSON`, response.status);
    }

    if (!response.ok) {
      const detail = body as { error?: string; code?: number; loginUrl?: string } | null;
      throw new DalvikError(
        detail?.error ?? `the extension host answered ${response.status}`,
        response.status,
        typeof detail?.code === "number" ? detail.code : null,
        typeof detail?.loginUrl === "string" && detail.loginUrl !== "" ? detail.loginUrl : null,
      );
    }

    return { body: body as T, extensionId: response.headers.get(EXTENSION_HEADER), setCookie: setCookieOf(response) };
  }

  /**
   * Install an APK by sending its bytes, and learn what it exposes in the same round trip.
   *
   * The extension id is the SHA-256 of the bytes, so the same APK always installs to the
   * same id and a client can remember it instead of resending megabytes on every call.
   */
  async install(apk: Uint8Array): Promise<{ extensionId: string; sources: DalvikSource[] }> {
    const result = await this.call<DalvikSource[]>({ method: "sourcesManga", data: base64(apk) });
    if (result.extensionId === null) {
      throw new DalvikError("the extension host accepted the APK but returned no extension id", 0);
    }
    return { extensionId: result.extensionId, sources: Array.isArray(result.body) ? result.body : [] };
  }

  /**
   * The source's settings screen, as data.
   *
   * The runtime builds it by running the extension's own `setupPreferenceScreen`, so this can fail
   * where every other call succeeds: some extension builds trip the runtime's bytecode verifier
   * while the screen is constructed. The error is the runtime's, and the caller decides what to
   * offer instead — it is never swallowed into an empty list, which would look like "no settings".
   */
  async preferences(extensionId: string, sourceId: string): Promise<unknown> {
    const result = await this.call<unknown>({ method: "preferencesManga", extensionId, sourceId });
    return result.body;
  }

  /**
   * `/image/<uuid>` is relative to the host that minted it; make it loadable.
   *
   * Two shapes arrive. A path (`/image/abc`) is joined to the base. A full address is what
   * this runtime actually mints (`http://127.0.0.1:8792/image/abc`) — and when the app is
   * served from another origin (the web build, `npm run dev`) that address is the runtime's
   * loopback, which a browser tab may not reach. So a full address on one of the runtime's
   * own proxy routes (`/image/`, `/video/`) is re-pointed onto this client's base, which is
   * the app's own `/api/dalvik` proxy when the base is relative: one origin, no CORS, no
   * second host in the page. Anything else absolute — a source's own CDN — is left alone,
   * because rewriting it onto our proxy would turn a working URL into a 404.
   */
  asset(url: string | null | undefined): string | undefined {
    if (url === null || url === undefined || url === "") return undefined;
    const address = this.joined(url);
    // An `<img>` cannot send a header, so a host that wants a token gets it in the query — and
    // only for this client's own addresses, never for a source's CDN.
    return address === undefined ? undefined : this.withToken(address);
  }

  private joined(url: string): string | undefined {
    if (/^https?:\/\//i.test(url)) {
      const path = pathOf(url);
      const origin = absoluteOrigin(this.baseUrl);
      const ownProxy = /^\/(image|video)\//.test(path);
      const mine = origin === null || url.startsWith(`${origin}/`);
      if (ownProxy && (mine || this.rewriteRuntimeAssets)) return `${this.baseUrl}${path}`;
      return url;
    }
    return `${this.baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
  }

  private withToken(address: string): string {
    const token = this.token?.() ?? "";
    if (token === "" || !address.startsWith(this.baseUrl)) return address;
    return `${address}${address.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
  }
}

/** `http://host:port` for an absolute base, `null` when the base is a proxy path. */
function absoluteOrigin(base: string): string | null {
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

/** `path?query` of an absolute URL, always starting with `/`. */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url.startsWith("/") ? url : `/${url}`;
  }
}

/**
 * A bare relative address belongs to the source's site, not to the host.
 *
 * Three shapes arrive and only one needs a base: a full URL is already an address; `/image/abc`
 * is the host's own proxy path (the thing `asset` re-points onto this client's base); and
 * `covers/3.png` is the *source's* own site, which only the extension's declared `baseUrl` can
 * resolve. Handing that last shape to `asset` joins it to the host and 404s — the fixture in
 * `tests/fixtures/dalvik-mock.mjs` mints exactly that shape for exactly this reason.
 */
function sourceRelative(sourceBaseUrl: string | undefined, raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(raw)) return null;
  if (sourceBaseUrl === undefined || sourceBaseUrl === "") return null;
  try {
    return new URL(raw, sourceBaseUrl.endsWith("/") ? sourceBaseUrl : `${sourceBaseUrl}/`).toString();
  } catch {
    return null;
  }
}

function base64(bytes: Uint8Array): string {
  // Node and the browser disagree about how to feed btoa, so go through Buffer where it exists.
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** An APK this device has installed, as the provider needs to know it. */
export interface InstalledExtension {
  extensionId: string;
  packageId: string;
  /** The extension's own name from the index — what a person calls it, not a package id. */
  name?: string;
  /** The index's icon, proxied like every other image so no host-specific rule leaks in. */
  iconUrl?: string;
  sources: DalvikSource[];
  /** Where it came from, so an update can find the same entry again. */
  repoUrl?: string;
  versionName?: string;
  versionCode?: number;
  /** Disabled extensions keep their APK and their sources but are not offered. */
  enabled?: boolean;
  /**
   * Ships inside the app: there is no APK to uninstall, only a switch. The provider is compiled in,
   * so the row exists to be seen and toggled, not to be installed.
   */
  builtin?: boolean;
  /**
   * The APK's own bytes, kept so the extension can be handed back to a runtime that forgot it.
   *
   * The runtime loads an APK into memory, keyed by its SHA-256, and never stores it: when the
   * process restarts, or its cache evicts the entry, every later call answers "Extension handle …
   * is no longer loaded; resend the APK". Without the bytes on this device that is an extension the
   * user has to reinstall after every restart of a container they never touched.
   */
  apk?: ArrayBuffer;
}

/**
 * The package id to remember an APK under, taken from the file it came from.
 *
 * The host cannot tell us: it has no extension-info route, and the only thing it answers
 * with is the sha256 handle. Repo indexes name every APK by its package id
 * (`eu.kanade.tachiyomi.extension.all.mangadex.apk`), so the file name is the best identity
 * available without unzipping the APK — and the sha256 id remains the real key.
 */
export function packageIdFromApkName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  const name = base.replace(/\.apk$/i, "").trim();
  return name === "" ? base : name;
}

export interface DalvikProviderOptions {
  client: DalvikClient;
  /**
   * Which provider this is, when it is not the local dalvik host.
   *
   * The HT-Server speaks the same `/dalvik` protocol as a local runtime, so it is the same provider
   * code — but the ids must not collide with the local host's: `dalvik:src:1` and `htserver:src:1`
   * are two different sources on two different machines.
   */
  kind?: ProviderKind;
  /** Read on every call, so an APK installed later needs no rebuilt provider. */
  extensions: InstalledExtension[];
  /** Titles seen this session, so a chapter call can name the manga it is about. */
  titles?: Map<string, string>;
  /**
   * Where a read mark lives for this host.
   *
   * The runtime has no read-state API at all, so `ownsProgress` is true and the mark is ours:
   * the provider asks this for the marks it draws and writes through it when the reader says
   * so. Without it the provider still refuses `setRead` by name rather than pretending —
   * a provider built on its own (a test, a build with no database) has nowhere to write.
   */
  readState?: DalvikReadState;
  /**
   * Where this device keeps the source's cookies.
   *
   * Read on **every** call, because the runtime's own jar is memory-only and has no read route: the
   * app is the store, and the `Cookie:` header is how the store reaches the extension. Without a
   * jar a source that needs a login simply answers 401 and the UI offers to log in.
   */
  cookies?: CookieJar;
  /** The UA the webview logged in with, so the runtime presents the same identity (WEB-10). */
  userAgent?: () => string | undefined;
  /** Loopback port of the app's webview bridge, for challenge pages the extension opens. */
  webviewPort?: () => number | undefined;
  /**
   * The source's saved settings, as the runtime applies them, read on every call.
   *
   * Read per call and not once, for the same reason cookies are: a user can open a source's
   * settings and change its address mid-session, and the next page must go to the new one.
   */
  preferences?: (sourceId: string) => Promise<Array<Record<string, unknown>> | undefined>;
  /**
   * Whether this provider may hand the runtime an APK it kept when the runtime forgot one.
   *
   * True for this device's own host: the bytes in the row are the bytes that host installed, so
   * resending them restores exactly what was there. **False for the HT-Server**: those rows are a
   * list the PC sent, they carry no bytes, and a phone that resent its own APK would install the
   * phone's extensions on the PC — the fault this provider exists to replace. The PC keeps its own
   * APKs and replays them itself (`server/host-extensions.mjs`).
   */
  apkResend?: boolean;
}

/** The device's own read marks, as the provider needs them. */
export interface DalvikReadState {
  /** Which of these chapter ids this device has marked read. */
  read(chapterIds: string[]): Promise<Set<string>>;
  mark(chapterId: string, read: boolean): Promise<void>;
}

/** `<sourceId>:<url>` — the native half of a series or chapter id. */
function splitNative(native: string): { sourceId: string; url: string } {
  const at = native.indexOf(":");
  if (at < 1) throw new Error(`not a dalvik id: ${native}`);
  return { sourceId: native.slice(0, at), url: native.slice(at + 1) };
}

/**
 * The bare source id the runtime expects.
 *
 * The UI hands us what `sources()` returned — `dalvik:src:<sourceId>` — while the runtime and
 * the extension's own source list use the bare `<sourceId>`. Accepting both is not leniency:
 * the namespaced form is what every call site in the app has, and the bare form is what the
 * protocol takes.
 *
 * The prefix is this provider's own kind, never a hardcoded `dalvik:`: the HT-Server speaks the same
 * protocol under `htserver:src:<sourceId>`, and a strip that only knows `dalvik:` leaves that id
 * namespaced, so the source is never found and every call rejects for the wrong reason.
 */
function bareSourceId(namespaced: string, kind: ProviderKind): string {
  const prefix = `${kind}:`;
  const native = namespaced.startsWith(prefix) ? nativeId(namespaced, kind) : namespaced;
  if (!native.includes(":")) return native;
  const stripped = native.startsWith("src:") ? native.slice("src:".length) : native;
  if (!stripped.includes(":")) return stripped;
  // Still namespaced, and not with this provider's own kind: it belongs to another host. `nativeId`
  // names the mismatch ("htserver:src:1 is not a dalvik id") instead of searching for a source id
  // that no extension here can have.
  return nativeId(native, kind);
}

/**
 * The provider. Ids stay in the app's namespaced form so a row from this host and a row
 * from Suwayomi or the device library can never collide — and the kind is `dalvik`, not
 * `mihon`, because both hosts would otherwise answer to the same prefix and the registry's
 * lookup would hand a dalvik id to Suwayomi:
 *
 *   source    dalvik:src:<sourceId>
 *   series    dalvik:<sourceId>:<manga url>
 *   chapter   dalvik:ch:<sourceId>:<chapter url>
 */
export function createDalvikProvider(options: DalvikProviderOptions): SourceProvider {
  const { client } = options;
  const titles = options.titles ?? new Map<string, string>();
  const kind: ProviderKind = options.kind ?? "dalvik";

  function extensionFor(namespaced: string): InstalledExtension {
    const sourceId = bareSourceId(namespaced, kind);
    const found = options.extensions.find((extension) => extension.sources.some((source) => source.id === sourceId));
    if (found === undefined) {
      // Named, not empty. A library row that came from a host while it was the app's origin is an id
      // this device may have no source for: answering with an empty chapter list would look like a
      // series with nothing in it, and answering with a provider's id would look like a broken app.
      throw new Error(
        `no installed extension on ${providerLabel(kind)} exposes source ${sourceId} — install or re-enable it there`,
      );
    }
    return found;
  }

  /** The source's own site, when the installed extension declared one. */
  function baseUrlForSourceId(sourceId: string): string | undefined {
    for (const extension of options.extensions) {
      const found = extension.sources.find((source) => source.id === sourceId);
      if (found !== undefined) return found.baseUrl;
    }
    return undefined;
  }

  /** The address to load for a minted image: the source's site first, the host's proxy second. */
  function imageAddress(sourceBaseUrl: string | undefined, raw: string | null | undefined): string | undefined {
    return client.asset(sourceRelative(sourceBaseUrl, raw) ?? raw);
  }

  /**
   * The session for one source, as the runtime wants it: a `Cookie:` header for the source's own
   * host, the webview's UA, the source's base url, and the app's bridge port.
   *
   * Read per call, not once: a login can happen mid-session, and a cookie can expire. The host is
   * the source's site — the runtime scopes what we send with that same host, so the two ends agree
   * on which jar the pairs belong in.
   */
  async function authFor(sourceBaseUrl: string | undefined): Promise<DalvikAuth> {
    const host = sourceBaseUrl === undefined ? null : hostOf(sourceBaseUrl);
    const cookie = host === null || options.cookies === undefined ? undefined : await options.cookies.header(host);
    const userAgent = options.userAgent?.();
    const webviewPort = options.webviewPort?.();
    return {
      ...(cookie === undefined ? {} : { cookie }),
      ...(userAgent === undefined ? {} : { userAgent }),
      ...(sourceBaseUrl === undefined ? {} : { sourceBaseUrl }),
      ...(webviewPort === undefined ? {} : { webviewPort }),
    };
  }

  /**
   * One call with the source's session attached, and whatever cookies the host answers with kept.
   *
   * Every method below goes through here, which is what makes "cookie sharing" a property of the
   * provider instead of something each call site has to remember to do.
   */
  async function invoke<T>(call: DalvikCall, sourceBaseUrl: string | undefined): Promise<DalvikResult<T>> {
    const auth = await authFor(sourceBaseUrl);
    const settings =
      options.preferences === undefined || call.sourceId === undefined
        ? undefined
        : await options.preferences(call.sourceId);
    const body = settings === undefined || settings.length === 0 ? call : { ...call, preferences: settings };
    let result: DalvikResult<T>;
    try {
      result = await client.call<T>(body, { auth });
    } catch (error) {
      const retry = apkForRetry(call, error);
      if (retry === undefined) throw error;
      // The runtime forgot this extension (it keeps APKs in memory, keyed by their hash). Hand it
      // the bytes we kept, once: a second failure is a real failure and belongs to the caller.
      result = await client.call<T>({ ...body, data: retry }, { auth });
    }
    if (result.setCookie.length > 0 && options.cookies !== undefined) {
      const host = sourceBaseUrl === undefined ? null : hostOf(sourceBaseUrl);
      if (host !== null) await options.cookies.remember(host, result.setCookie);
    }
    return result;
  }

  /**
   * The APK bytes for a call the runtime refused because it no longer holds that extension.
   *
   * Only that one message earns a retry. A 401, a timeout or a source that moved is the caller's
   * answer and must not be retried — resending megabytes on every failure would hide the real error.
   */
  function apkForRetry(call: DalvikCall, error: unknown): string | undefined {
    if (options.apkResend === false) return undefined;
    if (!(error instanceof DalvikError)) return undefined;
    if (!/no longer loaded|resend the apk/i.test(error.message)) return undefined;
    if (call.extensionId === undefined) return undefined;
    const row = options.extensions.find((extension) => extension.extensionId === call.extensionId);
    if (row?.apk === undefined) return undefined;
    return base64(new Uint8Array(row.apk));
  }

  function toSeries(sourceId: string, manga: DalvikManga, sourceBaseUrl?: string): Series {
    const id = joinId(kind, `${sourceId}:${manga.url}`);
    if (typeof manga.title === "string" && manga.title !== "") titles.set(id, manga.title);
    return {
      id,
      provider: kind,
      title: manga.title ?? titles.get(id) ?? "",
      ...(imageAddress(sourceBaseUrl, manga.thumbnail_url) === undefined
        ? {}
        : { cover: imageAddress(sourceBaseUrl, manga.thumbnail_url) }),
      ...(typeof manga.author === "string" ? { author: manga.author } : {}),
      ...(typeof manga.description === "string" ? { description: manga.description } : {}),
    };
  }

  /** The runtime needs the manga's url to answer; the title only improves its cache key. */
  function mangaDataFor(seriesId: string): DalvikManga {
    const { url } = splitNative(nativeId(seriesId, kind));
    const title = titles.get(seriesId);
    return { url, initialized: true, ...(title === undefined ? {} : { title }) };
  }

  /** The forms read for this session, keyed by bare source id. Empty is a real answer. */
  const forms = new Map<string, SourceFilter[]>();

  /**
   * The host's filter form, read once and remembered.
   *
   * A search that carries choices needs the *names* those choices belong to, and the UI has already
   * asked for the form when it drew the sheet — so a remembered answer is the one the user is
   * looking at, not a second take on it.
   */
  async function formFor(sourceId: string): Promise<SourceFilter[]> {
    const remembered = forms.get(sourceId);
    return remembered ?? readFilters(sourceId);
  }

  /**
   * `filtersManga`, as the sheet's list.
   *
   * The host answers the extension's own objects, untyped and group-shaped (`dalvikFilters`
   * normalises them); a source with no filters answers `[]`, which is the same answer as "nothing to
   * show" and draws no Filters button. The empty answer is remembered too, so a source that has none
   * is not asked again on every search.
   */
  async function readFilters(sourceId: string): Promise<SourceFilter[]> {
    const extension = extensionFor(sourceId);
    const result = await invoke<DalvikRawFilter[]>(
      { method: "filtersManga", extensionId: extension.extensionId, sourceId },
      baseUrlForSourceId(sourceId),
    );
    const rows = mapFilters(dalvikFilters(Array.isArray(result.body) ? result.body : []));
    forms.set(sourceId, rows);
    return rows;
  }

  function toChapter(sourceId: string, chapter: DalvikChapter): Chapter {
    const number = typeof chapter.chapter_number === "number" && chapter.chapter_number > 0 ? chapter.chapter_number : 0;
    return {
      id: joinId(kind, `ch:${sourceId}:${chapter.url}`),
      seriesId: "",
      name: chapter.name,
      number,
      pageCount: 0,
      read: false,
      ...(typeof chapter.date_upload === "number" && chapter.date_upload > 0 ? { uploadedAt: chapter.date_upload } : {}),
    };
  }

  return {
    kind,
    /**
     * Our database is the only place a read mark can live for this host: the runtime has
     * no read-state API, so `setRead` refuses rather than pretending to write somewhere.
     */
    ownsProgress: true,

    async sources(): Promise<Source[]> {
      // A disabled extension keeps its APK and its row, but offers no sources: that is what
      // disabling means, and it has to happen here or the chips never disappear.
      return options.extensions.filter((extension) => extension.enabled !== false).flatMap((extension) =>
        extension.sources.map((source) => ({
          id: joinId(kind, `src:${source.id}`),
          provider: kind,
          name: source.name,
          ...(source.lang === undefined ? {} : { lang: source.lang }),
          // The site the extension reads, so a pasted link can be matched to it by host.
          ...(source.baseUrl === undefined || source.baseUrl === "" ? {} : { baseUrl: source.baseUrl }),
        })),
      );
    },

    async popular(namespaced: string, page: number): Promise<Paged<Series>> {
      const sourceId = bareSourceId(namespaced, kind);
      const extension = extensionFor(sourceId);
      const sourceBaseUrl = baseUrlForSourceId(sourceId);
      const result = await invoke<{ mangas: DalvikManga[]; hasNextPage: boolean }>(
        { method: "getPopularManga", extensionId: extension.extensionId, sourceId, page },
        sourceBaseUrl,
      );
      return paged(
        (result.body.mangas ?? []).map((manga) => toSeries(sourceId, manga, sourceBaseUrl)),
        result.body.hasNextPage === true,
      );
    },

    async latest(namespaced: string, page: number): Promise<Paged<Series>> {
      const sourceId = bareSourceId(namespaced, kind);
      const extension = extensionFor(sourceId);
      const sourceBaseUrl = baseUrlForSourceId(sourceId);
      const result = await invoke<{ mangas: DalvikManga[]; hasNextPage: boolean }>(
        { method: "getLatestManga", extensionId: extension.extensionId, sourceId, page },
        sourceBaseUrl,
      );
      return paged(
        (result.body.mangas ?? []).map((manga) => toSeries(sourceId, manga, sourceBaseUrl)),
        result.body.hasNextPage === true,
      );
    },

    async search(namespaced: string, query: string, page: number, filters?: SourceFilterSelection): Promise<Paged<Series>> {
      const sourceId = bareSourceId(namespaced, kind);
      const extension = extensionFor(sourceId);
      const sourceBaseUrl = baseUrlForSourceId(sourceId);
      // The host matches a change by **name**, so the stored selection (which is keyed by position,
      // like every provider's) is resolved here against the form this client read for the source. No
      // changes means no `filterList` at all: the source's own defaults are then exactly what it gets.
      const changes = filters === undefined ? [] : dalvikChanges(await formFor(sourceId), filters);
      const result = await invoke<{ mangas: DalvikManga[]; hasNextPage: boolean }>(
        {
          method: "getSearchManga",
          extensionId: extension.extensionId,
          sourceId,
          page,
          search: query,
          ...(changes.length === 0 ? {} : { filterList: changes }),
        },
        sourceBaseUrl,
      );
      return paged(
        (result.body.mangas ?? []).map((manga) => toSeries(sourceId, manga, sourceBaseUrl)),
        result.body.hasNextPage === true,
      );
    },

    /**
     * The source's own form, or an empty list.
     *
     * The host answers `filtersManga` with a serialisation of the extension's Java filter objects —
     * untyped, group-shaped, with the extension's own fields mixed in. `dalvikFilters` turns that
     * into the same normalised list the Suwayomi path reads, so `mapFilters` stays the only mapper
     * and the sheet draws a dalvik source exactly like any other.
     *
     * The answer is kept for this session: a search needs the *names* to send a choice back, and
     * asking the host twice for a form the UI already asked for would cost a round trip per search.
     */
    async filters(namespaced: string): Promise<SourceFilter[]> {
      return readFilters(bareSourceId(namespaced, kind));
    },

    async details(seriesId: string): Promise<Series> {
      const { sourceId, url } = splitNative(nativeId(seriesId, kind));
      const extension = extensionFor(sourceId);
      const sourceBaseUrl = baseUrlForSourceId(sourceId);
      const result = await invoke<DalvikManga>(
        { method: "getDetailsManga", extensionId: extension.extensionId, sourceId, mangaData: { url, initialized: true } },
        sourceBaseUrl,
      );
      return toSeries(sourceId, result.body, sourceBaseUrl);
    },

    async chapters(seriesId: string): Promise<Chapter[]> {
      const { sourceId } = splitNative(nativeId(seriesId, kind));
      const extension = extensionFor(sourceId);
      const result = await invoke<DalvikChapter[]>(
        { method: "getChapterList", extensionId: extension.extensionId, sourceId, mangaData: mangaDataFor(seriesId) },
        baseUrlForSourceId(sourceId),
      );
      const rows = (Array.isArray(result.body) ? result.body : []).map((chapter) => ({
        ...toChapter(sourceId, chapter),
        seriesId,
      }));
      // The runtime answers with no read state (it has none), so the marks we draw are the
      // ones this device wrote. One bulk read, because a long series is hundreds of ids.
      if (options.readState === undefined) return rows;
      const read = await options.readState.read(rows.map((row) => row.id));
      return rows.map((row) => (read.has(row.id) ? { ...row, read: true } : row));
    },

    async pages(chapterId: string): Promise<Page[]> {
      const { sourceId, url } = splitNative(nativeId(chapterId, kind).replace(/^ch:/, ""));
      const extension = extensionFor(sourceId);
      const sourceBaseUrl = baseUrlForSourceId(sourceId);
      const result = await invoke<DalvikPage[]>(
        { method: "getPageList", extensionId: extension.extensionId, sourceId, chapterData: { url, name: "" } },
        sourceBaseUrl,
      );
      const pages = Array.isArray(result.body) ? result.body : [];
      return pages.map((page, index) => {
        const address = imageAddress(sourceBaseUrl, page.imageUrl) ?? client.asset(page.url);
        if (address === undefined) {
          throw new DalvikError(`page ${index} came back without an image address`, 0);
        }
        const headers = page.headers !== null && typeof page.headers === "object" ? page.headers : undefined;
        return {
          index: typeof page.index === "number" ? page.index : index,
          url: address,
          ...(headers === undefined || Object.keys(headers).length === 0 ? {} : { headers }),
        };
      });
    },

    async setRead(chapterId: string, read: boolean): Promise<void> {
      // The runtime has no read-state API: there is nothing on the host to write to. The
      // mark goes in our database through `readState` when one was supplied, and a provider
      // with nowhere to write says so by name instead of resolving as if it had.
      if (options.readState === undefined) {
        throw new Error(
          `this host has no read-state API, so it cannot set ${chapterId} to read=${String(read)}; read marks live in our database`,
        );
      }
      await options.readState.mark(chapterId, read);
    },
  };
}

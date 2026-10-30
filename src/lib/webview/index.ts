/**
 * The WebView seam: the one place that opens a page in a real browser and comes back with cookies.
 *
 * A login page (InfinityScans) and a challenge page (Comix, Scythe Scans) are the same job from
 * here: show the site's own page in a webview the person can type into and click, then hand back
 * the cookies it set. Everything above this file — `src/api/mihon-bridge.ts` — only decides *when*
 * to ask and what to do with the answer.
 *
 * Three platforms, three answers:
 *
 * | build | what happens |
 * |---|---|
 * | desktop, `__TAURI_INTERNALS__` | `invoke("webview_login", { url, title })` |
 * | iOS/Android shell (Capacitor) | the native `WebviewLogin` plugin's `open({ url, title })` |
 * | browser tab | nothing — reported as `unsupported`, never as success |
 *
 * The browser case is not a stub: a browser tab cannot open a webview it controls, and pretending
 * otherwise would hand the caller a "logged in" with no cookies in it (matrix row WEB-07 says a
 * cancelled or impossible login must leave no bogus authenticated state). The caller reads
 * `status` and says so in the UI.
 *
 * **What the native side must answer** (this is the contract the shells implement, and it is why
 * the seam is worth having before the shells exist):
 *
 *   webview_login({ url, title?, headers?, postData? }) ->
 *     { cookies: string[],          // each a `Set-Cookie` value: "name=value; Path=/; HttpOnly"
 *       url?: string,               // the last address it was on
 *       userAgent?: string,         // the webview's UA, for matrix row WEB-10
 *       cancelled?: boolean }       // closed without finishing (no cookies is not "cancelled")
 *
 * The desktop jar and the iOS integration arrive with the shells (T6, T12); the seam, the cookie
 * rules and the hand-off to the runtime are testable today with a driver a test supplies, which is
 * exactly what `tests/unit/cookies.test.mjs` does.
 */
import { domainMatches, hostOf, parseSetCookie, type StoredCookie } from "./cookies";

export type WebviewPlatform = "tauri" | "capacitor" | "browser";

/** What to open, and which hosts the cookies belong to. */
export interface LoginPage {
  url: string;
  title?: string;
  /**
   * Hosts the cookies may be scoped to. A page that logs in at `toonily.com` and sets a cookie for
   * `.toonily.com` is the same jar; a cookie whose domain is nowhere near these is dropped, so a
   * third-party iframe cannot plant a session on another source's host.
   */
  hosts: string[];
  /**
   * Headers the page must be loaded with, when the runtime asked for specific ones.
   *
   * A challenge page is opened *by the extension*, so it expects the extension's own `Referer` or
   * UA; a webview that loads the bare url instead can fail a check the extension would have passed.
   */
  headers?: Record<string, string>;
  /** A form body for a page that is reached by POST, as the runtime's `postData` describes it. */
  postData?: string;
}

/** What a webview answers when it closes. */
export interface WebviewResult {
  /** `Set-Cookie` values, in the order the page set them. */
  setCookie: string[];
  /** Where it ended up; the login page often redirects. */
  url?: string;
  /** The webview's own user agent — the runtime adopts it, so both ends look like one client. */
  userAgent?: string;
}

export interface WebviewDriver {
  readonly platform: WebviewPlatform;
  /**
   * Open the page and resolve when it closes. `null` means the person closed it without finishing
   * — cancelled is not an error and must not be turned into one, because the UI has to say
   * "cancelled" rather than "failed" (matrix row WEB-07).
   */
  open(page: LoginPage): Promise<WebviewResult | null>;
}

export type LoginOutcome =
  | { status: "ok"; platform: WebviewPlatform; cookies: StoredCookie[]; userAgent?: string; url?: string }
  | { status: "cancelled"; platform: WebviewPlatform }
  | { status: "unsupported"; platform: WebviewPlatform; reason: string }
  | { status: "failed"; platform: WebviewPlatform; reason: string };

/** Which shell this build is running in. Read from the globals the shells themselves set. */
export function detectPlatform(): WebviewPlatform {
  const scope = globalThis as Record<string, unknown>;
  if ("__TAURI_INTERNALS__" in scope) return "tauri";
  const capacitor = scope["Capacitor"] as { isNativePlatform?: () => boolean } | undefined;
  if (capacitor !== undefined && typeof capacitor.isNativePlatform === "function" && capacitor.isNativePlatform()) {
    return "capacitor";
  }
  return "browser";
}

/** The native login page, as both shells answer it. */
interface NativeLoginAnswer {
  cookies?: string[];
  url?: string;
  userAgent?: string;
  cancelled?: boolean;
}

/**
 * The desktop driver: a Tauri command that shows a window with the page in it.
 *
 * `@tauri-apps/api` is imported lazily so a browser build never evaluates it, and so a missing
 * command surfaces as the error it is instead of a bundling failure.
 */
function tauriDriver(): WebviewDriver {
  return {
    platform: "tauri",
    async open(page: LoginPage) {
      const { invoke } = await import("@tauri-apps/api/core");
      const answer = (await invoke("webview_login", {
        url: page.url,
        ...(page.title === undefined ? {} : { title: page.title }),
        ...(page.headers === undefined ? {} : { headers: page.headers }),
        ...(page.postData === undefined ? {} : { postData: page.postData }),
      })) as NativeLoginAnswer;
      return answerFromNative(answer);
    },
  };
}

/**
 * The phone driver: a Capacitor plugin the iOS shell registers as `WebviewLogin`.
 *
 * A `WKWebView` in the app's own process is the only way cookies survive into the app: Safari and
 * `ASWebAuthenticationSession` keep their own store, which is why the matrix hard gate refuses an
 * authentication that needs Safari.
 */
function capacitorDriver(): WebviewDriver {
  return {
    platform: "capacitor",
    async open(page: LoginPage) {
      const { registerPlugin } = await import("@capacitor/core");
      const plugin = registerPlugin<{ open(page: { url: string; title?: string }): Promise<NativeLoginAnswer> }>(
        "WebviewLogin",
      );
      const answer = await plugin.open({
        url: page.url,
        ...(page.title === undefined ? {} : { title: page.title }),
        ...(page.headers === undefined ? {} : { headers: page.headers }),
        ...(page.postData === undefined ? {} : { postData: page.postData }),
      });
      return answerFromNative(answer);
    },
  };
}

/**
 * The browser driver: it cannot open a webview, so it says so.
 *
 * Throwing would be read as a bug in the app; a result with `status: "unsupported"` is a fact the
 * UI can print. `open` still resolves to `null` because no page was ever opened.
 */
function browserDriver(): WebviewDriver {
  return {
    platform: "browser",
    async open() {
      return null;
    },
  };
}

/** The driver for this build. */
export function webviewDriver(platform: WebviewPlatform = detectPlatform()): WebviewDriver {
  if (platform === "tauri") return tauriDriver();
  if (platform === "capacitor") return capacitorDriver();
  return browserDriver();
}

function answerFromNative(answer: NativeLoginAnswer | null | undefined): WebviewResult | null {
  if (answer === null || answer === undefined || answer.cancelled === true) return null;
  return {
    setCookie: Array.isArray(answer.cookies) ? answer.cookies.filter((raw) => typeof raw === "string") : [],
    ...(typeof answer.url === "string" ? { url: answer.url } : {}),
    ...(typeof answer.userAgent === "string" && answer.userAgent !== "" ? { userAgent: answer.userAgent } : {}),
  };
}

/**
 * Open a login page and turn what it set into cookies this device can store.
 *
 * Nothing is stored here — the caller owns the jar, so it can decide whether a rejected login
 * should keep its cookies (it should: the site may have set an anti-bot cookie that the next
 * attempt needs).
 */
export async function loginInWebview(page: LoginPage, driver: WebviewDriver = webviewDriver()): Promise<LoginOutcome> {
  if (driver.platform === "browser") {
    return {
      status: "unsupported",
      platform: "browser",
      reason: "this build runs in a browser tab, which cannot open an in-app webview — open the packaged app to log in",
    };
  }

  let result: WebviewResult | null;
  try {
    result = await driver.open(page);
  } catch (error) {
    return { status: "failed", platform: driver.platform, reason: error instanceof Error ? error.message : String(error) };
  }
  if (result === null) return { status: "cancelled", platform: driver.platform };

  const hosts = new Set(page.hosts.map((host) => hostOf(host) ?? "").filter((host) => host !== ""));
  // A cookie's own `Domain=` wins; a cookie that names none belongs to the page. Either way it has
  // to be a cookie *this host may send* — `domainMatches` is the same rule the jar uses when it
  // builds the header, so a cookie stored here is always one the next call would actually carry.
  // A cookie for a narrower host than the page (`cdn.toonily.com` set on `toonily.com`) is refused,
  // which is what a browser does too.
  const cookies = result.setCookie
    .map((raw) => parseSetCookie(raw, hostOf(result.url ?? page.url) ?? ""))
    .filter((cookie): cookie is StoredCookie => cookie !== null)
    .filter((cookie) => [...hosts].some((host) => domainMatches(cookie.domain, host)));

  return {
    status: "ok",
    platform: driver.platform,
    cookies,
    ...(result.userAgent === undefined ? {} : { userAgent: result.userAgent }),
    ...(result.url === undefined ? {} : { url: result.url }),
  };
}

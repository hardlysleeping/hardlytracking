/**
 * Login, end to end: the source says 401, we open its page, and the runtime's next call is signed in.
 *
 * The three pieces already exist and this is the seam that joins them:
 *
 *   `src/lib/webview/*`   opens the page in a real webview and returns its cookies
 *   `src/lib/webview/store.ts`  keeps those cookies for this device
 *   `src/api/dalvik.ts`   sends them as the `Cookie:` header on every `/dalvik` call
 *
 * What is left, and what this file is, is the *order*: which page to open, what counts as success,
 * and what to do when the site says no. Two rules make it honest:
 *
 * 1. **Success is a call that was refused and now answers.** Not "the webview closed" and not
 *    "there are cookies in the jar" — a source that hands back a session cookie for a page you
 *    are still logged out of is exactly the silent failure matrix row WEB-09 is about.
 * 2. **A cancelled login writes nothing.** Closing the page is not an error and not a success; it
 *    is `cancelled`, and the UI says so (matrix row WEB-07).
 *
 * The cookies are kept even when the verification fails: a challenge site usually sets its
 * anti-bot cookie *before* the page you log in on, and throwing those away makes the second
 * attempt start from scratch.
 */
import type { DalvikClient, InstalledExtension } from "./dalvik";
import { DalvikError } from "./dalvik";
import { hostOf } from "../lib/webview/cookies";
import { loginInWebview, webviewDriver, type WebviewDriver } from "../lib/webview/index";
import type { CookieJar } from "../lib/webview/store";
import { consentQuestion } from "../lib/webview/consent";

/** The source that wants a login, and where its site is. */
export interface LoginTarget {
  /** The extension's own source id, bare (`1234567890`) or namespaced (`dalvik:src:…`). */
  sourceId: string;
  /** The source's own site, from the installed extension's source list. */
  baseUrl: string;
  /** What the window is called. The source's name, when the caller knows it. */
  title?: string;
  /** The page the source asked for, from a 401 body. Absent = its own base url. */
  loginUrl?: string | null;
}

/**
 * Where the answer to "may this source use cookies for its domain?" comes from.
 *
 * Supplied by the profile, which owns the store. A build that passes nothing is a build with no
 * consent gate — only a test should be in that position, and the parameter being optional is what
 * lets those tests stay one line shorter.
 */
export interface LoginConsent {
  /** Async because a grant is a stored preference, not a field on this object. */
  isGranted(sourceId: string, domain: string): boolean | Promise<boolean>;
  grant(sourceId: string, domain: string): void | Promise<void>;
}

export interface LoginDeps {
  client: DalvikClient;
  /** The installed extensions, so the source's extension id can be found. */
  extensions: InstalledExtension[];
  jar: CookieJar;
  /** The webview to use. A test supplies a fake; a build uses its platform's. */
  driver?: WebviewDriver;
  /** Ask before a source is handed a cookie jar. Omitted by tests that are not about consent. */
  consent?: LoginConsent;
  /**
   * The call that proves the login took. Defaults to the source's popular page, which is what the
   * UI was showing when it hit the 401.
   */
  verify?: (sourceId: string) => Promise<void>;
}

export type LoginResult =
  /** A call that was refused now answers. `cookies` is how many this device holds for the host. */
  | { status: "ok"; sourceId: string; cookies: number; platform: string; userAgent?: string }
  /** The person closed the page. Nothing was written. */
  | { status: "cancelled"; sourceId: string; platform: string }
  /** This build has no in-app webview (a browser tab). Nothing was written. */
  | { status: "unsupported"; sourceId: string; reason: string }
  /** The webview itself failed to open. Nothing was written. */
  | { status: "failed"; sourceId: string; reason: string }
  /** Cookies were stored but the source still refuses: the login did not take. */
  | { status: "rejected"; sourceId: string; cookies: number; reason: string }
  /**
   * Nothing was opened and nothing was stored: this source has not been allowed to use cookies for
   * this domain yet. The caller asks, then calls again.
   */
  | { status: "consent"; sourceId: string; host: string; question: string };

/** Whether a thrown error is the source asking to be logged into. */
export function needsLogin(error: unknown): error is DalvikError {
  return error instanceof DalvikError && error.needsLogin;
}

/**
 * The page to open.
 *
 * A source that names one wins (`loginUrl` off the 401 body). Otherwise its own base url, not a
 * guessed `/login`: every site puts its sign-in somewhere different, and a 404 in a webview looks
 * to the person like the app is broken. The base url at least lands on the site, where the sign-in
 * link is.
 */
export function loginUrlFor(target: LoginTarget): string {
  const asked = target.loginUrl ?? null;
  if (asked !== null && asked !== "") {
    try {
      return new URL(asked, target.baseUrl.endsWith("/") ? target.baseUrl : `${target.baseUrl}/`).toString();
    } catch {
      return target.baseUrl;
    }
  }
  return target.baseUrl;
}

/** The bare source id: `dalvik:src:123` and `123` both name the same source. */
function bareSourceId(sourceId: string): string {
  const native = sourceId.startsWith("dalvik:") ? sourceId.slice("dalvik:".length) : sourceId;
  return native.startsWith("src:") ? native.slice("src:".length) : native;
}

/**
 * Log a source in: open its page, keep what it set, and prove the runtime is now authenticated.
 *
 * Throws only for a caller's mistake (a source the installed extensions do not expose); every
 * outcome of the login itself is a value, so a screen can render it without a try/catch.
 */
export async function loginSource(target: LoginTarget, deps: LoginDeps): Promise<LoginResult> {
  const sourceId = bareSourceId(target.sourceId);
  const extension = deps.extensions.find((row) => row.sources.some((source) => source.id === sourceId));
  if (extension === undefined) {
    throw new Error(`no installed extension exposes source ${sourceId} — install or re-enable it`);
  }
  const host = hostOf(target.baseUrl);
  if (host === null) throw new Error(`source ${sourceId} has no site address to log in at`);

  // The question comes before the page, not after it: opening the site in a webview that is about to
  // receive its cookies is the moment the permission is being used, so it is the moment to ask.
  if (deps.consent !== undefined && !(await deps.consent.isGranted(sourceId, host))) {
    return { status: "consent", sourceId, host, question: consentQuestion(host) };
  }

  const driver = deps.driver ?? webviewDriver();
  const outcome = await loginInWebview({ url: loginUrlFor(target), hosts: [host], ...(target.title === undefined ? {} : { title: target.title }) }, driver);

  if (outcome.status === "cancelled") return { status: "cancelled", sourceId, platform: outcome.platform };
  if (outcome.status === "unsupported") return { status: "unsupported", sourceId, reason: outcome.reason };
  if (outcome.status === "failed") return { status: "failed", sourceId, reason: outcome.reason };

  const setCookie = outcome.cookies.map((cookie) => `${cookie.name}=${cookie.value}`);
  const stored = await deps.jar.remember(host, setCookie);
  // The UA is remembered by the provider's `userAgent` seam (the webview's own string), not here:
  // this file must not become a second place a session is configured from.

  const verify =
    deps.verify ??
    (async (id: string) => {
      const cookie = await deps.jar.header(host);
      await deps.client.call(
        { method: "getPopularManga", extensionId: extension.extensionId, sourceId: id, page: 1 },
        { auth: { ...(cookie === undefined ? {} : { cookie }), sourceBaseUrl: target.baseUrl } },
      );
    });

  try {
    await verify(sourceId);
  } catch (error) {
    if (needsLogin(error)) {
      return { status: "rejected", sourceId, cookies: stored, reason: error.message };
    }
    // A different failure is not proof either way: the site may be down, or the source may need
    // its own preferences. Say that instead of claiming a login we did not see work.
    return { status: "rejected", sourceId, cookies: stored, reason: error instanceof Error ? error.message : String(error) };
  }

  return {
    status: "ok",
    sourceId,
    cookies: stored,
    platform: outcome.platform,
    ...(outcome.userAgent === undefined ? {} : { userAgent: outcome.userAgent }),
  };
}

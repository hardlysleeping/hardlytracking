/**
 * The other direction of the seam: the runtime asking *us* for a page.
 *
 * When an extension drives `android.webkit.WebView` itself — a Cloudflare-style challenge, a
 * "click to continue" wall (Comix, Scythe Scans) — M-Extension-Server does not render it. It calls
 * out to the app that made the last `/dalvik` request, on the port it was told in
 * `x-mangayomi-webview-port`, and waits for the cookies. Verified against v1.0.9's bytecode
 * (`KcefWebViewProvider`), the two routes and their bodies are:
 *
 *   POST http://127.0.0.1:<port>/bridge_webview
 *     { url, headers?: {…}, postData?, scripts?: string[], time?: seconds }
 *     -> { cookies: string[] }          // each a `Set-Cookie` value
 *
 *   POST http://127.0.0.1:<port>/evaluateJavascriptViaWebview
 *     { url, scripts: string[], time: seconds }
 *     -> { result: string }             // what the last script evaluated to
 *
 * This file is the handler for both. It is deliberately a plain function over a request body: the
 * native shell owns the socket (a loopback listener on the phone, a command on the desktop) and
 * this owns the meaning, so the contract is tested without a device.
 *
 * A build with no listener simply never sends `x-mangayomi-webview-port`, and the runtime falls
 * back to its own embedded CEF webview — which is why the desktop build works today with nothing
 * here wired up.
 */
import { hostOf } from "./cookies";
import type { WebviewDriver } from "./index";

/** One request as the runtime sends it. Every field but `url` is optional in the runtime's own code. */
export interface BridgeRequest {
  url: string;
  headers?: Record<string, string>;
  postData?: string;
  scripts?: string[];
  /** Seconds the page may take. The runtime sends 10 for a JS evaluation. */
  time?: number;
}

export interface BridgeAnswer {
  status: number;
  body: Record<string, unknown>;
}

/** The route names, in one place — the native listener matches on these. */
export const BRIDGE_WEBVIEW_PATH = "/bridge_webview";
export const BRIDGE_JAVASCRIPT_PATH = "/evaluateJavascriptViaWebview";

/** A driver that can also evaluate a script — what a challenge page needs beyond cookies. */
export interface ScriptableDriver extends WebviewDriver {
  evaluate?(page: { url: string; hosts: string[]; scripts: string[] }, timeoutSeconds: number): Promise<string | null>;
}

/**
 * Answer one bridge request.
 *
 * A cancelled page answers `{ cookies: [] }` rather than an error: the runtime treats that as "the
 * person did not finish" and the extension asks again later, which is the behaviour we want
 * (matrix row WEB-07 — no bogus authenticated state, and no failed call either).
 */
export async function handleBridgeRequest(
  path: string,
  rawBody: string,
  driver: ScriptableDriver,
): Promise<BridgeAnswer> {
  const route = path.split("?")[0]?.replace(/\/+$/, "") ?? "";
  if (route !== BRIDGE_WEBVIEW_PATH && route !== BRIDGE_JAVASCRIPT_PATH) {
    return { status: 404, body: { error: `no bridge route at ${route}` } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "the bridge body is not JSON" } };
  }
  const request = parsed as Partial<BridgeRequest> | null;
  if (request === null || typeof request.url !== "string" || request.url === "") {
    return { status: 400, body: { error: "the bridge body has no url" } };
  }
  const host = hostOf(request.url);
  if (host === null) return { status: 400, body: { error: `not a page address: ${request.url}` } };

  const scripts = Array.isArray(request.scripts) ? request.scripts.filter((script) => typeof script === "string") : [];
  const timeoutSeconds = typeof request.time === "number" && request.time > 0 ? request.time : 10;
  const page = {
    url: request.url,
    hosts: [host],
    ...(request.headers === undefined ? {} : { headers: request.headers }),
    ...(request.postData === undefined ? {} : { postData: request.postData }),
  };

  if (route === BRIDGE_JAVASCRIPT_PATH) {
    if (driver.evaluate === undefined) {
      return { status: 501, body: { error: `the ${driver.platform} shell cannot evaluate scripts in a webview` } };
    }
    const result = await driver.evaluate({ ...page, scripts }, timeoutSeconds);
    return { status: 200, body: { result: result ?? "" } };
  }

  const opened = await driver.open(page);
  if (opened === null) return { status: 200, body: { cookies: [] } };

  // The runtime hands these straight to its Android `CookieManager`, which wants `Set-Cookie`
  // values, not a header. So what the webview reported is passed through unchanged.
  return { status: 200, body: { cookies: opened.setCookie } };
}

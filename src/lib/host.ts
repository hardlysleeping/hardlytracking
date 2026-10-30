/**
 * Where the runtime lives, and the token that opens it.
 *
 * Normally this is the app's own origin: `/api/dalvik`, `/api/repo`, `/api/img` are paths on
 * whatever server served the page. That is the phone-standalone case and the local desktop case.
 *
 * The third case is the one the plan asks for: **the desktop app is the server, and the phone is a
 * client of it.** The phone loads this same build from `http://desktop:8460/`, so it is still one
 * origin — but a PWA installed from somewhere else (a hosted build, a second port) can point at a
 * desktop with `hardlytracking.host`, and then every API call is absolute.
 *
 * The token travels in a header for `fetch` and in the query for an `<img>` (an image request cannot
 * carry a header). It is kept in `localStorage` rather than the database because it is needed before
 * the database opens, and it is not part of a backup: a device's pairing is that device's business.
 */

const HOST_KEY = "hardlytracking.host";
const TOKEN_KEY = "hardlytracking.token";

/** The paired host, or `""` for this origin. */
export function remoteHost(): string {
  try {
    return (localStorage.getItem(HOST_KEY) ?? "").replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function setRemoteHost(host: string): void {
  try {
    const trimmed = host.trim().replace(/\/+$/, "");
    if (trimmed === "" || trimmed === location.origin) localStorage.removeItem(HOST_KEY);
    else localStorage.setItem(HOST_KEY, trimmed);
  } catch {
    /* a browser with storage disabled keeps the session default */
  }
}

export function hostToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setHostToken(token: string): void {
  try {
    if (token.trim() === "") localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token.trim());
  } catch {
    /* ignore */
  }
}

/** An API path, resolved against the paired host when there is one. */
export function apiUrl(path: string): string {
  const host = remoteHost();
  return host === "" ? path : `${host}${path}`;
}

/** Headers every API call carries: the token, when this device was paired with one. */
export function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = hostToken();
  return token === "" ? extra : { ...extra, "x-hardlytracking-token": token };
}

/**
 * A URL for something that cannot send headers — an `<img>` or a download.
 *
 * The token becomes a query parameter, which is why the server accepts both.
 */
export function withToken(url: string): string {
  const token = hostToken();
  if (token === "") return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

/**
 * Read a pairing link: `?host=…&token=…` on our own URL, or a hash route carrying the same.
 *
 * The desktop shows one link; opening it on the phone both points the phone at that host and gives
 * it the token. Nothing else has to be typed.
 */
export function pairFromLocation(href: string): { host: string | null; token: string | null } {
  const queryOf = (text: string): URLSearchParams => {
    try {
      return new URLSearchParams(text.startsWith("?") ? text.slice(1) : text);
    } catch {
      return new URLSearchParams();
    }
  };
  const hash = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
  const hashQuery = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  const fromHash = queryOf(hashQuery);
  const fromQuery = queryOf(href.includes("?") ? href.slice(href.indexOf("?"), href.includes("#") ? href.indexOf("#") : undefined) : "");
  const host = fromHash.get("host") ?? fromQuery.get("host");
  const token = fromHash.get("token") ?? fromQuery.get("token");
  return { host: host === null || host.trim() === "" ? null : host.trim(), token: token === null || token.trim() === "" ? null : token.trim() };
}

export interface HostInfo {
  host: string;
  port: number;
  serving: boolean;
  tokenRequired: boolean;
  addresses: Array<{ name: string; address: string }>;
  runtime: string;
  dalvik: string;
}

/** Ask the server where it thinks it is, so the app can show a link to open on a phone. */
export async function hostInfo(): Promise<HostInfo | null> {
  try {
    const response = await fetch(apiUrl("/api/host-info"), { headers: apiHeaders() });
    if (!response.ok) return null;
    return (await response.json()) as HostInfo;
  } catch {
    return null;
  }
}

/** The link to open on the phone: a host address, plus the token when one is required. */
export function pairingLink(info: HostInfo, token: string): string | null {
  const address = info.addresses[0]?.address;
  if (address === undefined) return null;
  const query = token.trim() === "" ? "" : `?token=${encodeURIComponent(token.trim())}`;
  return `http://${address}:${info.port}/${query}`;
}

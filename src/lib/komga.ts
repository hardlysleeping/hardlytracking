/**
 * Where Komga lives, and who we are on it.
 *
 * **Normal login, not an API key.** Every client of Komga — Mihon's extension, TachiyomiSY, the
 * Komga web UI itself — signs in with a username and password over HTTP basic auth; an API key is
 * an extra thing to mint and paste, and it is not what a person has in front of them. So the card
 * asks for the login the user already uses.
 *
 * The password is a secret on this device and nowhere else: it lives in `localStorage` beside the
 * HT-Server token, which means it is *not* in the library database and therefore never in an
 * exported backup. `docs/builtins.md` states the same rule for the token.
 *
 * Read through functions, never captured once: a card that saves an address must take effect on the
 * next read, not after a relaunch.
 */
import { RUNTIME_DEADLINE_MS, deadlined } from "./deadline";
import { hasLocalServer } from "./host";

const BASE_KEY = "hardlytracking.komga";
const USER_KEY = "hardlytracking.komgaUser";
const PASSWORD_KEY = "hardlytracking.komgaPassword";
const ENABLED_KEY = "hardlytracking.komgaEnabled";

export interface KomgaSettings {
  baseUrl: string;
  username: string;
  password: string;
}

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string): void {
  try {
    if (value === "") localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // A browser with storage disabled still runs; the setting simply does not survive a reload.
  }
}

/**
 * A URL the *page* can actually load, given where Komga is.
 *
 * Komga sends no `Access-Control-Allow-Origin`, so in the browser build every request has to go
 * through the app's own server (`/api/komga`, see `server/komga-target.mjs`). The packaged builds
 * bypass CORS, so they keep talking to Komga directly and this is the identity there. The base64 of
 * the address is in the path rather than a header because covers and pages are fetched as plain
 * URLs.
 */
export function komgaUrl(
  baseUrl: string,
  path: string,
  proxied: boolean = hasLocalServer(),
  origin: string = typeof location === "undefined" ? "" : location.origin,
): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const tail = path.startsWith("/") ? path : `/${path}`;
  if (!proxied) return `${base}${tail}`;
  // Absolute, not root-relative: the reader hands a page URL to `/api/img`, which takes a URL and
  // refuses a path — a relative one arrives as `url=%2Fapi%2Fkomga…` and draws nothing.
  return `${origin}/api/komga/${encodeBase64Url(base)}${tail}`;
}

/** `btoa` with the URL-safe alphabet and no padding, in both the page and Node. */
export function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const plain = typeof btoa === "function" ? btoa(binary) : Buffer.from(value, "utf8").toString("base64");
  return plain.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The address, trimmed to a bare origin-ish base. `null` when there is no address to talk to. */
export function komgaBaseUrl(): string {
  return read(BASE_KEY).trim().replace(/\/+$/, "");
}

export function komgaUsername(): string {
  return read(USER_KEY).trim();
}

export function komgaPassword(): string {
  return read(PASSWORD_KEY);
}

/** A Komga is configured once there is an address *and* a login: one without the other is a 401. */
export function komgaSettings(): KomgaSettings | null {
  const baseUrl = komgaBaseUrl();
  const username = komgaUsername();
  const password = komgaPassword();
  if (baseUrl === "" || username === "" || password === "") return null;
  return { baseUrl, username, password };
}

export function komgaConfigured(): boolean {
  return komgaSettings() !== null;
}

/**
 * On unless turned off, and only meaningful when configured.
 *
 * Default-on for the same reason as the HT-Server: entering a login *is* the act of opting in, so a
 * source that is configured but silently off would look broken.
 */
export function komgaEnabled(): boolean {
  if (!komgaConfigured()) return false;
  return read(ENABLED_KEY) !== "off";
}

export function setKomgaEnabled(enabled: boolean): void {
  write(ENABLED_KEY, enabled ? "on" : "off");
}

export function setKomgaSettings(next: Partial<KomgaSettings>): void {
  if (next.baseUrl !== undefined) write(BASE_KEY, next.baseUrl.trim().replace(/\/+$/, ""));
  if (next.username !== undefined) write(USER_KEY, next.username.trim());
  if (next.password !== undefined) write(PASSWORD_KEY, next.password);
}

/** Forget the address and the login. The switch goes with them: there is nothing left to switch. */
export function clearKomga(): void {
  write(BASE_KEY, "");
  write(USER_KEY, "");
  write(PASSWORD_KEY, "");
  write(ENABLED_KEY, "");
}

export interface KomgaProbe {
  ok: boolean;
  /** The libraries Komga answered with, when it answered. */
  libraries?: string[];
  /** Why it did not, in its own words where it has any. */
  error?: string;
}

/**
 * Ask Komga who we are.
 *
 * `/api/v1/users/me` is the cheapest question that needs the login and proves it: a wrong password
 * is 401 there, and a wrong address is a network error. The library list comes along because a
 * login that works but sees no libraries is a different thing to tell the user about.
 */
export async function probeKomga(
  settings: KomgaSettings,
  // The same deadline as the provider: a Komga box that is asleep accepts the socket and says
  // nothing, and "Test login" is the first place a person meets that.
  fetchImpl: typeof fetch = deadlined(fetch, RUNTIME_DEADLINE_MS, "your Komga server"),
): Promise<KomgaProbe> {
  const base = settings.baseUrl.replace(/\/+$/, "");
  const bytes = new TextEncoder().encode(`${settings.username}:${settings.password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const headers = { authorization: `Basic ${btoa(binary)}`, accept: "application/json" };
  try {
    // Through `/api/komga` in the page: the proxy forwards `authorization` untouched, so the check
    // is the same one the packaged app makes directly.
    const me = await fetchImpl(komgaUrl(base, "/api/v1/users/me"), { headers });
    if (me.status === 401 || me.status === 403) {
      return { ok: false, error: `Komga refused that login (${me.status})` };
    }
    if (!me.ok) return { ok: false, error: `Komga answered ${me.status}` };
    const libraries = await fetchImpl(komgaUrl(base, "/api/v1/libraries"), { headers });
    if (!libraries.ok) return { ok: false, error: `signed in, but the library list answered ${libraries.status}` };
    const rows = (await libraries.json()) as Array<{ name?: string }>;
    return { ok: true, libraries: rows.map((row) => row.name ?? "Untitled library") };
  } catch (error) {
    const message = (error as Error).message;
    // A browser tab cannot call another origin without CORS, and Komga sends no
    // `Access-Control-Allow-Origin`. The packaged app talks to it directly (Capacitor's HTTP and the
    // desktop shell both bypass CORS), so this is a "this page" limitation, and saying so is the
    // difference between "your server is down" and "open this in the app".
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      return {
        ok: false,
        error: `This page could not reach ${base} directly (a browser blocks another origin's response). The phone and desktop builds talk to Komga without that limit.`,
      };
    }
    return { ok: false, error: `Komga is not answering at ${base}: ${message}` };
  }
}

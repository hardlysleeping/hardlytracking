/**
 * Where Komga lives, and who we are on it — one entry per server, up to three.
 *
 * **Normal login, not an API key.** Every client of Komga — Mihon's extension, TachiyomiSY, the
 * Komga web UI itself — signs in with a username and password over HTTP basic auth; an API key is
 * an extra thing to mint and paste, and it is not what a person has in front of them. So the card
 * asks for the login the user already uses.
 *
 * **More than one server is a real case**, not a nicety: the same Komga box exposes the same
 * libraries to every login, so the only way to read one library and hide another is a second login
 * on the same address. The list therefore allows several entries with the same `baseUrl`; each one
 * carries its own id, and every source/series/chapter id is namespaced by that id (see
 * `komgaSourceId` in `src/api/komga.ts`), so the two logins' libraries never collide.
 *
 * The list is one JSON value in `localStorage`. A pre-list install (the four flat keys
 * `hardlytracking.komga*`) is migrated on the first read into entry `default`, and the old keys are
 * deleted; the exported single-server functions keep working and address that first entry.
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

/** The whole list, as one JSON value. */
const LIST_KEY = "hardlytracking.komgaServers";
/** Pre-list keys, read once and then deleted. */
const BASE_KEY = "hardlytracking.komga";
const USER_KEY = "hardlytracking.komgaUser";
const PASSWORD_KEY = "hardlytracking.komgaPassword";
const ENABLED_KEY = "hardlytracking.komgaEnabled";

/** Three is what the owner asked for, and what the card says out loud when the limit is hit. */
export const KOMGA_MAX_SERVERS = 3;

/** The id the single-server install migrates to. Stable, so old marks keep resolving. */
export const LEGACY_KOMGA_SERVER_ID = "default";

export interface KomgaSettings {
  baseUrl: string;
  username: string;
  password: string;
}

/** One configured Komga: the login plus the identity the UI and every id use. */
export interface KomgaServer extends KomgaSettings {
  /** Colon-free, stable for the entry's life. It is part of every source and series id. */
  id: string;
  label: string;
  enabled: boolean;
}

export interface KomgaServerResult {
  ok: boolean;
  /** The entry as saved, when it was. */
  server?: KomgaServer;
  /** Why it was not saved, in words the card can show. */
  error?: string;
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

function trimBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * A server id that is safe inside a namespaced id.
 *
 * Ids are `komga:<serverId>:<native>`, so a colon in the server id would split in the wrong place.
 * `ch`, `src` and `lib` are the native segment markers, so they are never handed out as a server id.
 */
function cleanId(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned === "" || cleaned === "ch" || cleaned === "src" || cleaned === "lib") return "";
  return cleaned;
}

function uniqueId(wanted: string, taken: readonly string[]): string {
  const cleaned = cleanId(wanted);
  const base = cleaned === "" ? "komga" : cleaned;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const next = `${base}-${n}`;
    if (!taken.includes(next)) return next;
  }
}

function normalise(raw: unknown): KomgaServer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const baseUrl = typeof row.baseUrl === "string" ? trimBase(row.baseUrl) : "";
  if (baseUrl === "") return null;
  return {
    id: typeof row.id === "string" ? cleanId(row.id) : "",
    label: typeof row.label === "string" && row.label.trim() !== "" ? row.label.trim() : "Komga",
    baseUrl,
    username: typeof row.username === "string" ? row.username.trim() : "",
    password: typeof row.password === "string" ? row.password : "",
    // Default on, like the single-server switch was: entering a login *is* the opt-in.
    enabled: row.enabled !== false,
  };
}

function parseList(text: string): KomgaServer[] | null {
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const seen: string[] = [];
  const rows: KomgaServer[] = [];
  for (const entry of parsed) {
    const server = normalise(entry);
    if (server === null) continue;
    server.id = uniqueId(server.id === "" ? "komga" : server.id, seen);
    seen.push(server.id);
    rows.push(server);
    if (rows.length >= KOMGA_MAX_SERVERS) break;
  }
  return rows;
}

function persist(servers: KomgaServer[]): void {
  write(LIST_KEY, servers.length === 0 ? "" : JSON.stringify(servers));
}

function forgetLegacy(): void {
  write(BASE_KEY, "");
  write(USER_KEY, "");
  write(PASSWORD_KEY, "");
  write(ENABLED_KEY, "");
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

/** True once the entry has the two things a request needs; an address alone is a 401. */
export function komgaServerConfigured(server: KomgaServer): boolean {
  return server.baseUrl !== "" && server.username !== "" && server.password !== "";
}

/**
 * Every saved Komga, enabled or not.
 *
 * A pre-list install is migrated here — one entry, id `default` — so an upgrade needs no action from
 * the user and the old flat keys are removed. Storage that cannot be written still yields the
 * migrated entry for this session.
 */
export function komgaServers(): KomgaServer[] {
  const stored = read(LIST_KEY);
  const parsed = parseList(stored);
  if (parsed !== null) return parsed;
  if (stored !== "") return []; // unreadable list: never guess, and never overwrite it

  const baseUrl = trimBase(read(BASE_KEY));
  const username = read(USER_KEY).trim();
  const password = read(PASSWORD_KEY);
  if (baseUrl === "" && username === "" && password === "") return [];
  const legacy: KomgaServer = {
    id: LEGACY_KOMGA_SERVER_ID,
    label: "Komga",
    baseUrl,
    username,
    password,
    enabled: read(ENABLED_KEY) !== "off",
  };
  persist([legacy]);
  forgetLegacy();
  return [legacy];
}

/** The entries a request can actually use, in list order. */
export function activeKomgaServers(): KomgaServer[] {
  return komgaServers().filter((server) => server.enabled && komgaServerConfigured(server));
}

export function komgaServerById(id: string): KomgaServer | null {
  return komgaServers().find((server) => server.id === id) ?? null;
}

/** The first entry that has a login, enabled or not — the single-server view of the list. */
export function komgaSettings(): KomgaSettings | null {
  const first = komgaServers().find(komgaServerConfigured);
  if (first === undefined) return null;
  return { baseUrl: first.baseUrl, username: first.username, password: first.password };
}

export function komgaConfigured(): boolean {
  return komgaSettings() !== null;
}

/**
 * On when at least one configured server is enabled.
 *
 * Default-on for the same reason as the HT-Server: entering a login *is* the act of opting in, so a
 * server that is configured but silently off would look broken. The built-in extension's switch
 * toggles every server at once (`setKomgaEnabled`); each server also has its own switch in the card.
 */
export function komgaEnabled(): boolean {
  return activeKomgaServers().length > 0;
}

/** The extension card's switch: off means every saved server is off, on means every one is on. */
export function setKomgaEnabled(enabled: boolean): void {
  const servers = komgaServers();
  if (servers.length === 0) return;
  persist(servers.map((server) => ({ ...server, enabled })));
}

/** The address of the first configured server, for the label the old card draws. */
export function komgaBaseUrl(): string {
  return komgaSettings()?.baseUrl ?? "";
}

export function komgaUsername(): string {
  return komgaSettings()?.username ?? "";
}

export function komgaPassword(): string {
  return komgaSettings()?.password ?? "";
}

/**
 * Save the single-server shape into the list.
 *
 * Kept because every single-server caller (and the manual QA harness) uses it: it updates the first
 * entry, or creates entry `default`. The list editor uses `addKomgaServer`/`updateKomgaServer`.
 */
export function setKomgaSettings(next: Partial<KomgaSettings>): void {
  const servers = komgaServers();
  if (servers.length === 0) {
    persist([
      {
        id: LEGACY_KOMGA_SERVER_ID,
        label: "Komga",
        baseUrl: trimBase(next.baseUrl ?? ""),
        username: (next.username ?? "").trim(),
        password: next.password ?? "",
        enabled: true,
      },
    ]);
    return;
  }
  const at = servers.findIndex((server) => server.id === LEGACY_KOMGA_SERVER_ID);
  const index = at >= 0 ? at : 0;
  const current = servers[index];
  servers[index] = {
    ...current,
    ...(next.baseUrl === undefined ? {} : { baseUrl: trimBase(next.baseUrl) }),
    ...(next.username === undefined ? {} : { username: next.username.trim() }),
    ...(next.password === undefined ? {} : { password: next.password }),
  };
  persist(servers);
}

/** Forget every server, and the migrated keys with them. */
export function clearKomga(): void {
  persist([]);
  forgetLegacy();
}

/**
 * Add one server, refusing a fourth in words the card can show.
 *
 * The limit is a rule of the feature, not a layout accident, so it is enforced here rather than only
 * by hiding a button: a caller that ignores the UI must still get the refusal.
 */
export function addKomgaServer(input: Partial<KomgaServer> = {}): KomgaServerResult {
  const servers = komgaServers();
  if (servers.length >= KOMGA_MAX_SERVERS) {
    return {
      ok: false,
      error: `HardlyTracking supports ${KOMGA_MAX_SERVERS} Komga servers. Remove one before adding another.`,
    };
  }
  const baseUrl = trimBase(input.baseUrl ?? "");
  if (baseUrl === "") return { ok: false, error: "A Komga server needs an address." };
  const username = (input.username ?? "").trim();
  const password = input.password ?? "";
  if (username === "" || password === "") {
    return { ok: false, error: "A Komga server needs a username and password." };
  }
  const id = uniqueId(input.id ?? input.label ?? "komga", servers.map((server) => server.id));
  const label = input.label?.trim() ?? "";
  const server: KomgaServer = {
    id,
    label: label === "" ? `Komga ${servers.length + 1}` : label,
    baseUrl,
    username,
    password,
    enabled: input.enabled !== false,
  };
  persist([...servers, server]);
  return { ok: true, server };
}

/** Edit one entry in place. The id never changes: every stored mark is keyed by it. */
export function updateKomgaServer(id: string, patch: Partial<Omit<KomgaServer, "id">>): KomgaServerResult {
  const servers = komgaServers();
  const at = servers.findIndex((server) => server.id === id);
  if (at < 0) return { ok: false, error: "That Komga server is no longer in the list." };
  const current = servers[at];
  const next: KomgaServer = {
    ...current,
    ...(patch.label === undefined ? {} : { label: patch.label.trim() === "" ? current.label : patch.label.trim() }),
    ...(patch.baseUrl === undefined ? {} : { baseUrl: trimBase(patch.baseUrl) }),
    ...(patch.username === undefined ? {} : { username: patch.username.trim() }),
    ...(patch.password === undefined ? {} : { password: patch.password }),
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
  };
  if (next.baseUrl === "") return { ok: false, error: "A Komga server needs an address." };
  servers[at] = next;
  persist(servers);
  return { ok: true, server: next };
}

export function setKomgaServerEnabled(id: string, enabled: boolean): void {
  updateKomgaServer(id, { enabled });
}

/** Remove one entry. The others, their ids and their marks are untouched. */
export function removeKomgaServer(id: string): boolean {
  const servers = komgaServers();
  const kept = servers.filter((server) => server.id !== id);
  if (kept.length === servers.length) return false;
  persist(kept);
  return true;
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
    // WebKit and native networking can use the same generic failure text for DNS, TLS,
    // ATS and routing failures. It is not evidence of CORS or a rejected login.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Komga is not answering at ${base}: ${message}` };
  }
}

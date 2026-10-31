/**
 * HardlySyncing in this app: the same account, and the same row, as HardlyReader.
 *
 * The subscription is not a feature of either app. It is one entitlement row —
 * `entitlements(user_id, cloud_sync, expires_at)` — owned by one Supabase project,
 * and every app that reads that project sees the same answer for the same person.
 * A purchase made in the reader therefore shows up here without a second charge,
 * a licence key, or anything to copy across. Nothing in this file decides what the
 * row means; it asks the server and reports what came back.
 *
 * Three things this deliberately does not have:
 *
 * - **A second billing service.** `billing.hardlysleep.ing` is app-agnostic: it
 *   takes a plan and a JWT and answers a Checkout URL. This app names its own
 *   origin so a purchase comes back here, and that origin has to be in the
 *   service's allowlist (`APP_ORIGINS`) — a setting, not code.
 * - **Its own price ids.** The service sells what it was configured to sell; a
 *   client that named a price could be talked into selling something else.
 * - **A cache of the grant.** The row is the receipt. A cached "yes" that outlives
 *   a lapsed card is the one bug this feature must never have.
 *
 * The session is kept in `localStorage` under this app's own key and is a device's
 * business, like the pairing token: it is not part of a backup, and signing out
 * here does not sign out the reader's other apps.
 */

/** Where the shop is. Public: it is a URL, not a key. */
export const SYNC_BILLING_DEFAULT = "https://billing.hardlysleep.ing";

/** The device's copy of the session. */
const SESSION_KEY = "hardlytracking.sync.session";

/** Both values are public by design; row-level security is the protection. */
export interface SyncConfig {
  readonly url: string;
  readonly anonKey: string;
}

/** The signed-in identity, as the device remembers it. */
export interface SyncSession {
  readonly userId: string;
  readonly email: string;
  readonly token: string;
  readonly refresh: string;
  /** Epoch ms. `0` when the provider did not say. */
  readonly expiresAt: number;
}

/** What the row says, in the only three shapes the app needs. */
export type SyncState =
  | { readonly state: "active"; readonly expiresAt: number | null }
  | { readonly state: "none"; readonly reason: string }
  | { readonly state: "unreachable"; readonly reason: string };

export type SyncFetch = (url: string, init: RequestInit) => Promise<Response>;

interface Common {
  config: SyncConfig;
  fetch?: SyncFetch;
  timeoutMs?: number;
}

const TIMEOUT_MS = 12_000;

/** A key whose own claims say `service_role` is refused, not used. */
function roleOf(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The build's Supabase values, or null when it has none.
 *
 * The same names HardlyReader reads (`PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`)
 * because it is the same project: a second project would be a second account and
 * a second subscription, which is the thing this file exists to avoid. A build
 * with no values simply has no HardlySyncing row to show — it is not an error.
 */
export function syncConfig(env: Record<string, unknown> | null): SyncConfig | null {
  if (env === null) return null;
  const url = text(env.PUBLIC_SUPABASE_URL);
  const anonKey = text(env.PUBLIC_SUPABASE_ANON_KEY);
  if (url === "" || anonKey === "") return null;
  if (roleOf(anonKey) === "service_role") return null;
  return { url: url.replace(/\/+$/, ""), anonKey };
}

/** The environment a Vite build was handed, read the way both apps read it. */
export function envOfBuild(): Record<string, unknown> | null {
  try {
    return (import.meta as unknown as { env?: Record<string, unknown> }).env ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------- the session ------------------------------ */

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

function storageOf(given?: Storage): Storage | null {
  if (given !== undefined) return given;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The remembered session, or null. A corrupt value is no session, not a crash. */
export function readSession(store?: Storage): SyncSession | null {
  const storage = storageOf(store);
  if (storage === null) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SyncSession>;
    if (text(parsed.userId) === "" || text(parsed.token) === "") return null;
    return {
      userId: text(parsed.userId),
      email: text(parsed.email),
      token: text(parsed.token),
      refresh: text(parsed.refresh),
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeSession(session: SyncSession, store?: Storage): void {
  const storage = storageOf(store);
  if (storage === null) return;
  try {
    storage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* a browser with storage disabled keeps the session in memory only */
  }
}

export function clearSession(store?: Storage): void {
  const storage = storageOf(store);
  if (storage === null) return;
  try {
    storage.removeItem(SESSION_KEY);
  } catch {
    /* nothing to remove */
  }
}

/* -------------------------------- the shop -------------------------------- */

async function send({ config, fetch: call = fetch, timeoutMs = TIMEOUT_MS }: Common, path: string, init: RequestInit): Promise<Response | null> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeoutMs);
  try {
    return await call(`${config.url}${path}`, { ...init, signal: stop.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sessionFrom(body: unknown, email: string): SyncSession | null {
  const payload = body as
    | { access_token?: unknown; refresh_token?: unknown; expires_at?: unknown; expires_in?: unknown; user?: { id?: unknown; email?: unknown } }
    | null;
  const token = text(payload?.access_token);
  const userId = text(payload?.user?.id);
  if (token === "" || userId === "") return null;
  const at = typeof payload?.expires_at === "number" ? payload.expires_at : 0;
  const inSeconds = typeof payload?.expires_in === "number" ? payload.expires_in : 0;
  return {
    userId,
    email: text(payload?.user?.email) || email,
    token,
    refresh: text(payload?.refresh_token),
    expiresAt: at > 0 ? at * 1000 : inSeconds > 0 ? Date.now() + inSeconds * 1000 : 0,
  };
}

/**
 * Asks for a code by email.
 *
 * A code rather than a link: a link has to come back into this app through a URL
 * scheme, and a six-digit code is typed into the screen that asked for it. The
 * project's email template has to carry `{{ .Token }}` for this to be useful —
 * without it the mail contains a link and no code, and the reader is told the
 * code never arrived rather than being left guessing.
 */
export async function requestCode({ email, ...common }: Common & { email: string }): Promise<"sent" | "refused" | "unreachable"> {
  const response = await send(common, "/auth/v1/otp", {
    method: "POST",
    headers: {
      apikey: common.config.anonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: email.trim(), create_user: true }),
  });
  if (response === null) return "unreachable";
  return response.ok ? "sent" : "refused";
}

/** Types the code back and, if the provider agrees, this device is signed in. */
export async function verifyCode({
  email,
  code,
  store,
  ...common
}: Common & { email: string; code: string; store?: Storage }): Promise<SyncSession | null> {
  const response = await send(common, "/auth/v1/verify", {
    method: "POST",
    headers: {
      apikey: common.config.anonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "email", email: email.trim(), token: code.trim() }),
  });
  if (response === null || !response.ok) return null;
  const session = sessionFrom(await response.json().catch(() => null), email);
  if (session !== null) writeSession(session, store);
  return session;
}

/**
 * The row, read with the reader's own token.
 *
 * One GET, and three answers: a row that is still good, a row that has run out
 * (or no row at all), and a server that did not answer. The middle case is not an
 * error — a lapsed card stops syncing without anybody pressing anything.
 */
export async function entitlement({
  session,
  now = Date.now(),
  ...common
}: Common & { session: SyncSession; now?: number }): Promise<SyncState> {
  const query = `select=cloud_sync,expires_at&user_id=eq.${encodeURIComponent(session.userId)}&limit=1`;
  const response = await send(common, `/rest/v1/entitlements?${query}`, {
    method: "GET",
    headers: {
      apikey: common.config.anonKey,
      Authorization: `Bearer ${session.token}`,
      Accept: "application/json",
    },
  });
  if (response === null) return { state: "unreachable", reason: "the server did not answer" };
  if (response.status === 401 || response.status === 403) {
    return { state: "none", reason: "this device's sign-in has expired — sign in again" };
  }
  if (!response.ok) return { state: "unreachable", reason: `the server answered ${response.status}` };
  const rows = (await response.json().catch(() => null)) as unknown;
  const row = Array.isArray(rows) ? (rows[0] as { cloud_sync?: unknown; expires_at?: unknown } | undefined) : undefined;
  return readRow(row ?? null, now);
}

/** A row, as a state. Pure, so the policy can be read without a network. */
export function readRow(row: { cloud_sync?: unknown; expires_at?: unknown } | null, now: number): SyncState {
  if (row === null) return { state: "none", reason: "no subscription on this account" };
  const expiresRaw = row.expires_at;
  const expiresAt =
    typeof expiresRaw === "string" && expiresRaw !== "" ? Date.parse(expiresRaw) : typeof expiresRaw === "number" ? expiresRaw : null;
  const good = row.cloud_sync === true;
  if (!good) return { state: "none", reason: "no subscription on this account" };
  if (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= now) {
    return { state: "none", reason: "the subscription has run out" };
  }
  return { state: "active", expiresAt: expiresAt !== null && Number.isFinite(expiresAt) ? expiresAt : null };
}

/**
 * Opens Checkout for a plan, and answers the URL that was opened.
 *
 * The only things sent are the plan, this app's origin and the reader's token.
 * The origin is named so a purchase started here comes back here; the service
 * accepts it only when it is one it serves.
 */
export async function startCheckout({
  session,
  plan,
  base = SYNC_BILLING_DEFAULT,
  open,
  origin,
  ...common
}: Common & {
  session: SyncSession;
  plan: "monthly" | "yearly";
  base?: string;
  open?: (url: string) => Promise<void> | void;
  origin?: string;
}): Promise<string | null> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), common.timeoutMs ?? TIMEOUT_MS);
  const call = common.fetch ?? fetch;
  let response: Response;
  try {
    response = await call(`${base.replace(/\/+$/, "")}/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ plan, return: origin }),
      signal: stop.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as { url?: unknown } | null;
  const url = text(body?.url);
  if (!/^https:\/\//i.test(url)) return null;
  await (open ?? openExternal)(url);
  return url;
}

/** The system browser, when the app is not the thing a card is typed into. */
async function openExternal(url: string): Promise<void> {
  const bridge = (globalThis as { Capacitor?: { Plugins?: { Browser?: { open?: (options: { url: string }) => Promise<unknown> } } } }).Capacitor;
  const open = bridge?.Plugins?.Browser?.open;
  if (typeof open === "function") {
    await open({ url });
    return;
  }
  if (typeof globalThis.open === "function") {
    globalThis.open(url, "_blank", "noopener");
  }
}

/** This app's own origin, when it has one. A packaged app has none to name. */
export function ownOrigin(): string | undefined {
  try {
    if (typeof location === "undefined" || !/^https?:$/.test(location.protocol)) return undefined;
    return location.origin;
  } catch {
    return undefined;
  }
}

/** Signing out here signs out this device only; the row is untouched. */
export async function signOut({ session, config, fetch: call = fetch }: Common & { session: SyncSession; store?: Storage }): Promise<void> {
  clearSession();
  if (session.token === "") return;
  try {
    await call(`${config.url}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: config.anonKey, Authorization: `Bearer ${session.token}` },
    });
  } catch {
    /* the device has forgotten the token either way */
  }
}

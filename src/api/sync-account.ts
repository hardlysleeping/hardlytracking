/**
 * HardlySyncing in this app: the same account, the same row, and the same
 * sign-in as HardlyReader.
 *
 * The subscription is not a feature of either app. It is one entitlement row —
 * `entitlements(user_id, cloud_sync, expires_at)` — owned by one Supabase
 * project, so every app reading that project sees the same answer for the same
 * person: a purchase made in the reader shows up here with no second charge and
 * nothing to copy across.
 *
 * The way in is the reader's way in, deliberately: an emailed link
 * (`signInWithOtp`), the SDK's own session in this device's storage,
 * `detectSessionInUrl` so opening the link lands back here signed in, and then
 * one `GET` against `entitlements` filtered to this user with this user's token.
 * No code to type, no custom auth endpoints, no second table, no per-app column,
 * no price id in the client, and no cache of the grant — a cached "yes" that
 * outlives a lapsed card is the one bug this feature must never have.
 *
 * Three things this deliberately does not have:
 *
 * - **A second billing service.** `billing.hardlysleep.ing` is app-agnostic: it
 *   takes a plan and a JWT and answers a Checkout URL. This app names its own
 *   origin so a purchase comes back here, and that origin has to be in the
 *   service's allowlist (`APP_ORIGINS`) — a setting, not code.
 * - **Its own price ids.** The service sells what it was configured to sell; a
 *   client that named a price could be talked into selling something else.
 * - **A cache of the grant.** The row is the receipt.
 * - **A shop in the app-store build.** `shopOf` answers `none` for iOS and
 *   Android, so no store build draws a Checkout button or can reach one. The
 *   row is still read: a subscription bought on the web is the same row here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { openExternal } from "../lib/external";
import {
  Account,
  accountConfig,
  envOfBuild,
  ownOrigin,
  shellOf,
  text,
  type AccountConfig,
  type AccountSession,
  type Shell,
} from "./account";

/**
 * The auth this app had before `account.ts` existed, still exported here so every existing
 * import site keeps working: the shared client, the session shape, the config reader and the
 * shell. New code should import them from `./account` instead — this file owns billing,
 * entitlements and checkout, and nothing about who is signed in.
 */
export { envOfBuild, ownOrigin, roleOf, shellOf, type Shell } from "./account";

/** Where the shop is. Public: it is a URL, not a key. The reader's default. */
export const SYNC_BILLING_DEFAULT = "https://billing.hardlysleep.ing";

/** What the panel says after a link is sent. The reader's sentence, verbatim. */
export const LINK_SENT =
  "Check your email for the link. It signs this device in when you open it.";

/** What the panel says while the browser holds a payment this app has not seen yet. */
export const CHECKOUT_OPENED =
  "Checkout is open in your browser — come back here when it is done and HardlySyncing will be waiting.";

/** Long enough for a slow phone network, short enough that a dead socket is reported, not waited on. */
const SYNC_TIMEOUT_MS = 8000;

/** The two plan names the service knows. Prices are Stripe's and never appear here. */
export type PlanKey = "monthly" | "yearly";

/** The project's public values. Owned by `account.ts`; aliased so imports do not move. */
export type SyncConfig = AccountConfig;

/** The signed-in identity. Owned by `account.ts`; aliased so imports do not move. */
export type SyncSession = AccountSession;

/** What the row says, in the only three shapes the app needs. */
export type SyncState =
  | { readonly state: "active"; readonly expiresAt: number | null }
  | { readonly state: "none"; readonly reason: string }
  | { readonly state: "unreachable"; readonly reason: string };

/** What the service said when it would not sell — or what this build said first. */
export type CheckoutFailure =
  | "not_signed_in"
  | "unknown_plan"
  | "plan_not_offered"
  | "billing_unreachable"
  | "no_url"
  | "purchase_unavailable";

/** Where a subscription may be bought in this build. */
export type Shop = "stripe" | "none";

/** What a build with no shop says. A statement of absence, never a direction to go and buy. */
export const NOT_SOLD_HERE = "Subscriptions are not sold in this build.";

/**
 * The shop this shell may use.
 *
 * Web and desktop sell through Stripe, which is what the reader already does.
 * An app-store build does not: Apple's 3.1.1 and Play's payments policy both
 * forbid sending someone to an outside checkout for a digital subscription, and
 * there is no StoreKit product to offer in its place — paid sync is post-launch
 * (`README.md`, `docs/app-store-release-checklist.md` §9). So a store build has
 * no shop at all, and the entitlement row is still read: a subscription bought
 * on the web shows up on the phone, with nothing to restore.
 */
export function shopOf(shell: Shell): Shop {
  return shell === "ios" || shell === "android" ? "none" : "stripe";
}

export class CheckoutError extends Error {
  readonly code: CheckoutFailure;

  constructor(code: CheckoutFailure, message?: string) {
    super(message ?? code);
    this.name = "CheckoutError";
    this.code = code;
  }
}

/**
 * The build's Supabase values, or null when it has none.
 *
 * Kept as a name here because the panel and the suite already ask for it; the reader is
 * `accountConfig()` in `account.ts`, which is also what the shared client uses.
 */
export function syncConfig(env: Record<string, unknown> | null = envOfBuild()): SyncConfig | null {
  return accountConfig(env);
}

/** The service this build sells through. */
export function billingUrl(env: Record<string, unknown> | null = envOfBuild()): string {
  return (text(env?.PUBLIC_BILLING_URL) || SYNC_BILLING_DEFAULT).replace(/\/+$/, "");
}

/** A row, as a state. Pure, so the policy can be read without a network. */
export function readRow(
  row: { cloud_sync?: unknown; expires_at?: unknown } | null,
  now: number,
): SyncState {
  if (row === null) return { state: "none", reason: "no subscription on this account" };
  const expiresRaw = row.expires_at;
  const expiresAt =
    typeof expiresRaw === "string" && expiresRaw !== ""
      ? Date.parse(expiresRaw)
      : typeof expiresRaw === "number"
        ? expiresRaw
        : null;
  if (row.cloud_sync !== true) return { state: "none", reason: "no subscription on this account" };
  if (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= now) {
    return { state: "none", reason: "the subscription has run out" };
  }
  return {
    state: "active",
    expiresAt: expiresAt !== null && Number.isFinite(expiresAt) ? expiresAt : null,
  };
}

export interface SyncAccountOptions {
  readonly config: SyncConfig;
  /** Injected by the suite; the real one is created here. */
  readonly client?: SupabaseClient;
  readonly fetch?: typeof fetch;
  /** Where the emailed link returns to. Null lets the project's Site URL decide. */
  readonly redirectTo?: string | null;
  readonly billingBase?: string;
  /** Which shell this build is in. Read from the globals when not given. */
  readonly shell?: Shell;
  /** How long one read may take before it is abandoned. Injected by the suite. */
  readonly timeoutMs?: number;
}

/**
 * The account, as this app sees it.
 *
 * Constructing it makes no request: the SDK reads its own stored session, and
 * nothing here opens a socket until a link is asked for, a row is read, or a
 * Checkout is started — which is what keeps a free build silent.
 */
export class SyncAccount {
  private readonly settings: SyncConfig;
  /** Who is signed in. Shared with the community catalogue, so one login serves both. */
  private readonly account: Account;
  private readonly call: typeof fetch;
  private readonly base: string;
  /**
   * How long one request may take.
   *
   * `fetch` has no timeout of its own, so a stalled connection left the Sync panel reading its old
   * answer for as long as the socket lived — indistinguishable from a hang, with no way to retry.
   */
  private readonly timeoutMs: number;
  /** Which shell this is, and therefore whether there is a shop at all. */
  readonly shell: Shell;
  readonly shop: Shop;

  constructor(options: SyncAccountOptions) {
    this.settings = options.config;
    this.shell = options.shell ?? shellOf();
    this.shop = shopOf(this.shell);
    // The client is not this class's any more: `account.ts` owns it, so a sign-in made here
    // is the sign-in the community catalogue reads, and vice versa.
    this.account = new Account({
      config: options.config,
      ...(options.client === undefined ? {} : { client: options.client }),
      redirectTo: options.redirectTo ?? null,
    });
    this.call = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? SYNC_TIMEOUT_MS;
    this.base = (options.billingBase ?? billingUrl()).replace(/\/+$/, "");
  }

  /** One request, abandoned after `timeoutMs` so a stalled socket is an answer, not a wait. */
  private async ask(url: string, init: RequestInit): Promise<Response> {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), this.timeoutMs);
    try {
      return await this.call(url, { ...init, signal: stop.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** The session this device already has, or null. Never a request for a new one. */
  async session(): Promise<SyncSession | null> {
    return this.account.session();
  }

  /**
   * Sends the sign-in link.
   *
   * A link, not a code: it is the reader's own flow, it needs no change to the
   * project's email template, and opening it signs this device in through the
   * SDK's `detectSessionInUrl`. Asking for a code instead would need the mail to
   * carry `{{ .Token }}` — a different setup for the same subscription, which is
   * the thing to avoid.
   */
  async sendLink(email: string): Promise<void> {
    await this.account.sendLink(email);
  }

  /**
   * One `GET` against `entitlements`, filtered to this user.
   *
   * The `user_id=eq.` filter is a convenience, not the protection: the policy in
   * the reader's `supabase/schema.sql` decides that a reader sees only their own
   * row, and there is no write policy at all, so no client can set `cloud_sync`
   * even with a hand-made request. This method never issues anything but a `GET`.
   *
   * A failure is `unreachable`, never `active`: nothing was proved, so nothing is
   * granted.
   */
  async entitlement(now: number = Date.now()): Promise<SyncState> {
    const session = await this.session();
    if (session === null) return { state: "none", reason: "this device is not signed in" };
    const query = `select=cloud_sync,expires_at&user_id=eq.${encodeURIComponent(session.userId)}&limit=1`;
    let response: Response;
    try {
      response = await this.ask(`${this.settings.url}/rest/v1/entitlements?${query}`, {
        method: "GET",
        headers: {
          apikey: this.settings.anonKey,
          Authorization: `Bearer ${session.token}`,
          Accept: "application/json",
        },
      });
    } catch {
      return { state: "unreachable", reason: "the server did not answer" };
    }
    if (response.status === 401 || response.status === 403) {
      return { state: "none", reason: "this device's sign-in has expired — sign in again" };
    }
    if (!response.ok) {
      return { state: "unreachable", reason: `the server answered ${response.status}` };
    }
    const rows = (await response.json().catch(() => null)) as unknown;
    const row = Array.isArray(rows)
      ? ((rows[0] ?? null) as { cloud_sync?: unknown; expires_at?: unknown } | null)
      : null;
    return readRow(row, now);
  }

  /**
   * Asks the service for a Checkout URL and opens it.
   *
   * The only things sent are the plan, this app's origin and the reader's token.
   * The origin is named so a purchase started here comes back here; the service
   * accepts it only when it is one it serves. A build with no shop throws before
   * either of those — see `shopOf`.
   */
  async checkout(plan: PlanKey, open?: (url: string) => Promise<void> | void): Promise<string> {
    // Before the session, before the network: a store build has no shop. This is
    // not a disabled button — there is no request to make, and nothing is opened.
    if (this.shop === "none") {
      throw new CheckoutError("purchase_unavailable", NOT_SOLD_HERE);
    }
    const session = await this.session();
    if (session === null) throw new CheckoutError("not_signed_in");
    if (this.base === "") {
      throw new CheckoutError("billing_unreachable", "no billing service is configured");
    }

    let response: Response;
    try {
      response = await this.ask(`${this.base}/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ plan, return: ownOrigin() }),
      });
    } catch (cause) {
      throw new CheckoutError("billing_unreachable", String(cause));
    }

    const body = (await response.json().catch(() => null)) as
      | { url?: unknown; error?: unknown }
      | null;
    if (response.status === 401) throw new CheckoutError("not_signed_in");
    if (response.status === 400 && typeof body?.error === "string") {
      throw new CheckoutError(
        body.error === "plan_not_offered" ? "plan_not_offered" : "unknown_plan",
        body.error,
      );
    }
    if (!response.ok) {
      throw new CheckoutError("billing_unreachable", `billing answered ${response.status}`);
    }
    if (typeof body?.url !== "string" || !/^https:\/\//i.test(body.url)) {
      throw new CheckoutError("no_url", "the service returned no checkout page");
    }
    await (open ?? openExternal)(body.url);
    return body.url;
  }

  /** Signs this device out. The row is the server's and is untouched. */
  async signOut(): Promise<void> {
    await this.account.signOut();
  }
}

/** The account this build has, or null when it has no project to check against. */
export function createSyncAccount(
  config: SyncConfig | null = syncConfig(),
  client?: SupabaseClient,
): SyncAccount | null {
  if (config === null) return null;
  return new SyncAccount({
    config,
    ...(client === undefined ? {} : { client }),
    redirectTo: text(envOfBuild()?.PUBLIC_APP_ORIGIN) || null,
  });
}

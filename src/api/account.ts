/**
 * The account, owned once.
 *
 * This app talks to one Supabase project for three different jobs: the subscription
 * (`sync-account.ts`), the community plugin catalogue (`community.ts`), and — when a paid
 * sync row exists — the sync document itself. All three are the *same person*, so they must
 * be the *same session*: a second client would keep its own copy of the token, refresh on its
 * own schedule, and sign in separately, which is how one app ends up asking someone to log in
 * again to see their own plugins.
 *
 * So the client, the session, the sign-in link and the sign-out live here, and everything else
 * asks this file. `sync-account.ts` keeps its billing, entitlement and checkout behaviour and
 * gets its token from here; `community.ts` does the same. Neither creates a client.
 *
 * Three rules that survive the move:
 *
 * - **Constructing is silent.** The SDK reads its own stored session; nothing here opens a
 *   socket until a link is asked for or a token is needed.
 * - **No elevated key, ever.** A key whose own claims say `service_role` is refused rather
 *   than used, because it would hand this app the whole database.
 * - **The token is read, never cached in a variable.** A cached token that outlives a refresh
 *   is the one bug an account layer can have; the SDK owns its lifetime.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Both values are public by design; row-level security is the protection. */
export interface AccountConfig {
  readonly url: string;
  readonly anonKey: string;
}

/** The signed-in identity, as this device holds it. */
export interface AccountSession {
  readonly userId: string;
  readonly email: string;
  readonly token: string;
}

/** Which shell this build is running in. Read from the globals the shells set. */
export type Shell = "ios" | "android" | "desktop" | "web";

/**
 * The shell, from the globals the shells set themselves.
 *
 * `isNativePlatform()` says an app is wrapping this build but not which store is watching it;
 * `Capacitor.getPlatform()` is the only thing that separates iOS from Android. A native shell
 * that will not name its platform is answered `ios` — the no-shop side — because guessing
 * "web" there would draw a Checkout button inside an app.
 */
export function shellOf(scope: unknown = globalThis): Shell {
  const globals = (scope ?? {}) as Record<string, unknown>;
  if ("__TAURI_INTERNALS__" in globals) return "desktop";
  const capacitor = globals["Capacitor"] as
    | { isNativePlatform?: () => boolean; getPlatform?: () => string }
    | undefined;
  if (
    capacitor !== undefined &&
    typeof capacitor.isNativePlatform === "function" &&
    capacitor.isNativePlatform()
  ) {
    const named = typeof capacitor.getPlatform === "function" ? text(capacitor.getPlatform()) : "";
    return named === "android" ? "android" : "ios";
  }
  return "web";
}

/** The environment a Vite build was handed, read the way both apps read it. */
export function envOfBuild(): Record<string, unknown> | null {
  try {
    return (import.meta as unknown as { env?: Record<string, unknown> }).env ?? null;
  } catch {
    return null;
  }
}

/** Trimmed string, or empty. The whole file's one coercion. */
export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A key whose own claims say `service_role` is refused, not used. */
export function roleOf(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as {
      role?: unknown;
    };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * The build's Supabase values, or null when it has none.
 *
 * The same names HardlyReader reads (`PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`)
 * because it is the same project: a second project would be a second account and a second
 * subscription. A build with no values has no account to show — not an error.
 */
export function accountConfig(env: Record<string, unknown> | null = envOfBuild()): AccountConfig | null {
  if (env === null) return null;
  const url = text(env.PUBLIC_SUPABASE_URL);
  const anonKey = text(env.PUBLIC_SUPABASE_ANON_KEY);
  if (url === "" || anonKey === "") return null;
  if (roleOf(anonKey) === "service_role") return null;
  return { url: url.replace(/\/+$/, ""), anonKey };
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

export interface AccountOptions {
  readonly config: AccountConfig;
  /** Injected by the suite; the real one is created here. */
  readonly client?: SupabaseClient;
  /** Where the emailed link returns to. Null lets the project's Site URL decide. */
  readonly redirectTo?: string | null;
}

/**
 * The session, the sign-in and the sign-out.
 *
 * One instance per app run (`sharedAccount`), so a sign-in made for the subscription is the
 * sign-in the community sees. The methods return plain data — no SDK object crosses this
 * boundary — so a caller cannot accidentally keep a `Session` alive past its refresh.
 */
export class Account {
  readonly client: SupabaseClient;
  private readonly redirectTo: string | null;

  constructor(options: AccountOptions) {
    this.redirectTo = options.redirectTo ?? null;
    this.client =
      options.client ??
      createClient(options.config.url, options.config.anonKey, {
        auth: {
          persistSession: true,
          // Refresh is ours, on return to the window. A timer is a call nobody asked for.
          autoRefreshToken: false,
          // The link comes back to this window with the session in the URL.
          detectSessionInUrl: true,
        },
      });
  }

  /** The session this device already has, or null. Never a request for a new one. */
  async session(): Promise<AccountSession | null> {
    try {
      const { data, error } = await this.client.auth.getSession();
      if (error !== null) return null;
      const session = (data as {
        session?: { access_token?: string; user?: { id?: string; email?: string } } | null;
      })?.session ?? null;
      const token = text(session?.access_token);
      const userId = text(session?.user?.id);
      if (token === "" || userId === "") return null;
      return { userId, token, email: text(session?.user?.email) };
    } catch {
      return null;
    }
  }

  /** The bearer token alone, for a caller that has already checked the session. */
  async token(): Promise<string | null> {
    const session = await this.session();
    return session === null ? null : session.token;
  }

  /**
   * Sends the sign-in link.
   *
   * A link, not a code: it needs no change to the project's email template, and opening it
   * signs this device in through the SDK's `detectSessionInUrl`.
   */
  async sendLink(email: string): Promise<void> {
    const address = email.trim();
    if (address === "") throw new Error("An emailed sign-in link needs an address to send it to.");
    const { error } = await this.client.auth.signInWithOtp({
      email: address,
      ...(this.redirectTo === null ? {} : { options: { emailRedirectTo: this.redirectTo } }),
    });
    if (error !== null) throw new Error(`the sign-in link could not be sent: ${error.message}`);
  }

  /** Signs this device out. Server rows are untouched — they are the user's, not this device's. */
  async signOut(): Promise<void> {
    try {
      await this.client.auth.signOut();
    } catch {
      /* a sign-out that cannot reach the server still clears this device */
    }
  }
}

/** One account per project per run. The app's only Supabase client. */
let shared: { key: string; account: Account } | null = null;

/**
 * The account this build has, or null when it has no project to talk to.
 *
 * Memoised on the project URL and key: two callers asking for "the account" in the same run
 * must get the same object, or the second one builds a second session store and the user is
 * asked to sign in twice.
 */
export function sharedAccount(
  config: AccountConfig | null = accountConfig(),
  redirectTo: string | null = text(envOfBuild()?.PUBLIC_APP_ORIGIN) || ownOrigin() || null,
): Account | null {
  if (config === null) return null;
  const key = `${config.url}\u0000${config.anonKey}`;
  if (shared !== null && shared.key === key) return shared.account;
  const account = new Account({ config, redirectTo });
  shared = { key, account };
  return account;
}

/** Test seam: forget the memoised account so a suite can build its own. */
export function resetSharedAccount(): void {
  shared = null;
}

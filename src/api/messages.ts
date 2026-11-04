/**
 * Messages from the app's author: the list, and marking it read.
 *
 * A message is one-way on purpose — no reply, no badge outside the screen that
 * lists them, no push. It is how an account hears about an outage, a promotion,
 * or "your lifetime upgrade is on the account" without a new build of the app
 * for each one.
 *
 * Three rules, and each one is a client-side fact rather than a policy:
 *
 * 1. **One app asks for one app's messages.** HardlyTracking and HardlyReader
 *    share an account and a project, and an outage in one is noise in the other.
 *    `MESSAGES_APP` is the only value this build ever sends as `p_app`.
 * 2. **The server decides who sees what.** The two calls are `my_app_messages`
 *    and `mark_app_messages_read` in HardlyReader's `supabase/schema.sql`, both
 *    `security definer` and both keyed on `auth.uid()`. A message addressed to
 *    somebody else is not filtered out here; it is never in the answer.
 * 3. **A failure is a sentence, never an empty inbox.** "Nothing to read" and
 *    "could not ask" are different: a signed-out device, an expired token and a
 *    500 are three things to say, and an empty list is only right for the first.
 *
 * The account is `account.ts`'s — the same session the subscription and the
 * community catalogue use — so a person who signed in once is never asked twice.
 */
import { sharedAccount, text, type Account } from "./account";

/** Which app's messages this build shows. The same account is in both apps. */
export const MESSAGES_APP = "hardlytracking";

/** The session a message asks for. The account's own, never a second client. */
export interface MessagesOptions {
  /** Defaults to `sharedAccount()`: one person, one session. */
  readonly account?: Account | null;
  /** Injected by the suite; the app uses `fetch`. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** One message, as the screen draws it. Times are milliseconds, or null. */
export interface InboxMessage {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** When it was published, in milliseconds. */
  readonly publishedAt: number;
  /** When this account first read it, in milliseconds; null while unread. */
  readonly readAt: number | null;
}

/** Either the list, or why there is none. Never both, never an empty stand-in. */
export type MessagesAnswer =
  | { readonly ok: true; readonly messages: readonly InboxMessage[] }
  | { readonly ok: false; readonly reason: string };

/** How long one call may take before it counts as not having been answered. */
const MESSAGES_TIMEOUT_MS = 6000;

/** Milliseconds from a PostgREST timestamp, or null when it is not one. */
function timeOf(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A row, or null when it is not a message this build can draw.
 *
 * A message with nothing to show is not a message, and a missing timestamp is not
 * "now" — a row this build cannot draw is dropped rather than drawn empty.
 */
export function messageOf(row: unknown): InboxMessage | null {
  if (typeof row !== "object" || row === null) return null;
  const raw = row as Record<string, unknown>;
  const id = text(raw.id);
  const title = text(raw.title);
  const body = text(raw.body);
  const publishedAt = timeOf(raw.published_at);
  if (id === "" || title === "" || body === "" || publishedAt === null) return null;
  return { id, title, body, publishedAt, readAt: timeOf(raw.read_at) };
}

/** What a refusal means, in one sentence a screen can show. */
function refusal(status: number): string {
  if (status === 401 || status === 403) return "your sign-in has expired — sign in again to see messages";
  if (status === 404) return "messages are not set up on the server yet";
  return `the server answered ${status}`;
}

export class MessagesClient {
  private readonly account: Account | null;
  private readonly call: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: MessagesOptions = {}) {
    // The subscription's account, unless a suite hands over its own: one person,
    // one session, and no second login prompt.
    this.account = options.account === undefined ? sharedAccount() : options.account;
    this.call = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? MESSAGES_TIMEOUT_MS;
  }

  /** Whether there is an account to talk with at all. A build with no project says no. */
  get available(): boolean {
    return this.account !== null;
  }

  /**
   * The project, from the SDK that already holds it.
   *
   * Reading it back from `client` means one source of truth for the project: a
   * second pair of environment reads is how two halves of one app end up on two
   * projects. Null when this build has no account service.
   */
  private project(): { base: string; anonKey: string } | null {
    if (this.account === null) return null;
    const sdk = this.account.client as unknown as { supabaseUrl?: string; supabaseKey?: string };
    const base = text(sdk.supabaseUrl).replace(/\/+$/, "");
    const anonKey = text(sdk.supabaseKey);
    if (base === "" || anonKey === "") return null;
    return { base, anonKey };
  }

  /** One POST to a PostgREST function, or null when it did not answer. */
  private async post(token: string, path: string, body: unknown): Promise<Response | null> {
    const project = this.project();
    if (project === null) return null;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), this.timeoutMs);
    try {
      return await this.call(`${project.base}/rest/v1/${path}`, {
        method: "POST",
        headers: {
          apikey: project.anonKey,
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: stop.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * This account's messages for this app, newest first, with read state.
   *
   * Unread is `readAt === null`, so the badge and the list come from one call and
   * cannot disagree.
   */
  async list(): Promise<MessagesAnswer> {
    const session = await this.account?.session();
    if (session === null || session === undefined) {
      return { ok: false, reason: "this device is not signed in, so there are no messages to read" };
    }
    const response = await this.post(session.token, "rpc/my_app_messages", { p_app: MESSAGES_APP });
    if (response === null) {
      return this.available
        ? { ok: false, reason: "the server did not answer" }
        : { ok: false, reason: "this build has no account service" };
    }
    if (!response.ok) return { ok: false, reason: refusal(response.status) };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: "the answer was not a list of messages" };
    }
    if (!Array.isArray(body)) return { ok: false, reason: "the answer was not a list of messages" };
    const messages = body.map(messageOf).filter((message): message is InboxMessage => message !== null);
    // The server sorts; this only guards the order the screen relies on.
    messages.sort((a, b) => b.publishedAt - a.publishedAt);
    return { ok: true, messages };
  }

  /**
   * Records that this account has read these messages.
   *
   * The server only accepts the ones the caller can see, and repeats are ignored,
   * so sending the whole visible list on every opening is correct and cheap. A
   * `false` means it was not confirmed — the screen keeps its own answer.
   */
  async markRead(ids: readonly string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const session = await this.account?.session();
    if (session === null || session === undefined) return false;
    const response = await this.post(session.token, "rpc/mark_app_messages_read", {
      p_app: MESSAGES_APP,
      p_messages: ids,
    });
    return response !== null && response.ok;
  }
}

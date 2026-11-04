/**
 * The inbox, as Settings and the Messages screen draw it.
 *
 * `api/messages.ts` is the two calls; this file is what a screen needs around
 * them — the list, how many are unread, whether there is an account at all, and
 * one honest status. It is small on purpose: a message is not a feed, and
 * nothing here fetches on launch.
 *
 * Four rules, each one a way this could be wrong:
 *
 * 1. **Nothing loads until a screen asks.** No launch call, no timer, no push.
 *    Settings asks once when it opens (for the bell's count) and the Messages
 *    screen asks again through the same promise; an app nobody opens Settings in
 *    costs nothing.
 * 2. **A signed-out device has no inbox.** Messages are addressed to an account,
 *    so with no session there is nothing to fetch, nothing to show, and no row:
 *    the Settings link is drawn only when `signedIn` is true. That is not an
 *    error — it is the normal state of a fresh install.
 * 3. **The last list is kept per account and read before the network.** A reader
 *    with no signal still sees the last message; the fetch then replaces it. The
 *    cache is keyed by user id, so one account's notes never draw for another.
 * 4. **Read is local first and the server catches up.** Opening the screen is
 *    what marks the list read — there is no per-message button to miss — so the
 *    count clears under the finger and the ids go to the server afterwards. A
 *    failed record leaves them read here, which is what the reader has seen.
 */

import { sharedAccount, type Account } from "../api/account";
import { MessagesClient, type InboxMessage } from "../api/messages";

/** Where one account's last list lives. The user id is appended. */
export const INBOX_CACHE_PREFIX = "hardlytracking.inbox.v1";

/** `loading` while a call is out; `failed` only when there is nothing to draw. */
export type InboxStatus = "idle" | "loading" | "ready" | "failed";

/** The part of `Storage` this file uses, so a suite can stand in for it. */
export type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface InboxOptions {
  /** Defaults to the app's shared account. Null is a build with no project. */
  readonly account?: Account | null;
  /** Defaults to a client over that account; a suite passes its own. */
  readonly client?: MessagesClient;
  /** Injected by the suite; the default is the device's `localStorage`. */
  readonly storage?: KeyStore | null;
  /** The clock, for the millisecond a message is marked read at. */
  readonly now?: () => number;
}

/** The device's own storage, or null where there is none. */
function deviceKeys(): KeyStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Newest first. The server already sorts; this holds the cache to the same order. */
function newestFirst(messages: readonly InboxMessage[]): InboxMessage[] {
  return [...messages].sort((a, b) => (a.publishedAt === b.publishedAt ? 0 : b.publishedAt - a.publishedAt));
}

/** A parsed cache entry, or null when it is not one for this account. */
function readCache(storage: KeyStore | null, userId: string): InboxMessage[] | null {
  if (storage === null) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(`${INBOX_CACHE_PREFIX}.${userId}`);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const saved = JSON.parse(raw) as { userId?: unknown; messages?: unknown };
    // The key says whose list this is; the value says it again. Both, always.
    if (saved.userId !== userId || !Array.isArray(saved.messages)) return null;
    const messages: InboxMessage[] = [];
    for (const entry of saved.messages) {
      if (typeof entry !== "object" || entry === null) return null;
      const row = entry as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.title !== "string" || typeof row.body !== "string") return null;
      if (typeof row.publishedAt !== "number") return null;
      const readAt = row.readAt === null || typeof row.readAt === "number" ? row.readAt : null;
      messages.push({ id: row.id, title: row.title, body: row.body, publishedAt: row.publishedAt, readAt });
    }
    return newestFirst(messages);
  } catch {
    return null;
  }
}

export class Inbox {
  private readonly account: Account | null;
  private readonly client: MessagesClient;
  private readonly keys: KeyStore | null;
  private readonly clock: () => number;
  /** The account whose list is in `messages` right now. */
  private loadedFor: string | null = null;
  /** The call that is out, so two screens share one request. */
  private pending: Promise<void> | null = null;

  /** What the screen draws. Empty while nothing asked, and while signed out. */
  messages = $state<InboxMessage[]>([]);
  status = $state<InboxStatus>("idle");
  /** A sentence when something is off — including "this is the last copy". */
  reason = $state<string | null>(null);
  /** Whether this device has an account. The Settings link hangs off this. */
  signedIn = $state(false);

  constructor(options: InboxOptions = {}) {
    this.account = options.account === undefined ? sharedAccount() : options.account;
    this.client =
      options.client ?? new MessagesClient({ account: this.account });
    this.keys = options.storage === undefined ? deviceKeys() : options.storage;
    this.clock = options.now ?? Date.now;
  }

  /** Whether this build has an account service at all. A project-less build does not. */
  get available(): boolean {
    return this.client.available;
  }

  /** How many messages this account has not opened yet. The bell's dot. */
  get unread(): number {
    return this.messages.filter((message) => message.readAt === null).length;
  }

  /**
   * This account's messages, newest first.
   *
   * Reads the last copy first when the account has changed (so a cached list
   * appears at once), then asks the server whatever the answer. A failure keeps
   * the cached list and says so; with no cached list it is `failed` with the
   * reason, never an empty `ready`.
   *
   * One call at a time: Settings asks for the count and the screen asks again,
   * and a second request for the same list on the same press is a request nobody
   * asked for.
   */
  async load(): Promise<void> {
    if (this.pending !== null) return await this.pending;
    this.pending = this.fetchAndDraw();
    try {
      await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async fetchAndDraw(): Promise<void> {
    const session = await this.account?.session();
    if (session === null || session === undefined) {
      this.signedIn = false;
      this.messages = [];
      this.status = "ready";
      this.reason = null;
      this.loadedFor = null;
      return;
    }
    this.signedIn = true;

    if (this.loadedFor !== session.userId) {
      const cached = readCache(this.keys, session.userId);
      this.messages = cached ?? [];
      this.loadedFor = session.userId;
    }

    this.status = "loading";
    const answer = await this.client.list();

    // Signed out or switched while the call was out: that answer is not this screen's.
    if (this.loadedFor !== session.userId) return;

    if (answer.ok) {
      this.messages = newestFirst(answer.messages);
      this.status = "ready";
      this.reason = null;
      this.remember(session.userId);
      return;
    }

    this.reason = answer.reason;
    if (this.messages.length > 0) {
      // The last copy is a real answer, and saying so is better than a blank list.
      this.status = "ready";
      this.reason = `${answer.reason} — showing the messages this device last saw`;
    } else {
      this.status = "failed";
    }
  }

  /**
   * Marks everything on screen read, locally first.
   *
   * Called when the screen opens, so there is nothing for the reader to press.
   * The ids are then recorded on the server; a refusal leaves this device's own
   * copy read, because the reader has seen these words either way.
   */
  async readAll(): Promise<void> {
    const unread = this.messages.filter((message) => message.readAt === null);
    if (unread.length === 0) return;
    const at = this.clock();
    this.messages = this.messages.map((message) =>
      message.readAt === null ? { ...message, readAt: at } : message,
    );
    const userId = this.loadedFor;
    if (userId !== null) this.remember(userId);
    await this.client.markRead(unread.map((message) => message.id));
  }

  /** Writes this account's list where the next opening reads it. Best effort. */
  private remember(userId: string): void {
    if (this.keys === null) return;
    try {
      this.keys.setItem(
        `${INBOX_CACHE_PREFIX}.${userId}`,
        JSON.stringify({ userId, messages: this.messages }),
      );
    } catch {
      // A full or refused store costs the cache, never the screen.
    }
  }
}

/** The app's one inbox. A build with no project simply never fills it. */
export const inbox = new Inbox();

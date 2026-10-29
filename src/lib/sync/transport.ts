/**
 * The transport seam — how one sync document reaches a store.
 *
 * Card S6. A transport carries exactly one document, byte for byte, and never
 * interprets it: `read()` hands back the bytes the store holds, `write()` stores the
 * bytes it was given, and neither parses, merges, re-serialises or validates anything.
 * That is deliberate. Providers are transports, not schemas — iCloud, Drive, Dropbox,
 * OneDrive, WebDAV and a plain folder all carry the same document, and the moment a
 * provider is allowed to reshape it there are two sources of truth instead of one.
 * Parsing and validation stay in `document.ts`, so a transport can be swapped (or a
 * provider added) without touching a single format rule.
 *
 * A transport also never throws a raw provider error at a caller: failures arrive as
 * `SyncTransportError`, whose message is short, readable and safe to put in front of
 * the reader. Credentials are never part of it — a message that leaks a password ends
 * up in a log, a screenshot or a bug report.
 */

export interface SyncTransport {
  /** Short label for a UI or a log line, e.g. `folder:/home/me/Sync`. */
  readonly name: string;
  /** The stored document, or `null` when the store holds nothing yet. */
  read(): Promise<string | null>;
  /** Replace the stored document with these exact bytes. */
  write(text: string): Promise<void>;
}

/** A transport failure worth showing: what was attempted, and why it did not work. */
export class SyncTransportError extends Error {
  /** The transport that failed, so a caller can name it without guessing. */
  readonly transport: string;

  constructor(transport: string, message: string, cause?: unknown) {
    // The cause is kept for debugging but never folded into the message: a provider's
    // own error text can contain a URL with credentials in it.
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SyncTransportError";
    this.transport = transport;
  }
}

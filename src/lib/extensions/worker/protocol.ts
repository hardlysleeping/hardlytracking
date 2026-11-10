/**
 * The wire between the app and a portable extension's Worker.
 *
 * Two rules shape it:
 *
 * 1. **The provider is the only thing in the worker; the host is the only thing with I/O.** A
 *    portable package has no `fetch`, no DOM and no Capacitor plugin. Every network request is a
 *    message the host answers, so cookies, tokens, redirect policy and the "which origin may this
 *    package talk to" question live in one place instead of in downloaded code.
 * 2. **Errors cross as data.** A throw inside the worker becomes `{ok: false, error}`, because an
 *    exception object does not survive `postMessage` and a silent empty page is the failure mode a
 *    source must never have.
 */

export const PORTABLE_PROTOCOL = 1;

/** Every call a package can answer. `sources` first: it is the one the app needs to list it at all. */
export type PortableMethod =
  | "sources"
  | "trending"
  | "popular"
  | "latest"
  | "search"
  | "filters"
  | "details"
  | "chapters"
  | "pages"
  | "readState"
  | "setRead";

export interface PortableFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** A string, or base64 for a body that is not text. */
  body?: string;
  bodyBase64?: boolean;
}

export interface PortableFetchAnswer {
  status: number;
  headers: Record<string, string>;
  /** Base64 of the bytes. Base64 rather than text because a cover or a page is not text. */
  bodyBase64: string;
}

export interface PortableError {
  code: "unsupported" | "threw" | "timeout";
  message: string;
}

export type HostToWorker =
  | { type: "load"; protocol: number; packageId: string; source: string }
  | { type: "call"; id: number; method: PortableMethod; args: unknown[] }
  | { type: "fetchResult"; id: number; ok: true; value: PortableFetchAnswer }
  | { type: "fetchResult"; id: number; ok: false; error: PortableError }
  | { type: "dispose" };

export type WorkerToHost =
  | { type: "ready"; protocol: number; methods: PortableMethod[] }
  | { type: "failed"; error: PortableError }
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; error: PortableError }
  | { type: "fetch"; id: number; request: PortableFetchRequest };

/**
 * How long one call may take.
 *
 * A package that hangs must read as "this source did not answer", never as a frozen Extensions
 * screen: the whole boot path awaits `sources()` to know a source exists.
 */
export const PORTABLE_CALL_DEADLINE_MS = 30_000;

/** A cover or a page is allowed longer than a JSON call, because the bytes are the slow part. */
export const PORTABLE_FETCH_DEADLINE_MS = 60_000;

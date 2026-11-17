/**
 * Deadlines on every runtime call, and a record of what is still running.
 *
 * The extension host is an interpreter, not a server: a source that talks to a slow site, or a
 * repository whose host has gone away, can take a very long time to answer without ever *failing*.
 * A bare `fetch` in that state waits for the platform's own timeout, which is minutes — long enough
 * that the screen looks frozen, long enough that App Store review presses the home button, and long
 * enough that a user concludes the app is broken rather than the source.
 *
 * So two things, and the second is the one people notice:
 *
 * 1. **A deadline on the call.** Every provider's default fetch goes through `deadlined()`, which
 *    aborts at the deadline and rejects with a `DeadlineError` whose message names what was being
 *    waited on. A deadline is not a retry policy and not a guess about "slow": it is the point where
 *    waiting longer stops being useful.
 * 2. **A visible sign that something is happening.** `activity` counts calls in flight and how long
 *    the oldest has been running, so the shell can say "waiting on the source, 7 s" instead of
 *    showing an unchanged screen. Silence is the failure; a slow answer is not.
 *
 * Nothing here cancels a call on the user's behalf: an abort only happens at the deadline, because a
 * half-read index is still better than a dropped one.
 */

/** How long any single runtime call may take before it is called a hung source. */
export const RUNTIME_DEADLINE_MS = 30_000;

/**
 * A book that has to arrive before it has any pages.
 *
 * Thirty seconds is right for a metadata call and impossible for a 469 MB scan: the transfer is
 * healthy, it is simply big. archive.org bounds its own volume download by this, and the reader
 * waits this long for that page list, so a slow volume ends in a real failure instead of a sentence
 * claiming the source went quiet while the bytes were still coming.
 */
export const BOOK_DEADLINE_MS = 240_000;

/** A call that ran out of time. Distinct from a network error, and named after what it waited on. */
export class DeadlineError extends Error {
  readonly ms: number;
  readonly label: string;

  constructor(label: string, ms: number) {
    super(`${label} did not answer within ${Math.round(ms / 1000)} s`);
    this.name = "DeadlineError";
    this.ms = ms;
    this.label = label;
  }
}

/** One call in flight. */
interface Pending {
  label: string;
  startedAt: number;
}

/**
 * What the shell reads to draw the "still waiting" chip.
 *
 * Plain data with a subscribe callback rather than Svelte state: providers live in `lib/` and must
 * not import a component-facing store, and the counter is testable without a DOM.
 */
class Activity {
  private pending: Pending[] = [];
  private listeners = new Set<() => void>();
  /** Injected so a test does not have to wait a real second. */
  now: () => number = () => Date.now();

  /** Register a call; the returned function ends it. Safe to call twice. */
  begin(label: string): () => void {
    const entry: Pending = { label, startedAt: this.now() };
    this.pending.push(entry);
    this.notify();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const at = this.pending.indexOf(entry);
      if (at !== -1) this.pending.splice(at, 1);
      this.notify();
    };
  }

  /** How many calls are in flight. */
  get count(): number {
    return this.pending.length;
  }

  /** The oldest call, with its age in ms — the one the chip names. */
  slowest(): { label: string; elapsedMs: number } | null {
    let oldest: Pending | null = null;
    for (const entry of this.pending) {
      if (oldest === null || entry.startedAt < oldest.startedAt) oldest = entry;
    }
    if (oldest === null) return null;
    return { label: oldest.label, elapsedMs: Math.max(0, this.now() - oldest.startedAt) };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const activity = new Activity();

/**
 * `fetch` with a deadline, and with the call counted in `activity`.
 *
 * `label` is what the chip and the error say, so it is written for a person: "the Internet
 * Archive", "your Komga server", "the repository".
 */
export function deadlined(fetchImpl: typeof fetch, ms = RUNTIME_DEADLINE_MS, label = "the source"): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const expired = new DeadlineError(label, ms);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;
    // The deadline is a race, not a hope: a `fetch` that ignores its abort signal (a sandboxed
    // webview, a polyfill, an in-process test double) must still end when the time is up. The abort
    // is what stops the work underneath; the rejection is what stops the caller waiting.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(expired);
        reject(expired);
      }, ms);
    });
    const end = activity.begin(label);
    // A caller that brings its own signal still gets to cancel, and its reason is what the caller
    // sees — the deadline is an extra stop condition, never a replacement for the caller's.
    const caller: AbortSignal | null | undefined = init?.signal;
    const cancelled =
      caller == null
        ? null
        : new Promise<never>((_resolve, reject) => {
            if (caller.aborted) reject(caller.reason);
            else caller.addEventListener("abort", () => reject(caller.reason), { once: true });
          });
    try {
      const racers: Promise<Response>[] = [fetchImpl(input, { ...init, signal: controller.signal }), deadline];
      if (cancelled !== null) racers.push(cancelled);
      return await Promise.race(racers);
    } catch (error) {
      // An abort at the deadline is reported as the deadline, not as the browser's generic
      // "signal is aborted without reason" — that message tells a user nothing.
      throw timedOut ? expired : error;
    } finally {
      clearTimeout(timer!);
      end();
    }
  };
  return wrapped as typeof fetch;
}

/**
 * The same deadline for a promise that is not a `fetch` call (a GraphQL POST through a transport
 * that returns a promise, a plugin call).
 *
 * The underlying work keeps running — there is nothing safe to cancel — but the caller stops
 * waiting, and the chip stops counting it.
 */
export function withDeadline<T>(work: Promise<T>, ms = RUNTIME_DEADLINE_MS, label = "the source", signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const end = signal?.aborted ? () => {} : activity.begin(label);
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      end();
      callback();
    };
    const abort = () => finish(() => reject(signal?.reason));
    const timer = setTimeout(() => finish(() => reject(new DeadlineError(label, ms))), ms);
    // Always observe the work, even when already cancelled: an abandoned rejection is not unhandled.
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, {once: true});
  });
}

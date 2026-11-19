/**
 * Holding the screen on while a page is being read.
 *
 * "Keep the screen awake" was a stored setting with nothing behind it: the switch remembered its
 * position while the phone locked on schedule. The platform call that actually does this is the
 * Screen Wake Lock API, and it has three rules that make a naive call a lie:
 *
 * 1. **It is granted only while the page is visible.** A lock is dropped when the app goes to the
 *    background, so the holder has to ask again on return — a one-shot request is off after the
 *    first glance at another app and never comes back.
 * 2. **It can be refused.** A low battery, an unfocused window or a locked-down webview answers
 *    with a rejection. A refusal is not an error to show: the lock is a convenience, and a reader
 *    who has to unlock the phone once more is not broken. The UI says the device cannot hold the
 *    screen, which is the truth, instead of a switch that pretends.
 * 3. **It must be released.** A lock held after the chapter closes keeps the screen on in the
 *    shelf, which drains a phone for no reason.
 *
 * The browser, the Android WebView (Chromium) and iOS 16.4+ WKWebView all speak it; older shells
 * and the desktop WebKitGTK build do not, which `supported` answers so the switch can say so.
 */

/** The part of `WakeLockSentinel` this module uses. */
export interface WakeLockSentinelLike {
  released?: boolean;
  release(): Promise<void>;
}

/** The part of `navigator.wakeLock` this module uses. */
export interface WakeLockApiLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

/** The part of `document` this module listens on. */
export interface VisibilityLike {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface WakeLockOptions {
  /** Defaults to `navigator.wakeLock` when the runtime has one. */
  api?: WakeLockApiLike | null;
  /** Defaults to `document`. */
  visibility?: VisibilityLike | null;
  /** Called when the platform refuses. Never thrown: a lock is not worth a broken reader. */
  onrefused?: (error: unknown) => void;
}

export interface WakeLockController {
  /** Whether the runtime has the API at all. A shell without it can only say so. */
  readonly supported: boolean;
  /** Ask for the lock and keep it while the page stays visible. Repeated calls are free. */
  hold(): void;
  /** Let the screen behave normally again. */
  release(): void;
  /** Whether a lock is held right now. */
  readonly held: boolean;
}

function defaultApi(): WakeLockApiLike | null {
  if (typeof navigator === "undefined") return null;
  const api = (navigator as Navigator & { wakeLock?: WakeLockApiLike }).wakeLock;
  return typeof api?.request === "function" ? api : null;
}

function defaultVisibility(): VisibilityLike | null {
  if (typeof document === "undefined") return null;
  return document as unknown as VisibilityLike;
}

/**
 * Whether this runtime can hold the screen on at all.
 *
 * A UI that is told this can say so, instead of showing a switch whose position means nothing.
 */
export function wakeLockAvailable(api: WakeLockApiLike | null = defaultApi()): boolean {
  return api !== null;
}

/**
 * A controller for one reader screen.
 *
 * Not a singleton: two readers are two holders, and one closing must not release the other's lock.
 * The state is deliberately small — "wanted" is the setting, "sentinel" is what the platform gave.
 */
export function createWakeLock(options: WakeLockOptions = {}): WakeLockController {
  const api = options.api === undefined ? defaultApi() : options.api;
  const visibility = options.visibility === undefined ? defaultVisibility() : options.visibility;
  let wanted = false;
  let sentinel: WakeLockSentinelLike | null = null;
  /** A request in flight, so a visibility flip cannot stack two. */
  let pending = false;
  /** Held only while the lock is wanted: a released controller leaves nothing on `document`. */
  let listening = false;

  const onVisible = (): void => {
    if (visibility?.visibilityState !== "visible") return;
    if (!wanted) return;
    void request();
  };

  async function request(): Promise<void> {
    if (api === null || sentinel !== null || pending || !wanted) return;
    pending = true;
    try {
      const next = await api.request("screen");
      // Released while the request was in flight (the reader closed): hand it straight back.
      if (!wanted) {
        await next.release().catch(() => undefined);
        return;
      }
      sentinel = next;
    } catch (error) {
      // A refusal is the platform's answer, not a failure to report: the screen simply locks.
      options.onrefused?.(error);
    } finally {
      pending = false;
    }
  }

  function release(): void {
    wanted = false;
    if (listening) {
      visibility?.removeEventListener("visibilitychange", onVisible);
      listening = false;
    }
    const held = sentinel;
    sentinel = null;
    if (held !== null) void held.release().catch(() => undefined);
  }

  return {
    get supported(): boolean {
      return api !== null;
    },
    get held(): boolean {
      return sentinel !== null;
    },
    hold(): void {
      if (api === null) return;
      wanted = true;
      if (!listening) {
        visibility?.addEventListener("visibilitychange", onVisible);
        listening = visibility !== null;
      }
      if (visibility !== null && visibility.visibilityState !== "visible") return;
      void request();
    },
    release,
  };
}
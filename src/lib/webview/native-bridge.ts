/**
 * The native bridge, read from the page instead of imported.
 *
 * A Capacitor shell injects `window.Capacitor` before any app script runs, and `@capacitor/core` is
 * a wrapper around that object. The extension runtime used to reach its plugin with
 * `await import("@capacitor/core")` instead, and in the iPhone shell that import never settled: an
 * install waited out the whole ten-second load deadline and then reported "Loading the native
 * runtime bridge did not answer within 10000 ms" while the bridge — with the plugin in it — had been
 * in the page the entire time. A hanging import has no fallback, so the answer is not a longer
 * deadline: it is asking the object that is already there.
 *
 * Its own module because `webview/index` pulls in the cookie jar, and this question is answerable
 * without any of that.
 */

/** The Capacitor bridge, as much of it as anything here needs. */
interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  registerPlugin?: (name: string) => unknown;
  Plugins?: Record<string, unknown>;
}

/** Is this page a native shell? The bridge answers for itself, so nothing is guessed from the UA. */
export function isNativeShell(): boolean {
  const capacitor = (globalThis as Record<string, unknown>)["Capacitor"] as CapacitorBridge | undefined;
  return capacitor !== undefined && typeof capacitor.isNativePlatform === "function" && capacitor.isNativePlatform();
}

/**
 * The native plugin `name`, or `null` when this page has no bridge that can answer for it.
 *
 * `null` is the honest answer for a browser tab and for a shell that registered no such plugin:
 * both mean the caller should fall back, not wait.
 */
export function nativePlugin<T>(name: string): T | null {
  const capacitor = (globalThis as Record<string, unknown>)["Capacitor"] as CapacitorBridge | undefined;
  if (capacitor === undefined) return null;
  if (typeof capacitor.registerPlugin === "function") {
    return (capacitor.registerPlugin(name) as T | null) ?? null;
  }
  const known = capacitor.Plugins?.[name];
  return (known as T | undefined) ?? null;
}

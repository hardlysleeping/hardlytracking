/**
 * The extension runtime that lives **inside the app**, for the standalone iPhone build.
 *
 * On a desktop or in a browser the dalvik host is another process: Suwayomi on `:4567`, or
 * M-Extension-Server behind the app's own `/api/dalvik` proxy. On an iPhone there is no other
 * process to call — the requirement is a phone in airplane mode reading from extensions it
 * installed itself. So the shell starts a JVM in its own process, that JVM serves the same
 * `/dalvik` protocol on a loopback port, and the app talks to it exactly as it talks to any other
 * host. Nothing above `DalvikClient` knows the difference.
 *
 * This module is the only place that knows a native runtime exists:
 *
 * - `startNativeRuntime()` resolves to the loopback base URL, or `null` on every build that has no
 *   such plugin (browser, desktop, tests). `null` is not an error: it means "use the default host",
 *   which is the `/api/dalvik` proxy.
 * - A runtime that is already running is reused, never started twice — the second `start` would
 *   bind a port that is already taken and read as a crash.
 * - A runtime that fails to start returns `null` rather than throwing. A phone that cannot start its
 *   JVM must still open its library and say what happened; `registry.ts` turns the missing host into
 *   a warning line, which is the shape the UI already understands.
 */
import { detectPlatform } from "./webview/index";

/** Loopback port the embedded server listens on. Fixed so a stale pairing cannot point elsewhere. */
export const NATIVE_RUNTIME_PORT = 8747;

export interface NativeRuntimeStatus {
  running: boolean;
  port: number;
}

/** The plugin surface the iOS shell registers as `MihonRuntime`. */
export interface MihonRuntimePlugin {
  /** Start the embedded server; resolves with the port it actually bound. */
  start(options: { port: number }): Promise<{ port: number }>;
  status(): Promise<NativeRuntimeStatus>;
  /** Stop serving while the app is in the background; the VM stays loaded. */
  pause(): Promise<void>;
  stop(): Promise<void>;
}

/** `http://127.0.0.1:<port>` — the base every dalvik call is joined to. */
export function loopbackBase(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * The plugin, when this shell has one.
 *
 * `registerPlugin` always returns a proxy, even for a name no native side registered — the first
 * call is what fails — so the caller treats a failed `status()` as "no runtime" rather than
 * trusting the name.
 */
async function loadNativePlugin(): Promise<MihonRuntimePlugin | null> {
  if (detectPlatform() !== "capacitor") return null;
  try {
    const { registerPlugin } = await import("@capacitor/core");
    return registerPlugin<MihonRuntimePlugin>("MihonRuntime");
  } catch {
    return null;
  }
}

/**
 * Make sure the on-device runtime is serving, and answer where.
 *
 * `load` exists so a test can hand in a fake plugin; production callers never pass it.
 */
export async function startNativeRuntime(
  port = NATIVE_RUNTIME_PORT,
  load: () => Promise<MihonRuntimePlugin | null> = loadNativePlugin,
): Promise<string | null> {
  const plugin = await load();
  if (plugin === null) return null;
  try {
    const before = await plugin.status();
    if (before.running) return loopbackBase(before.port > 0 ? before.port : port);
    const started = await plugin.start({ port });
    const bound = started.port > 0 ? started.port : port;
    // A `start` that resolves is not proof the server is listening: ask it.
    const after = await plugin.status();
    return after.running ? loopbackBase(bound) : null;
  } catch {
    // No plugin compiled in, a JVM that refused to start, a port already taken — all the same to the
    // caller: this build has no on-device host, so the default one is used and the UI shows the
    // warning the registry already produces.
    return null;
  }
}

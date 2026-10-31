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

/** The Tauri command bridge, as `@tauri-apps/api/core`'s `invoke` looks. */
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * The desktop adapter: the same four calls, answered by `src-tauri/src/runtime.rs`.
 *
 * The desktop does not embed a JVM in the webview process — it starts `MExtensionServer` as a child
 * and waits for `/capabilities`. From here that is indistinguishable from the iPhone's in-process
 * runtime, which is the point: one seam, two shells.
 */
export function tauriRuntimePlugin(invoke: Invoke): MihonRuntimePlugin {
  return {
    async start({ port }) {
      const answer = await invoke<{ port: number; running: boolean }>("mihon_runtime_start", { port });
      return { port: answer.port };
    },
    async status() {
      const answer = await invoke<{ running: boolean; port: number }>("mihon_runtime_status");
      return { running: answer.running === true, port: answer.port };
    },
    async pause() {
      // A desktop has no background-suspension contract to honour; the child keeps serving.
    },
    async stop() {
      await invoke("mihon_runtime_stop");
    },
  };
}

/**
 * The plugin, when this shell has one.
 *
 * `registerPlugin` always returns a proxy, even for a name no native side registered — the first
 * call is what fails — so the caller treats a failed `status()` as "no runtime" rather than
 * trusting the name.
 */
async function loadNativePlugin(): Promise<MihonRuntimePlugin | null> {
  const platform = detectPlatform();
  if (platform === "tauri") {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return tauriRuntimePlugin(invoke as Invoke);
    } catch {
      return null;
    }
  }
  if (platform !== "capacitor") return null;
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

/**
 * A `fetch` that can reach a loopback host, for shells where the webview's own cannot.
 *
 * `tauri://localhost` is a different origin from `http://127.0.0.1:<port>`, and the extension host is
 * not ours to add CORS headers to, so those calls go through Rust via `@tauri-apps/plugin-http`.
 * Everywhere else this is `undefined` and the webview's own `fetch` is used — which is also the
 * reason this returns a function rather than patching a global: a browser build keeps its real one.
 */
export async function shellFetch(): Promise<typeof fetch | undefined> {
  if (detectPlatform() !== "tauri") return undefined;
  try {
    const { fetch: native } = await import("@tauri-apps/plugin-http");
    return native as unknown as typeof fetch;
  } catch {
    return undefined;
  }
}

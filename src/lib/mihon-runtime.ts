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
 * - **Every call has a deadline.** The native side answers from a serial worker queue, and a JVM that
 *   wedges inside `MihonRuntimeStart` never calls its completion — which leaves the Capacitor promise
 *   pending forever. That is not a slow start, it is a dead app: `library.open()` awaits this and the
 *   shell then shows "Opening the library…" for the whole session while every tab looks broken. A
 *   call that does not answer in time is treated exactly like a refused one, so the library opens.
 */
import { nativePlugin } from "./webview/native-bridge";
import { detectPlatform } from "./webview/index";

/** Loopback port the embedded server listens on. Fixed so a stale pairing cannot point elsewhere. */
export const NATIVE_RUNTIME_PORT = 8747;

/**
 * How long a native answer may take before the app assumes there is no host this session.
 *
 * `status` is a cheap question — the native side answers "not running" without touching the JVM — so
 * silence there means the bridge is wedged. `start` really does build a JVM on an interpreter-only
 * port, which takes seconds on a phone, so it gets a generous window rather than a tight one.
 */
export const RUNTIME_STATUS_DEADLINE_MS = 5_000;
export const RUNTIME_START_DEADLINE_MS = 45_000;
/** Loading the bridge is a dynamic import, and an import that never resolves is not a slow start. */
export const RUNTIME_LOAD_DEADLINE_MS = 10_000;

const TIMED_OUT: unique symbol = Symbol("timed out");

/** `work`, or `TIMED_OUT` once `ms` pass. The timer is cleared so it cannot outlive the race. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
  // Only the page's own registry. `@capacitor/core` is a wrapper around the same object, so the
  // package has nothing extra to give — and importing it is what hung on this shell: an install
  // waited out the ten-second load deadline for a bridge that was in the page all along. A shell
  // that has a bridge but no `MihonRuntime` in it answers `null`, which the caller reports as
  // "no registered on-device runtime" instead of waiting for anything.
  return nativePlugin<MihonRuntimePlugin>("MihonRuntime");
}

/**
 * Make sure the on-device runtime is serving, and answer where.
 *
 * `load` exists so a test can hand in a fake plugin; production callers never pass it.
 */
export interface NativeRuntimeResult { baseUrl: string | null; error: string | null }

/** Keep the refusal/timeout reason: an installer must not turn every native failure into null. */
export async function startNativeRuntimeDetailed(
  port = NATIVE_RUNTIME_PORT,
  load: () => Promise<MihonRuntimePlugin | null> = loadNativePlugin,
  deadlines: { status: number; start: number; load?: number } = {
    status: RUNTIME_STATUS_DEADLINE_MS, start: RUNTIME_START_DEADLINE_MS,
  },
): Promise<NativeRuntimeResult> {
  let step = "Loading the native runtime bridge";
  const failed = (error: string): NativeRuntimeResult => ({ baseUrl: null, error });
  const serving = (bound: number): NativeRuntimeResult => ({ baseUrl: loopbackBase(bound), error: null });
  try {
    const plugin = await within(load(), deadlines.load ?? RUNTIME_LOAD_DEADLINE_MS);
    if (plugin === TIMED_OUT) return failed(`${step} did not answer within ${deadlines.load ?? RUNTIME_LOAD_DEADLINE_MS} ms.`);
    if (plugin === null) return failed("This build has no registered on-device extension runtime plugin.");
    step = "Checking the on-device runtime status";
    const before = await within(plugin.status(), deadlines.status);
    if (before === TIMED_OUT) return failed(`${step} did not answer within ${deadlines.status} ms.`);
    if (before.running) return serving(before.port > 0 ? before.port : port);
    step = "Starting the on-device extension runtime";
    const started = await within(plugin.start({ port }), deadlines.start);
    if (started === TIMED_OUT) return failed(`${step} did not answer within ${deadlines.start} ms.`);
    const bound = started.port > 0 ? started.port : port;
    step = "Confirming the on-device runtime status";
    const after = await within(plugin.status(), deadlines.status);
    // The actual /capabilities handshake still verifies this bound port before installing.
    if (after === TIMED_OUT) return serving(bound);
    return after.running ? serving(bound) : failed("The native runtime start returned, but its server is not running.");
  } catch (cause) {
    return failed(`${step}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** Compatibility seam: optional startup callers still receive a loopback URL or null. */
export async function startNativeRuntime(
  port = NATIVE_RUNTIME_PORT,
  load: () => Promise<MihonRuntimePlugin | null> = loadNativePlugin,
  deadlines: { status: number; start: number; load?: number } = {
    status: RUNTIME_STATUS_DEADLINE_MS, start: RUNTIME_START_DEADLINE_MS,
  },
): Promise<string | null> {
  return (await startNativeRuntimeDetailed(port, load, deadlines)).baseUrl;
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

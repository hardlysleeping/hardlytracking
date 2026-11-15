/**
 * The native bridge is read from the page, not imported.
 *
 * The iPhone shell injects `window.Capacitor` before any app script runs, and that object is the
 * one `@capacitor/core` wraps. The extension runtime used to reach its plugin with
 * `await import("@capacitor/core")` instead, and on that shell the import never settled: an install
 * waited out the whole ten-second load deadline and then reported "Loading the native runtime bridge
 * did not answer within 10000 ms" while the bridge — and the plugin in it — had been in the page the
 * entire time. A dynamic import that hangs has no fallback, so the fix is not a longer deadline: it
 * is asking the object that is already there.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { nativePlugin } from "../../src/lib/webview/native-bridge.ts";
import { NATIVE_RUNTIME_PORT, startNativeRuntime, startNativeRuntimeDetailed } from "../../src/lib/mihon-runtime.ts";

/** A plugin that answers status immediately, like a runtime already serving. */
function serving(port) {
  return {
    async start() {
      return { port };
    },
    async status() {
      return { running: true, port };
    },
    async pause() {},
    async stop() {},
  };
}

function withBridge(bridge, run) {
  const scope = globalThis;
  const before = Object.getOwnPropertyDescriptor(scope, "Capacitor");
  Object.defineProperty(scope, "Capacitor", { value: bridge, configurable: true, writable: true });
  try {
    return run();
  } finally {
    if (before === undefined) delete scope.Capacitor;
    else Object.defineProperty(scope, "Capacitor", before);
  }
}

test("a plugin comes out of the injected registry, with no import in the way", async () => {
  const plugin = serving(8747);
  const base = await withBridge(
    { isNativePlatform: () => true, Plugins: { MihonRuntime: plugin } },
    () => startNativeRuntime(NATIVE_RUNTIME_PORT),
  );
  assert.equal(base, "http://127.0.0.1:8747", "the runtime the page already had is the runtime used");
});

test("a bridge that only exposes registerPlugin is read the same way", async () => {
  const plugin = serving(8747);
  const asked = [];
  const base = await withBridge(
    {
      isNativePlatform: () => true,
      registerPlugin: (name) => {
        asked.push(name);
        return plugin;
      },
    },
    () => startNativeRuntime(NATIVE_RUNTIME_PORT),
  );
  assert.equal(base, "http://127.0.0.1:8747");
  assert.deepEqual(asked, ["MihonRuntime"], "the plugin is asked for by the name the shell registered");
});

test("no bridge means no native runtime, and no waiting for one", async () => {
  const base = await withBridge(undefined, () => startNativeRuntime(NATIVE_RUNTIME_PORT, undefined, { status: 50, start: 50 }));
  assert.equal(base, null);
});

test("a bridge with no such plugin answers null instead of a proxy that would hang", () => {
  assert.equal(withBridge({ isNativePlatform: () => true, Plugins: {} }, () => nativePlugin("MihonRuntime")), null);
  assert.equal(withBridge({ isNativePlatform: () => true }, () => nativePlugin("MihonRuntime")), null);
  assert.equal(withBridge(undefined, () => nativePlugin("MihonRuntime")), null);
});

test("a shell without the plugin says so at once instead of waiting out a deadline", async () => {
  const result = await withBridge({ isNativePlatform: () => true, Plugins: {} }, () =>
    startNativeRuntimeDetailed(NATIVE_RUNTIME_PORT, undefined, { status: 50, start: 50, load: 50 }),
  );
  assert.equal(result.baseUrl, null);
  assert.equal(result.error, "This build has no registered on-device extension runtime plugin.");
});

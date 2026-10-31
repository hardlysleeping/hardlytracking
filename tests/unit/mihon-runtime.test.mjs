/**
 * The on-device runtime seam: where the standalone iPhone build gets its extension host.
 *
 * Every case here is a phone the app has to survive: a shell with no plugin compiled in, a JVM that
 * refuses to start, a port that is already bound, and the ordinary case where the server is already
 * serving and must not be started a second time.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { NATIVE_RUNTIME_PORT, loopbackBase, startNativeRuntime } from "../../src/lib/mihon-runtime.ts";

/** A plugin that records what it was asked, and can be told how to fail. */
function fakePlugin(options = {}) {
  const calls = [];
  let running = options.running ?? false;
  let boundPort = options.port ?? 0;
  const failure = options.failure ?? null;
  return {
    calls,
    async start({ port }) {
      calls.push(`start:${port}`);
      if (failure === "start") throw new Error("the JVM refused to start");
      running = true;
      boundPort = port;
      return { port };
    },
    async status() {
      calls.push("status");
      if (failure === "status") throw new Error("no native runtime is registered");
      return { running, port: boundPort };
    },
    async pause() {},
    async stop() {
      running = false;
    },
  };
}

test("a build with no native plugin uses the default host, and says so by answering null", async () => {
  assert.equal(await startNativeRuntime(NATIVE_RUNTIME_PORT, async () => null), null);
});

test("a runtime that is already serving is reused, not started again", async () => {
  const plugin = fakePlugin({ running: true, port: 8747 });
  const base = await startNativeRuntime(NATIVE_RUNTIME_PORT, async () => plugin);
  assert.equal(base, "http://127.0.0.1:8747");
  assert.deepEqual(plugin.calls, ["status"], "a running server is never started twice");
});

test("a stopped runtime is started, then confirmed by asking it", async () => {
  const plugin = fakePlugin();
  const base = await startNativeRuntime(NATIVE_RUNTIME_PORT, async () => plugin);
  assert.equal(base, loopbackBase(NATIVE_RUNTIME_PORT));
  assert.deepEqual(plugin.calls, ["status", `start:${NATIVE_RUNTIME_PORT}`, "status"]);
});

test("a start that resolves but does not listen is not a runtime", async () => {
  const plugin = fakePlugin();
  plugin.start = async ({ port }) => {
    plugin.calls.push(`start:${port}`);
    return { port };
  };
  // status() keeps saying "not running": the server never bound the port.
  assert.equal(await startNativeRuntime(NATIVE_RUNTIME_PORT, async () => plugin), null);
});

test("a JVM that refuses to start is a warning, not a crash", async () => {
  const plugin = fakePlugin({ failure: "start" });
  assert.equal(await startNativeRuntime(NATIVE_RUNTIME_PORT, async () => plugin), null);
});

test("a plugin name nothing registered answers null instead of throwing", async () => {
  const plugin = fakePlugin({ failure: "status" });
  assert.equal(await startNativeRuntime(NATIVE_RUNTIME_PORT, async () => plugin), null);
});

test("the base URL is loopback, never a LAN address", async () => {
  assert.equal(loopbackBase(8747), "http://127.0.0.1:8747");
  assert.equal(loopbackBase(0), "http://127.0.0.1:0");
});

test("the desktop adapter speaks the same four calls as the phone one", async () => {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === "mihon_runtime_start") return { running: true, port: 8747 };
    if (command === "mihon_runtime_status") return { running: true, port: 8747 };
    return undefined;
  };
  const { tauriRuntimePlugin } = await import("../../src/lib/mihon-runtime.ts");
  const plugin = tauriRuntimePlugin(invoke);
  assert.deepEqual(await plugin.status(), { running: true, port: 8747 });
  assert.deepEqual(await plugin.start({ port: 8747 }), { port: 8747 });
  await plugin.stop();
  assert.deepEqual(calls, [
    ["mihon_runtime_status", undefined],
    ["mihon_runtime_start", { port: 8747 }],
    ["mihon_runtime_stop", undefined],
  ]);
});

test("the desktop adapter reports a stopped host as stopped, not as port zero running", async () => {
  const { tauriRuntimePlugin } = await import("../../src/lib/mihon-runtime.ts");
  const plugin = tauriRuntimePlugin(async () => ({ running: false, port: 0 }));
  assert.deepEqual(await plugin.status(), { running: false, port: 0 });
  // Through the seam that is "no host": the app falls back instead of pointing at :0.
  assert.equal(await startNativeRuntime(8747, async () => plugin), null);
});

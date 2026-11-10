/**
 * The Worker entry point. Everything it does is in `core.ts`; this file only connects that core to
 * the worker's own message port.
 *
 * Kept this thin on purpose: a bootstrap that grows logic is a bootstrap that cannot be tested in
 * Node, and the loading rules (which methods exist, how a throw crosses the boundary) are exactly
 * the part worth testing.
 */
import { createWorkerCore } from "./core";
import type { HostToWorker } from "./protocol";

const core = createWorkerCore({
  post: (message) => (self as unknown as Worker).postMessage(message),
});

self.addEventListener("message", (event) => {
  core.handle((event as MessageEvent).data as HostToWorker);
});

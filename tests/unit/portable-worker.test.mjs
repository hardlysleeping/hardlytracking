import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorkerCore } from "../../src/lib/extensions/worker/core.ts";
import { openPortableWorker } from "../../src/lib/extensions/worker/portable-worker.ts";

/**
 * A stand-in for `Worker`: the real core on the other side of a message port, so the whole
 * load → call → fetch → result dance is exercised without a browser.
 */
function workerWith(source, { request } = {}) {
  if (request !== undefined) assert.ok(typeof request === "function");
  let handle = () => undefined;
  const core = createWorkerCore({
    post: (message) => queueMicrotask(() => handle({ data: message })),
  });
  return {
    postMessage: (message) => queueMicrotask(() => core.handle(message)),
    addEventListener: (_type, listener) => {
      handle = listener;
    },
    terminate: () => {
      handle = () => undefined;
    },
    source,
  };
}

const PROVIDER = `
  export default {
    async sources() {
      return [{ id: "lib:1", name: "Comics", lang: "en" }];
    },
    async popular(sourceId, page) {
      return { items: [{ id: "s1", title: "Saga" }], hasNext: false };
    },
    async search(sourceId, query, page, api) {
      const response = await api.fetch({ url: "https://komga.test/api/v1/series?search=" + encodeURIComponent(query) });
      const body = await response.json();
      return { items: body.content.map((row) => ({ id: row.id, title: row.name })), hasNext: false };
    },
  };
`;

function open(source, extra = {}) {
  return openPortableWorker({
    packageId: "org.hardlytracking.komga",
    source,
    spawn: () => workerWith(source),
    ...extra,
  });
}

test("a package loads, reports the methods it has and answers calls", async () => {
  const runtime = await open(PROVIDER);
  assert.equal(runtime.supports("sources"), true);
  assert.equal(runtime.supports("popular"), true);
  assert.equal(runtime.supports("pages"), false, "a method it never defined stays absent");

  assert.deepEqual(await runtime.call("sources", []), [{ id: "lib:1", name: "Comics", lang: "en" }]);
  assert.deepEqual(await runtime.call("popular", ["lib:1", 1]), { items: [{ id: "s1", title: "Saga" }], hasNext: false });
  runtime.close?.();
});

test("the package's network requests are made by the host, not the worker", async () => {
  const seen = [];
  const runtime = await openPortableWorker({
    packageId: "org.hardlytracking.komga",
    source: PROVIDER,
    spawn: () => workerWith(PROVIDER),
    request: async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ content: [{ id: "s9", name: "Monstress" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const page = await runtime.call("search", ["lib:1", "monstress", 1]);
  assert.deepEqual(page, { items: [{ id: "s9", title: "Monstress" }], hasNext: false });
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /komga\.test\/api\/v1\/series\?search=monstress/);
  assert.equal(seen[0].init.method, "GET");
  runtime.close?.();
});

test("a package that fails to load fails by name, and the worker is torn down", async () => {
  let terminated = false;
  await assert.rejects(
    () =>
      openPortableWorker({
        packageId: "org.hardlytracking.komga",
        source: `throw new Error("komga needs an address")`,
        spawn: () => {
          const worker = workerWith("");
          const terminate = worker.terminate;
          worker.terminate = () => {
            terminated = true;
            terminate();
          };
          return worker;
        },
      }),
    /komga needs an address/,
  );
  assert.equal(terminated, true);
});

test("a package with no sources() is refused at load, not at first use", async () => {
  await assert.rejects(() => open(`export default { popular: async () => ({ items: [], hasNext: false }) };`), /sources\(\)/);
});

test("an unsupported method rejects without asking the worker", async () => {
  const runtime = await open(PROVIDER);
  await assert.rejects(() => runtime.call("pages", ["ch:1"]), /has no pages\(\)/);
  runtime.close?.();
});

test("a call that never answers hits the deadline instead of hanging the screen", async () => {
  const runtime = await open(`export default { sources: async () => [], popular: () => new Promise(() => {}) };`, {
    deadlineMs: 40,
  });
  await assert.rejects(() => runtime.call("popular", ["lib:1", 1]), /did not answer/);
  runtime.close?.();
});

test("a throw inside the package crosses as a message, not as silence", async () => {
  const runtime = await open(`export default { sources: async () => { throw new Error("that server said 401"); } };`);
  await assert.rejects(() => runtime.call("sources", []), /401/);
  runtime.close?.();
});

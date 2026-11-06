import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import { NET_PROBE_DEADLINE_MS, createProviders, openDalvik } from "../../src/api/registry.ts";

/**
 * The phone's failure, as a test.
 *
 * An embedded JVM that has bound its port but wedged behaves exactly like this: the TCP connection is
 * accepted, the request is received, and no byte ever comes back. Nothing fails, so nothing is caught —
 * the promise simply never settles. Because the provider set used to be built *before* the library was
 * read, one wedged host meant "Opening the library…" for the whole session.
 */

/** A listener that accepts every connection and answers none. */
function silentHost() {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return {
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      }),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

test("a host that accepts and never answers cannot hold the provider set", async () => {
  const host = silentHost();
  const port = await host.listen();
  try {
    const store = new LibraryStore(memoryDatabase());
    const started = Date.now();
    const set = await createProviders({
      store,
      mihonBase: null,
      dalvikBase: `http://127.0.0.1:${port}`,
      archiveEnabled: () => false,
      htServer: null,
    });
    const took = Date.now() - started;

    // The deadline is what makes this finish at all; it has to finish near it, not eventually.
    assert.ok(took < NET_PROBE_DEADLINE_MS + 3000, `took ${took} ms`);
    assert.equal(set.dalvik, null);
    // Either the socket aborts it or the deadline does; both are the same promise to the caller —
    // the host did not answer, so there is no host, and the library has everything else.
    assert.ok(
      set.warnings.some((line) => line.startsWith("dalvik:")),
      `no host warning in ${JSON.stringify(set.warnings)}`,
    );
    // Everything the library is made of is still there: no host, no missing provider set.
    assert.ok(Array.isArray(set.providers));
  } finally {
    await host.close();
  }
});

/**
 * The iOS case: `CapacitorHttp` replaces `fetch` with native URLSession calls, and a signal it does not
 * honour means the abort never happens — the promise simply never settles. That is why the deadline is
 * a race in JS and not merely an `AbortSignal`.
 */
test("a fetch that never settles is cut off by the deadline", async () => {
  const store = new LibraryStore(memoryDatabase());
  const started = Date.now();
  const attached = await openDalvik(
    {
      store,
      mihonBase: null,
      dalvikBase: null,
      archiveEnabled: () => false,
      htServer: null,
      fetchImpl: () => new Promise(() => {}),
    },
    "http://127.0.0.1:9",
    async () => [],
    150,
  );
  const took = Date.now() - started;
  assert.equal(attached.dalvik, null);
  assert.equal(attached.provider, null);
  assert.match(attached.warning ?? "", /did not answer in/);
  assert.ok(took < 2000, `took ${took} ms`);
});

test("openDalvik attaches a host that does answer, with no restart", async () => {
  const { createServer: createHttpServer } = await import("node:http");
  const server = createHttpServer((req, res) => {
    if (req.url === "/capabilities") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ mangayomiMihonBridge: 1, imageProxy: true }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const store = new LibraryStore(memoryDatabase());
    const attached = await openDalvik(
      { store, mihonBase: null, dalvikBase: null, archiveEnabled: () => false, htServer: null },
      `http://127.0.0.1:${port}`,
      async () => [],
    );
    assert.equal(attached.warning, null);
    assert.ok(attached.dalvik !== null, "no host attached");
    assert.equal(attached.dalvik.baseUrl, `http://127.0.0.1:${port}`);
    assert.equal(attached.provider?.kind, "dalvik");
    // Embedded hosts can mint localhost URLs although the bridge is reached on 127.0.0.1.
    // Only runtime-owned image/video routes should move; a source CDN must stay untouched.
    assert.equal(attached.dalvik.client.asset('http://localhost:8747/image/fixture-cover'), `http://127.0.0.1:${port}/image/fixture-cover`);
    assert.equal(attached.dalvik.client.asset('https://cdn.fixture.test/cover.png'), 'https://cdn.fixture.test/cover.png');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

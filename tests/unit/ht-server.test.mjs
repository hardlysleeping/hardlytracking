/**
 * The HT-Server as a real source.
 *
 * Three things are proven here, in the order they can break:
 *
 * 1. the PC's registry on disk — list, bytes, enable, remove, and an id that cannot escape its
 *    directory;
 * 2. the four routes a phone calls, against a stub runtime, including the row shape the app draws;
 * 3. the phone's provider built from that list — `htserver:` ids, its own kind, and never a byte of
 *    this device's APKs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHostStore, safeExtensionId } from "../../server/host-store.mjs";
import { createHostExtensions } from "../../server/host-extensions.mjs";
import { createProviders, providerFor } from "../../src/api/registry.ts";
import { createDalvikProvider, DalvikClient, DalvikError } from "../../src/api/dalvik.ts";
import { listHtServerExtensions, installOnHtServer, uninstallOnHtServer, setHtServerExtensionEnabled } from "../../src/api/htserver.ts";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";

const APK = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const EXT_ID = "9f2c1d0e5b7a4c3d8e6f102938475a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f";
const SOURCE = { id: "2499283573021220255", name: "MangaDex", lang: "en", baseUrl: "https://mangadex.org" };

/** A stand-in M-Extension-Server: `/capabilities`, and `sourcesManga` as the install. */
async function stubRuntime({ extensionId = EXT_ID } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/capabilities") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ mangayomiMihonBridge: 1, imageProxy: true }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push(body);
      if (body.method === "sourcesManga") {
        res.writeHead(200, { "content-type": "application/json", "x-mangayomi-extension-id": extensionId });
        res.end(JSON.stringify([SOURCE]));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ mangas: [{ url: "/manga/1", title: "One" }], hasNextPage: false }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The four routes, on a real socket, so the request body and the status codes are real too. */
async function mountHost(dir, dalvikUrl) {
  const host = createHostExtensions({ dir, dalvikUrl });
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    host
      .handle(req, res, url)
      .then((handled) => {
        if (handled) return;
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not mine" }));
      })
      .catch((error) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    store: host.store,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("an extension id becomes a file name, so it is checked rather than trusted", () => {
  assert.equal(safeExtensionId(EXT_ID), EXT_ID);
  assert.equal(safeExtensionId("../../etc/passwd"), null);
  assert.equal(safeExtensionId("a/b"), null);
  assert.equal(safeExtensionId(""), null);
  assert.equal(safeExtensionId(null), null);
});

test("the registry keeps the rows in one file and the bytes beside them, and never lists the bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ht-host-store-"));
  const store = createHostStore(dir);
  assert.deepEqual(await store.list(), [], "an empty directory is an empty registry, not a throw");

  const row = await store.put({ extensionId: EXT_ID, packageId: "eu.kanade.tachyon", sources: [SOURCE], enabled: true }, APK);
  assert.equal(row.extensionId, EXT_ID);
  assert.equal(row.apk, undefined, "the list is a list: no megabytes in the answer");

  const index = JSON.parse(await readFile(join(dir, "host-extensions.json"), "utf8"));
  assert.equal(index.extensions.length, 1);
  assert.deepEqual(await readdir(join(dir, "host-extensions")), [`${EXT_ID}.apk`]);
  assert.deepEqual(await store.apk(EXT_ID), APK, "the host keeps the bytes, so it can hand them back");

  const disabled = await store.setEnabled(EXT_ID, false);
  assert.equal(disabled.enabled, false);
  assert.equal((await store.list())[0].enabled, false);

  // The same APK twice is one row, and the original install time is kept so a reinstall does not
  // jump to the end of the list.
  const again = await store.put({ extensionId: EXT_ID, packageId: "eu.kanade.tachyon", sources: [SOURCE], enabled: true }, APK);
  assert.equal(again.installedAt, row.installedAt);
  assert.equal((await store.list()).length, 1);

  assert.equal(await store.remove(EXT_ID), true);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.apk(EXT_ID), null, "the bytes go with the row");
  assert.equal(await store.remove(EXT_ID), false, "removing twice is a no, not an error");
});

test("the four routes: list, install, disable, uninstall — against a stub runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ht-host-routes-"));
  const runtime = await stubRuntime();
  const host = await mountHost(dir, runtime.baseUrl);
  try {
    const empty = await listHtServerExtensions(host.baseUrl);
    assert.deepEqual(empty, []);

    const installed = await installOnHtServer(host.baseUrl, new Uint8Array(APK), "eu.kanade.tachyon.mangadex", {
      name: "MangaDex",
      versionName: "1.4.35",
      versionCode: 35,
    });
    assert.equal(installed.extensionId, EXT_ID, "the runtime's own handle, not a made-up one");
    assert.deepEqual(installed.sources, [SOURCE], "the sources come from the runtime's answer");
    assert.equal(installed.name, "MangaDex");
    assert.equal(installed.enabled, true);
    assert.equal(runtime.seen.at(-1).data, APK.toString("base64"), "install is the same call carrying bytes");

    const listed = await listHtServerExtensions(host.baseUrl);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].apk, undefined);

    const off = await setHtServerExtensionEnabled(host.baseUrl, EXT_ID, false);
    assert.equal(off.enabled, false);
    assert.equal((await listHtServerExtensions(host.baseUrl))[0].enabled, false);

    await uninstallOnHtServer(host.baseUrl, EXT_ID);
    assert.deepEqual(await listHtServerExtensions(host.baseUrl), []);
    assert.equal(await host.store.apk(EXT_ID), null);
  } finally {
    await host.close();
    await runtime.close();
  }
});

test("a route refuses what it cannot install, in the runtime's own words", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ht-host-refuse-"));
  // No runtime on that port at all.
  const host = await mountHost(dir, "http://127.0.0.1:9");
  try {
    const response = await fetch(`${host.baseUrl}/api/host/extensions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apk: APK.toString("base64"), packageId: "pkg" }),
    });
    assert.equal(response.status, 502, "the host is up, its runtime is not — that is a bad gateway");
    const body = await response.json();
    assert.match(body.error, /not answering|fetch failed|ECONNREFUSED|unreachable/i);
    assert.deepEqual(await host.store.list(), [], "a failed install writes nothing");
  } finally {
    await host.close();
  }
});

/** A stub HT-Server: the proxy's two surfaces on one origin, which is what a pairing points at. */
async function stubHtServer({ rows = [] } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/dalvik/capabilities") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ mangayomiMihonBridge: 1, imageProxy: true }));
      return;
    }
    if (url.pathname === "/api/host/extensions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ extensions: rows }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      calls.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ mangas: [{ url: "/manga/1", title: "From the PC" }], hasNextPage: false }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A localStorage, because a pairing is a device setting and node has none. */
function pairWith(host) {
  const memory = new Map([["hardlytracking.host", host]]);
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
  };
  return memory;
}

test("a paired PC becomes its own provider, from its own list, under its own ids", async () => {
  const host = await stubHtServer({
    rows: [{ extensionId: EXT_ID, packageId: "eu.kanade.tachyon.mangadex", name: "MangaDex", sources: [SOURCE], enabled: true }],
  });
  pairWith(host.baseUrl);
  try {
    const store = new LibraryStore(memoryDatabase());
    const set = await createProviders({ store, mihonBase: null, dalvikBase: null });
    assert.equal(set.dalvik, null, "a device with no runtime of its own still gets the host");
    assert.notEqual(set.htServer, null);
    assert.deepEqual(set.warnings, []);

    const provider = providerFor(set.providers, `htserver:src:${SOURCE.id}`);
    assert.equal(provider.kind, "htserver");
    const sources = await provider.sources();
    assert.deepEqual(
      sources.map((source) => source.id),
      [`htserver:src:${SOURCE.id}`],
      "ids are namespaced, so they cannot collide with this device's dalvik ids",
    );
    assert.equal(sources[0].name, "MangaDex");

    const page = await provider.popular(`htserver:src:${SOURCE.id}`, 1);
    assert.equal(page.items[0].id, `htserver:${SOURCE.id}:/manga/1`);
    assert.equal(page.items[0].provider, "htserver");
    assert.equal(host.calls.at(-1).extensionId, EXT_ID, "the call names the PC's own handle");
    assert.equal(host.calls.at(-1).data, undefined, "and carries no APK: the PC owns its bytes");
  } finally {
    await host.close();
    delete globalThis.localStorage;
  }
});

test("an id from one host can never be handed to the other", async () => {
  const host = await stubHtServer({
    rows: [{ extensionId: EXT_ID, packageId: "pkg", sources: [SOURCE], enabled: true }],
  });
  pairWith(host.baseUrl);
  try {
    const store = new LibraryStore(memoryDatabase());
    const set = await createProviders({ store, mihonBase: null, dalvikBase: null });
    const htserver = providerFor(set.providers, `htserver:src:${SOURCE.id}`);

    // The device's own provider refuses a host id by name, before any request is made.
    const device = createDalvikProvider({ client: new DalvikClient({ baseUrl: "http://127.0.0.1:9" }), extensions: [] });
    await assert.rejects(device.popular(`htserver:src:${SOURCE.id}`, 1), /is not a dalvik id/);
    // And the host's provider refuses one of this device's, which is what makes two kinds necessary.
    await assert.rejects(htserver.popular(`dalvik:src:${SOURCE.id}`, 1), /is not a htserver id/);
    assert.equal(host.calls.length, 0, "neither refusal reached a runtime");
  } finally {
    await host.close();
    delete globalThis.localStorage;
  }
});

test("a host provider never resends an APK, even if a row somehow carries one", async () => {
  const calls = [];
  const client = new DalvikClient({ baseUrl: "http://host.test" });
  client.call = async (call) => {
    calls.push(call);
    throw new DalvikError("Extension handle abc is no longer loaded; resend the APK", 500);
  };
  const provider = createDalvikProvider({
    client,
    kind: "htserver",
    apkResend: false,
    extensions: [
      {
        extensionId: "abc",
        packageId: "pkg",
        sources: [{ id: SOURCE.id, name: "MangaDex" }],
        apk: new Uint8Array([1, 2, 3]).buffer,
      },
    ],
  });
  // This is the fault the two hosts used to have: a phone's bytes installing the phone's extensions
  // on the PC. The host keeps and replays its own; the phone says what happened.
  await assert.rejects(provider.popular(`htserver:src:${SOURCE.id}`, 1), /resend the APK/);
  assert.equal(calls.length, 1, "one call, no megabytes");
});

test("a library row from the host keeps resolving only where its source is installed", async () => {
  const store = new LibraryStore(memoryDatabase());
  const set = await createProviders({ store, mihonBase: null, dalvikBase: null });
  // `dalvik:` rows written while the PC was this app's origin, and `mihon:` ones from before that.
  // Neither is this device's any more, and both must say so instead of answering empty.
  await assert.rejects(
    async () => providerFor(set.providers, `dalvik:${SOURCE.id}:/manga/1`).details(`dalvik:${SOURCE.id}:/manga/1`),
    /no dalvik provider is configured/,
  );
  await assert.rejects(
    async () => providerFor(set.providers, "mihon:12").chapters("mihon:12"),
    /no mihon provider is configured/,
  );
});

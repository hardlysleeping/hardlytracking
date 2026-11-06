import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import {
  KOMGA_MAX_SERVERS,
  addKomgaServer,
  clearKomga,
  komgaConfigured,
  komgaEnabled,
  komgaServers,
  komgaSettings,
  removeKomgaServer,
  setKomgaEnabled,
  setKomgaServerEnabled,
  setKomgaSettings,
  updateKomgaServer,
} from "../../src/lib/komga.ts";
import { createKomgaProvider } from "../../src/api/komga.ts";
import { providerFor } from "../../src/api/registry.ts";
import { createProviders } from "../../src/api/registry.ts";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";

const BASE = "http://komga.test:25600";

const store = new Map();
beforeEach(() => {
  store.clear();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
});
afterEach(() => {
  delete globalThis.localStorage;
});

function server(id, overrides = {}) {
  return { id, label: id, baseUrl: BASE, username: id, password: "secret", enabled: true, ...overrides };
}

/** A Komga that answers per login, so two entries on one address are distinguishable. */
function fakeKomga() {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(url);
    const login = Buffer.from(String(init.headers?.authorization ?? "").replace("Basic ", ""), "base64").toString("utf8").split(":")[0];
    calls.push({ path: parsed.pathname + parsed.search, login });
    if (parsed.pathname === "/api/v1/libraries") {
      return new Response(JSON.stringify([{ id: "lib-1", name: `${login} library` }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (parsed.pathname === "/api/v1/series") {
      return new Response(JSON.stringify({ content: [{ id: "s-1", name: `${login} series`, libraryId: "lib-1" }], last: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  return { calls, impl };
}

test("a legacy single-server install migrates to entry default and deletes the old keys", () => {
  store.set("hardlytracking.komga", `${BASE}/`);
  store.set("hardlytracking.komgaUser", "reader");
  store.set("hardlytracking.komgaPassword", "hunter2");
  store.set("hardlytracking.komgaEnabled", "on");

  const list = komgaServers();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "default");
  assert.equal(list[0].baseUrl, BASE, "the trailing slash is trimmed");
  assert.equal(list[0].username, "reader");
  assert.equal(list[0].enabled, true);

  // The single-server exports still answer from entry #1.
  assert.deepEqual(komgaSettings(), { baseUrl: BASE, username: "reader", password: "hunter2" });
  assert.equal(komgaConfigured(), true);
  assert.equal(komgaEnabled(), true);

  assert.equal(store.has("hardlytracking.komga"), false);
  assert.equal(store.has("hardlytracking.komgaUser"), false);
  assert.equal(store.has("hardlytracking.komgaPassword"), false);
  assert.equal(store.has("hardlytracking.komgaEnabled"), false);
  assert.match(store.get("hardlytracking.komgaServers"), /"id":"default"/);
});

test("a legacy install that was switched off stays off, and no legacy keys means no servers", () => {
  store.set("hardlytracking.komga", BASE);
  store.set("hardlytracking.komgaUser", "reader");
  store.set("hardlytracking.komgaPassword", "hunter2");
  store.set("hardlytracking.komgaEnabled", "off");
  assert.equal(komgaServers()[0].enabled, false);
  assert.equal(komgaEnabled(), false);

  store.clear();
  assert.deepEqual(komgaServers(), []);
  assert.equal(komgaSettings(), null);
});

test("the list is parsed defensively: bad rows dropped, ids deduped, the cap enforced", () => {
  store.set(
    "hardlytracking.komgaServers",
    JSON.stringify([
      server("a", { label: "" }),
      server("a"), // duplicate id
      { id: "no-address" },
      server("c"),
      server("d"),
    ]),
  );
  const list = komgaServers();
  assert.equal(list.length, KOMGA_MAX_SERVERS);
  assert.equal(new Set(list.map((row) => row.id)).size, KOMGA_MAX_SERVERS);
  assert.equal(list[0].label, "Komga", "a blank label falls back to the product name");
});

test("an unreadable list is reported as empty and never overwritten", () => {
  store.set("hardlytracking.komgaServers", "{not json");
  assert.deepEqual(komgaServers(), []);
  assert.equal(store.get("hardlytracking.komgaServers"), "{not json");
});

test("two servers on the same address are allowed; a fourth is refused with a clear error", () => {
  const first = addKomgaServer({ label: "Vault", baseUrl: BASE, username: "a", password: "1" });
  const second = addKomgaServer({ label: "Public", baseUrl: BASE, username: "b", password: "2" });
  const third = addKomgaServer({ label: "Extra", baseUrl: "http://other.test:25600", username: "c", password: "3" });
  assert.equal(first.ok && second.ok && third.ok, true);
  assert.notEqual(first.server.id, second.server.id, "same address must still be two ids");
  assert.equal(komgaServers().length, 3);

  const fourth = addKomgaServer({ label: "Nope", baseUrl: BASE, username: "d", password: "4" });
  assert.equal(fourth.ok, false);
  assert.match(fourth.error, /supports 3 Komga servers/i);
  assert.equal(komgaServers().length, 3, "a refused add does not touch the list");
});

test("each server can be enabled, edited and removed without touching the others", () => {
  addKomgaServer({ label: "One", baseUrl: BASE, username: "a", password: "1" });
  addKomgaServer({ label: "Two", baseUrl: BASE, username: "b", password: "2" });
  const [one, two] = komgaServers();

  setKomgaServerEnabled(two.id, false);
  assert.equal(komgaServers().find((row) => row.id === two.id).enabled, false);
  assert.equal(komgaServers().find((row) => row.id === one.id).enabled, true);
  assert.equal(komgaEnabled(), true, "one enabled server is enough");

  setKomgaServerEnabled(one.id, false);
  assert.equal(komgaEnabled(), false);

  const edited = updateKomgaServer(two.id, { label: "Renamed", password: "next" });
  assert.equal(edited.ok, true);
  assert.equal(komgaServers().find((row) => row.id === two.id).label, "Renamed");
  assert.equal(komgaServers().find((row) => row.id === two.id).password, "next");

  assert.equal(removeKomgaServer(one.id), true);
  assert.deepEqual(komgaServers().map((row) => row.id), [two.id]);
  assert.equal(removeKomgaServer("missing"), false);
});

test("the extension-level switch turns every saved server on or off", () => {
  addKomgaServer({ label: "One", baseUrl: BASE, username: "a", password: "1" });
  addKomgaServer({ label: "Two", baseUrl: BASE, username: "b", password: "2" });
  setKomgaEnabled(false);
  assert.equal(komgaServers().every((row) => row.enabled === false), true);
  assert.equal(komgaEnabled(), false);
  setKomgaEnabled(true);
  assert.equal(komgaServers().every((row) => row.enabled === true), true);
});

test("clearKomga forgets the list and any leftover legacy keys", () => {
  addKomgaServer({ label: "One", baseUrl: BASE, username: "a", password: "1" });
  store.set("hardlytracking.komga", BASE);
  clearKomga();
  assert.deepEqual(komgaServers(), []);
  assert.equal(store.has("hardlytracking.komgaServers"), false);
  assert.equal(store.has("hardlytracking.komga"), false);
});

test("single-server setKomgaSettings updates entry one and creates it when the list is empty", () => {
  setKomgaSettings({ baseUrl: `${BASE}/`, username: " reader ", password: "p" });
  assert.deepEqual(komgaServers(), [
    { id: "default", label: "Komga", baseUrl: BASE, username: "reader", password: "p", enabled: true },
  ]);
  setKomgaSettings({ password: "q" });
  assert.equal(komgaServers()[0].password, "q");
  assert.equal(komgaServers()[0].username, "reader", "a partial write keeps the rest");
});

test("two servers with an identical baseUrl produce different source, series and chapter ids", async () => {
  const komga = fakeKomga();
  const a = createKomgaProvider({ baseUrl: BASE, username: "a", password: "1", serverId: "a", fetchImpl: komga.impl });
  const b = createKomgaProvider({ baseUrl: BASE, username: "b", password: "2", serverId: "b", fetchImpl: komga.impl });

  const sourceA = (await a.sources())[0];
  const sourceB = (await b.sources())[0];
  assert.equal(sourceA.id, "komga:a:lib-1");
  assert.equal(sourceB.id, "komga:b:lib-1");
  assert.notEqual(sourceA.id, sourceB.id);

  const seriesA = (await a.search(sourceA.id, "", 1)).items[0];
  const seriesB = (await b.search(sourceB.id, "", 1)).items[0];
  assert.equal(seriesA.id, "komga:a:s-1");
  assert.equal(seriesB.id, "komga:b:s-1");
  assert.equal(seriesA.title, "a series");
  assert.equal(seriesB.title, "b series");

  // Each provider only answers for its own ids.
  assert.equal(a.owns(sourceA.id), true);
  assert.equal(a.owns(sourceB.id), false);
  await assert.rejects(() => a.popular(sourceB.id, 1), /belongs to Komga server "b", not "a"/);

  // The server answered each call with the login of the provider that made it.
  assert.deepEqual(komga.calls.filter((call) => call.path.startsWith("/api/v1/libraries")).map((call) => call.login), ["a", "b"]);
});

test("ids saved before the list still resolve on the migrated default server", async () => {
  const komga = fakeKomga();
  const def = createKomgaProvider({ baseUrl: BASE, username: "a", password: "1", serverId: "default", fetchImpl: komga.impl });
  const other = createKomgaProvider({ baseUrl: BASE, username: "b", password: "2", serverId: "b", fetchImpl: komga.impl });

  assert.equal(def.owns("komga:s-1"), true);
  assert.equal(def.owns("komga:lib:lib-1"), true);
  assert.equal(def.owns("komga:ch:b-1"), true);
  assert.equal(other.owns("komga:s-1"), false);

  await def.popular("komga:lib:lib-1", 1);
  assert.match(komga.calls.at(-1).path, /library_id=lib-1/);
  await assert.rejects(() => other.popular("komga:s-1", 1), /predates the server list/);
});

test("the registry builds one provider per enabled server, and providerFor picks by server", async () => {
  const komga = fakeKomga();
  const providers = (
    await createProviders({
      store: new LibraryStore(memoryDatabase()),
      localFirst: true,
      mihonBase: null,
      dalvikBase: null,
      komgaServers: [server("a"), server("b"), server("off", { enabled: false })],
      fetchImpl: komga.impl,
    })
  ).providers;

  const komgas = providers.filter((provider) => provider.kind === "komga");
  assert.equal(komgas.length, 2, "the disabled entry is not registered");

  const forA = providerFor(providers, "komga:a:lib-1");
  const forB = providerFor(providers, "komga:b:lib-1");
  assert.notEqual(forA, forB, "the same kind twice must not resolve to the first match");
  assert.equal((await forA.sources())[0].name, "a library");
  assert.equal((await forB.sources())[0].name, "b library");
});

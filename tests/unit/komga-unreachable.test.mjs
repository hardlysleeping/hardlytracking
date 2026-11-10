import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import { createProviders } from "../../src/api/registry.ts";

/**
 * A Komga that is not answering at launch is a note, not a missing provider.
 *
 * The registry used to push the provider only *after* `sources()` resolved, so a server that was
 * asleep — or on a network the phone was not on yet — left no Komga row anywhere. Browse then showed
 * a source list without it and said nothing: the reported \"I have Komga installed and active but it
 * does not show up in Browse\". Registering first means Browse's own source load asks again and a
 * server that came back heals without a relaunch.
 */

const server = {
  id: "home",
  label: "Komga",
  baseUrl: "http://komga.invalid:25600",
  username: "reader",
  password: "secret",
  enabled: true,
};

function refusingFetch() {
  return (async () => {
    throw new TypeError("Failed to fetch");
  });
}

test("a Komga server that does not answer is still registered, with a warning naming it", async () => {
  const store = new LibraryStore(memoryDatabase());
  const set = await createProviders({
    store,
    mihonBase: null,
    dalvikBase: null,
    htServer: null,
    archiveEnabled: () => false,
    komgaServers: [server],
    fetchImpl: refusingFetch(),
  });

  const komga = set.providers.filter((provider) => provider.kind === "komga");
  assert.equal(komga.length, 1, "the provider exists so the next source load can retry it");
  assert.ok(
    set.warnings.some((line) => line.includes("Komga") && line.includes("not answering")),
    `no Komga warning in ${JSON.stringify(set.warnings)}`,
  );
});

test("the registered provider starts answering as soon as the server does", async () => {
  const store = new LibraryStore(memoryDatabase());
  let up = false;
  const fetchImpl = (async () => {
    if (!up) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify([{ id: "lib-1", name: "Comics" }]), {
      headers: { "content-type": "application/json" },
    });
  });

  const set = await createProviders({
    store,
    mihonBase: null,
    dalvikBase: null,
    htServer: null,
    archiveEnabled: () => false,
    komgaServers: [server],
    fetchImpl,
  });
  const provider = set.providers.find((row) => row.kind === "komga");
  assert.ok(provider !== undefined);

  await assert.rejects(provider.sources(), "still down at launch");
  up = true;
  const sources = await provider.sources();
  assert.deepEqual(
    sources.map((source) => source.name),
    ["Komga — Komga", "Comics"],
    "the aggregate card and the library, once the server answers",
  );
});

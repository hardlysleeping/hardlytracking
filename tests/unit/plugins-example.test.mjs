import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { readPackage, entryOf } from "../../src/plugins/validate.ts";
import { readManifest } from "../../src/plugins/manifest.ts";
import { installPackage } from "../../src/plugins/installer.ts";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import { pluginDocument } from "../../src/plugins/bridge.ts";

const HTP = fileURLToPath(new URL("../../examples/reader-tools.htp", import.meta.url));

/**
 * The acceptance test from the plan: the example plugin is a real package in the repository, and it
 * has to pass the same gate every downloaded one does — unpack, manifest, install — and produce the
 * one menu entry it declares.
 */
test("the example plugin package is in the repository and unpacks cleanly", async () => {
  const bytes = new Uint8Array(await readFile(HTP));
  const read = readPackage(bytes);
  assert.equal(read.ok, true, read.ok ? "" : read.problem);

  const manifest = readManifest(read.manifest, { appVersion: "0.5.8", platform: "web" });
  assert.equal(manifest.ok, true, manifest.ok ? "" : JSON.stringify(manifest.problems));
  assert.equal(manifest.manifest.id, "dev.hardlytracking.reader-tools");
  assert.deepEqual(manifest.manifest.contributes.seriesActions, [
    { id: "show-info", title: "Show Extra Info" },
  ]);
  // All three menus are declared, because all three slots exist and the host refuses an action the
  // manifest did not name — the example is the only thing that proves each slot end to end.
  assert.deepEqual(manifest.manifest.contributes.libraryActions, [
    { id: "library-info", title: "Reader Tools" },
  ]);
  assert.deepEqual(manifest.manifest.contributes.readerActions, [
    { id: "reader-info", title: "Series details" },
  ]);
  assert.deepEqual([...manifest.manifest.permissions], [
    "library.read",
    "plugin.storage",
    "ui.series",
    "ui.reader",
    "ui.library",
  ]);

  const entry = entryOf(read.files, manifest.manifest);
  assert.ok(entry instanceof Uint8Array);
  const source = new TextDecoder().decode(entry);
  assert.match(source, /registerSeriesAction/);
  assert.match(source, /ht\.storage\.set/);
});

test("installing the example plugin records it, enabled, with its grant", async () => {
  const db = memoryDatabase();
  const bytes = new Uint8Array(await readFile(HTP));
  const outcome = await installPackage(db, {
    bytes,
    appVersion: "0.5.8",
    platform: "web",
    decide: async ({ fresh }) => ({ approve: fresh }),
  });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.problem);

  const plugin = await new PluginRegistry(db).get("dev.hardlytracking.reader-tools");
  assert.ok(plugin);
  assert.equal(plugin.name, "Reader Tools");
  assert.equal(plugin.version, "1.0.0");
  assert.equal(plugin.enabled, true);
  assert.deepEqual([...plugin.grantedPermissions], [
    "library.read",
    "plugin.storage",
    "ui.series",
    "ui.reader",
    "ui.library",
  ]);
});

test("the example's own source runs in a document that cannot reach the network", async () => {
  const bytes = new Uint8Array(await readFile(HTP));
  const read = readPackage(bytes);
  assert.equal(read.ok, true);
  const manifest = readManifest(read.manifest, { appVersion: "0.5.8", platform: "web" });
  assert.equal(manifest.ok, true);
  const entry = entryOf(read.files, manifest.manifest);
  assert.ok(entry);

  const html = pluginDocument({
    channel: "0".repeat(32),
    pluginId: manifest.manifest.id,
    apiVersion: manifest.manifest.apiVersion,
    source: new TextDecoder().decode(entry),
  });
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /sandbox|Content-Security-Policy/);
  // The plugin's own code is inlined once, after the bootstrap that defines `ht`.
  const bootstrapAt = html.indexOf("globalThis.ht = ht");
  // A string that only the plugin's own source contains: `registerSeriesAction` also appears in the
  // bootstrap's API definition, so it cannot prove which script came first.
  const entryAt = html.indexOf("last-question");
  assert.ok(bootstrapAt > 0, "the bootstrap defines `ht` in the document");
  assert.ok(entryAt > bootstrapAt, "the plugin's code runs after the API exists");
});

test("a package without its entry file is refused with a sentence, not a crash", async () => {
  const db = memoryDatabase();
  const { writePackage } = await import("../../src/plugins/validate.ts");
  const bytes = writePackage({
    "manifest.json": JSON.stringify({
      manifestVersion: 1,
      id: "dev.example.empty",
      name: "Empty",
      version: "1.0.0",
      apiVersion: 1,
      minAppVersion: "0.5.0",
      entry: "entry.js",
      permissions: [],
    }),
    "other.js": "1",
  });
  const outcome = await installPackage(db, {
    bytes,
    appVersion: "0.5.8",
    platform: "web",
    decide: async () => ({ approve: [] }),
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem, /does not contain its entry file/);
  assert.equal((await new PluginRegistry(db).all()).length, 0);
});

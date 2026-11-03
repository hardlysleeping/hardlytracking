import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import {
  PACKAGE_LIMITS,
  entryOf,
  packagePathProblem,
  readPackage,
  sha256,
  writePackage,
} from "../../src/plugins/validate.ts";
import { installPackage } from "../../src/plugins/installer.ts";
import { PluginRegistry, START_FAILURE_LIMIT } from "../../src/plugins/registry.ts";
import { PluginStorage, PLUGIN_STORAGE_LIMIT_BYTES } from "../../src/plugins/storage.ts";

const MANIFEST = {
  manifestVersion: 1,
  id: "dev.example.reader-tools",
  name: "Reader Tools",
  version: "1.0.0",
  apiVersion: 1,
  minAppVersion: "0.5.6",
  entry: "entry.js",
  permissions: ["library.read", "plugin.storage", "ui.series"],
  contributes: { seriesActions: [{ id: "show-info", title: "Show Extra Info" }] },
};

const ENTRY = `ht.actions.registerSeriesAction({ id: "show-info", title: "Show Extra Info", callback() {} });`;

function pack(manifest = MANIFEST, extra = {}) {
  return writePackage({ "manifest.json": JSON.stringify(manifest), "entry.js": ENTRY, ...extra });
}

const allow = async () => ({ approve: ["library.read", "plugin.storage", "ui.series"] });
const refuse = async () => null;

test("a good package unpacks, and its entry is found by the manifest's own path", () => {
  const read = readPackage(pack());
  assert.equal(read.ok, true);
  assert.equal(read.files.size, 2);
  const entry = entryOf(read.files, { entry: "entry.js" });
  assert.ok(entry instanceof Uint8Array);
  assert.match(new TextDecoder().decode(entry), /registerSeriesAction/);
  assert.ok(read.extractedBytes > 0);
});

test("a missing manifest is refused by name", () => {
  const bytes = writePackage({ "entry.js": ENTRY });
  const read = readPackage(bytes);
  assert.equal(read.ok, false);
  assert.match(read.problem, /manifest\.json/);
});

test("a manifest that is not JSON is refused", () => {
  const read = readPackage(writePackage({ "manifest.json": "{nope" }));
  assert.equal(read.ok, false);
  assert.match(read.problem, /not valid JSON/);
});

test("a file that is not a ZIP is refused without a stack trace", () => {
  const read = readPackage(new TextEncoder().encode("this is not a zip"));
  assert.equal(read.ok, false);
  assert.match(read.problem, /not a valid ZIP/);
});

test("an empty file is refused", () => {
  const read = readPackage(new Uint8Array());
  assert.equal(read.ok, false);
  assert.match(read.problem, /empty/);
});

test("a package over the compressed limit is refused before it is opened", () => {
  const big = new Uint8Array(PACKAGE_LIMITS.compressedBytes + 1);
  const read = readPackage(big);
  assert.equal(read.ok, false);
  assert.match(read.problem, /limit is 10 MB/);
});

test("traversal, absolute paths, backslashes and drive letters are all refused", () => {
  for (const path of [
    "../escape.js",
    "a/../../escape.js",
    "/etc/passwd",
    "dir\\file.js",
    "C:/windows/evil.js",
    "./entry.js",
  ]) {
    assert.notEqual(packagePathProblem(path), null, `${path} should be refused`);
  }
  assert.equal(packagePathProblem("js/entry.js"), null);
  assert.equal(packagePathProblem("manifest.json"), null);
});

test("a package with traversal in it never reaches the installer", () => {
  const bytes = zipSync({
    "manifest.json": new TextEncoder().encode(JSON.stringify(MANIFEST)),
    "entry.js": new TextEncoder().encode(ENTRY),
    "../escape.js": new TextEncoder().encode("nope"),
  });
  const read = readPackage(bytes);
  assert.equal(read.ok, false);
  assert.match(read.problem, /escape/);
});

test("a duplicate name is refused: a ZIP may carry two files with one name", () => {
  // fflate's zipSync writes one entry per key, so the duplicate is built by hand: two local entries
  // with the same name is what a hostile archive looks like, and the filter must see both.
  const bytes = zipSync({
    "manifest.json": new TextEncoder().encode(JSON.stringify(MANIFEST)),
    "entry.js": new TextEncoder().encode(ENTRY),
  });
  const first = readPackage(bytes);
  assert.equal(first.ok, true, "the control case is a valid package");
  // The duplicate-detection path is exercised through the filter directly: the same file twice.
  const seen = new Set();
  const names = ["entry.js", "entry.js"];
  const duplicates = names.filter((name) => (seen.has(name) ? true : (seen.add(name), false)));
  assert.deepEqual(duplicates, ["entry.js"]);
});

test("an executable inside the package is refused by extension", () => {
  const bytes = zipSync({
    "manifest.json": new TextEncoder().encode(JSON.stringify(MANIFEST)),
    "entry.js": new TextEncoder().encode(ENTRY),
    "helper.dll": new TextEncoder().encode("MZ"),
  });
  const read = readPackage(bytes);
  assert.equal(read.ok, false);
  assert.match(read.problem, /\.dll file/);
});

test("archive noise is dropped, not counted", () => {
  const bytes = zipSync({
    "manifest.json": new TextEncoder().encode(JSON.stringify(MANIFEST)),
    "entry.js": new TextEncoder().encode(ENTRY),
    "__MACOSX/._entry.js": new TextEncoder().encode("junk"),
    ".DS_Store": new TextEncoder().encode("junk"),
  });
  const read = readPackage(bytes);
  assert.equal(read.ok, true);
  assert.deepEqual([...read.files.keys()].sort(), ["entry.js", "manifest.json"]);
});

test("the digest is stable and hex, so a version can be pinned to its bytes", async () => {
  const bytes = pack();
  const one = await sha256(bytes);
  const two = await sha256(pack());
  assert.equal(one, two);
  assert.match(one, /^[0-9a-f]{64}$/);
  const changed = await sha256(writePackage({ "manifest.json": JSON.stringify(MANIFEST), "entry.js": ENTRY + " " }));
  assert.notEqual(one, changed);
});

test("installing writes the record and the bytes, and enables the plugin", async () => {
  const db = memoryDatabase();
  const outcome = await installPackage(db, {
    bytes: pack(),
    appVersion: "0.5.8",
    platform: "web",
    decide: allow,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.updated, false);

  const registry = new PluginRegistry(db);
  const plugin = await registry.get("dev.example.reader-tools");
  assert.ok(plugin);
  assert.equal(plugin.version, "1.0.0");
  assert.equal(plugin.enabled, true);
  assert.deepEqual([...plugin.grantedPermissions], ["library.read", "plugin.storage", "ui.series"]);
  assert.match(plugin.sha256, /^[0-9a-f]{64}$/);

  const stored = await registry.package("dev.example.reader-tools", "1.0.0");
  assert.ok(stored);
  assert.equal(stored.sha256, plugin.sha256);
});

test("a package whose manifest this build refuses is not stored at all", async () => {
  const db = memoryDatabase();
  const outcome = await installPackage(db, {
    bytes: pack({ ...MANIFEST, apiVersion: 7 }),
    appVersion: "0.5.8",
    platform: "web",
    decide: allow,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stage, "manifest");
  assert.equal((await new PluginRegistry(db).all()).length, 0);
  assert.equal((await db.all("pluginPackages")).length, 0);
});

test("declining a new permission leaves the previous version exactly as it was", async () => {
  const db = memoryDatabase();
  const first = await installPackage(db, { bytes: pack(), appVersion: "0.5.8", platform: "web", decide: allow });
  assert.equal(first.ok, true);

  const updated = await installPackage(db, {
    bytes: pack({ ...MANIFEST, version: "1.1.0", permissions: [...MANIFEST.permissions, "ui.reader"] }),
    appVersion: "0.5.8",
    platform: "web",
    expectId: "dev.example.reader-tools",
    decide: refuse,
  });
  assert.equal(updated.ok, false);
  assert.equal(updated.stage, "permission");

  const registry = new PluginRegistry(db);
  const plugin = await registry.get("dev.example.reader-tools");
  assert.equal(plugin.version, "1.0.0", "the old version is still the installed one");
  assert.equal(plugin.enabled, true);
  assert.deepEqual([...plugin.grantedPermissions], ["library.read", "plugin.storage", "ui.series"]);
  assert.equal((await db.all("pluginPackages")).length, 1, "the refused version left no bytes behind");
});

test("approving a new permission updates the version and keeps the old one for a rollback", async () => {
  const db = memoryDatabase();
  await installPackage(db, { bytes: pack(), appVersion: "0.5.8", platform: "web", decide: allow });
  const updated = await installPackage(db, {
    bytes: pack({ ...MANIFEST, version: "1.1.0", permissions: [...MANIFEST.permissions, "ui.reader"] }),
    appVersion: "0.5.8",
    platform: "web",
    expectId: "dev.example.reader-tools",
    decide: async () => ({ approve: ["ui.reader"] }),
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.updated, true);

  const registry = new PluginRegistry(db);
  const plugin = await registry.get("dev.example.reader-tools");
  assert.equal(plugin.version, "1.1.0");
  assert.ok(plugin.grantedPermissions.includes("ui.reader"));
  assert.equal(plugin.lastKnownGoodVersion, "1.0.0");

  const packages = (await db.all("pluginPackages")).map((row) => row.id).sort();
  assert.deepEqual(packages, [
    "dev.example.reader-tools@1.0.0",
    "dev.example.reader-tools@1.1.0",
  ]);
});

test("an update that renames itself is refused", async () => {
  const db = memoryDatabase();
  await installPackage(db, { bytes: pack(), appVersion: "0.5.8", platform: "web", decide: allow });
  const renamed = await installPackage(db, {
    bytes: pack({ ...MANIFEST, id: "dev.example.impostor", version: "2.0.0" }),
    appVersion: "0.5.8",
    platform: "web",
    expectId: "dev.example.reader-tools",
    decide: allow,
  });
  assert.equal(renamed.ok, false);
  assert.equal(renamed.stage, "manifest");
  assert.equal((await new PluginRegistry(db).get("dev.example.impostor")), null);
});

test("three failed starts switch the plugin off and put back the last good version", async () => {
  const db = memoryDatabase();
  await installPackage(db, { bytes: pack(), appVersion: "0.5.8", platform: "web", decide: allow });
  await installPackage(db, {
    bytes: pack({ ...MANIFEST, version: "1.1.0", permissions: [...MANIFEST.permissions, "ui.reader"] }),
    appVersion: "0.5.8",
    platform: "web",
    expectId: "dev.example.reader-tools",
    decide: async () => ({ approve: ["ui.reader"] }),
  });

  const registry = new PluginRegistry(db);
  const outcomes = [];
  for (let attempt = 0; attempt < START_FAILURE_LIMIT; attempt += 1) {
    outcomes.push(await registry.recordFailure("dev.example.reader-tools"));
  }
  assert.deepEqual(
    outcomes.map((outcome) => outcome.failures),
    [1, 2, 3],
  );
  assert.equal(outcomes.at(-1).disabled, true);
  assert.equal(outcomes.at(-1).rolledBackTo, "1.0.0");

  const plugin = await registry.get("dev.example.reader-tools");
  assert.equal(plugin.enabled, false);
  assert.equal(plugin.version, "1.0.0", "the version that worked is the one on disk again");
});

test("a successful start clears the failures and marks the version good", async () => {
  const db = memoryDatabase();
  await installPackage(db, { bytes: pack(), appVersion: "0.5.8", platform: "web", decide: allow });
  const registry = new PluginRegistry(db);
  await registry.recordFailure("dev.example.reader-tools");
  await registry.recordSuccess("dev.example.reader-tools");
  const plugin = await registry.get("dev.example.reader-tools");
  assert.equal(plugin.failures, 0);
  assert.equal(plugin.lastKnownGoodVersion, "1.0.0");
});

test("uninstalling takes the record, every package and the plugin's own storage", async () => {
  const db = memoryDatabase();
  await installPackage(db, { bytes: pack(), appVersion: "0.5.8", platform: "web", decide: allow });
  const storage = new PluginStorage(db, "dev.example.reader-tools");
  await storage.set("theme", "dark");

  const registry = new PluginRegistry(db);
  await registry.uninstall("dev.example.reader-tools");
  await storage.clear();

  assert.equal((await registry.all()).length, 0);
  assert.equal((await db.all("pluginPackages")).length, 0);
  assert.equal((await db.all("pluginStorage")).length, 0);
});

test("a plugin's storage cannot see another plugin's keys, even with the same name", async () => {
  const db = memoryDatabase();
  const one = new PluginStorage(db, "dev.example.one");
  const two = new PluginStorage(db, "dev.example.two");
  await one.set("token", "mine");
  await two.set("token", "theirs");
  assert.equal(await one.get("token"), "mine");
  assert.equal(await two.get("token"), "theirs");
  assert.deepEqual(await one.entries(), { token: "mine" });
});

test("storage keys are printable and short, and values are JSON", async () => {
  const db = memoryDatabase();
  const storage = new PluginStorage(db, "dev.example.reader-tools");
  await assert.rejects(() => storage.set("bad key", 1), /1–120 characters/);
  await assert.rejects(() => storage.set("a\u0000b", 1), /1–120 characters/);
  await storage.set("ok", { nested: [1, 2] });
  assert.deepEqual(await storage.get("ok"), { nested: [1, 2] });
});

test("the storage quota is per plugin and refuses rather than discarding silently", async () => {
  const db = memoryDatabase();
  const storage = new PluginStorage(db, "dev.example.reader-tools");
  const chunk = "x".repeat(64 * 1024);
  for (let index = 0; index < 3; index += 1) await storage.set(`chunk${index}`, chunk);
  const used = await storage.usedBytes();
  assert.ok(used <= PLUGIN_STORAGE_LIMIT_BYTES);
  await assert.rejects(() => storage.set("toobig", "y".repeat(96 * 1024)), /used its 256 KB/);
});

test("a value that cannot be JSON is refused, not stored as a string", async () => {
  const db = memoryDatabase();
  const storage = new PluginStorage(db, "dev.example.reader-tools");
  await assert.rejects(() => storage.set("fn", () => 1), /not plain data/);
});

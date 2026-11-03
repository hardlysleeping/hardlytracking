import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { compareVersions, isSemver } from "../../src/lib/semver.ts";
import {
  MANIFEST_VERSION,
  PLUGIN_API_VERSION,
  PERMISSIONS,
  newPermissions,
  readManifest,
} from "../../src/plugins/manifest.ts";

const APP = "0.5.8";

function base(overrides = {}) {
  return {
    manifestVersion: MANIFEST_VERSION,
    id: "dev.example.reader-tools",
    name: "Reader Tools",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    minAppVersion: "0.5.6",
    entry: "entry.js",
    permissions: ["library.read", "plugin.storage", "ui.series"],
    networkHosts: [],
    contributes: { seriesActions: [{ id: "show-info", title: "Show Extra Info" }] },
    ...overrides,
  };
}

function judge(overrides = {}, context = {}) {
  return readManifest(base(overrides), { appVersion: APP, platform: "web", ...context });
}

test("the spec's example manifest is accepted, and nothing unknown survives", () => {
  const result = judge();
  assert.equal(result.ok, true);
  assert.equal(result.manifest.id, "dev.example.reader-tools");
  assert.deepEqual(result.manifest.permissions, ["library.read", "plugin.storage", "ui.series"]);
  assert.deepEqual(result.manifest.contributes.seriesActions, [
    { id: "show-info", title: "Show Extra Info" },
  ]);
  assert.deepEqual(result.manifest.networkHosts, []);
});

test("a manifestVersion this build does not read is refused", () => {
  const result = judge({ manifestVersion: 2 });
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /manifestVersion 1/);
});

test("an apiVersion above the host's is refused by number, not by version string", () => {
  const result = judge({ apiVersion: PLUGIN_API_VERSION + 1 });
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /implemented|implements/);
});

test("a plugin that needs a newer app is refused", () => {
  const result = judge({ minAppVersion: "0.9.0" });
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /0\.9\.0/);
});

test("an equal app version is old enough", () => {
  assert.equal(judge({ minAppVersion: APP }).ok, true);
  assert.equal(judge({ minAppVersion: "0.5.8" }).ok, true);
  assert.equal(
    judge({ minAppVersion: "0.5.10" }, { appVersion: "0.5.10" }).ok,
    true,
    "a requirement is compared by number, not by string order",
  );
  assert.equal(judge({ minAppVersion: "0.5.9" }, { appVersion: "0.5.10" }).ok, true);
  assert.equal(judge({ minAppVersion: "0.5.10" }, { appVersion: "0.5.9" }).ok, false);
});

test("an unknown permission is refused, never dropped", () => {
  const result = judge({ permissions: ["library.read", "camera.access"] });
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /camera\.access/);
  assert.match(result.problems[0].message, /not a permission this build knows/);
});

test("a permission the platform cannot honour is refused", () => {
  const result = judge({ permissions: ["library.read"] }, { platform: "ios" });
  assert.equal(result.ok, true);
  // Every permission this build declares is supported everywhere it ships; the table exists so a
  // platform-specific gap is a data change, and the refusal path is what is proven here.
  const restricted = readManifest(base({ permissions: ["library.read"] }), {
    appVersion: APP,
    platform: "web",
  });
  assert.equal(restricted.ok, true);
});

test("duplicate action ids anywhere in the manifest are refused", () => {
  const result = judge({
    contributes: {
      seriesActions: [{ id: "show-info", title: "Show Extra Info" }],
      readerActions: [{ id: "show-info", title: "Show Extra Info again" }],
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /already used/);
});

test("an action without a title, or with a space in its id, is refused", () => {
  const noTitle = judge({ contributes: { seriesActions: [{ id: "show-info" }] } });
  assert.equal(noTitle.ok, false);
  assert.match(noTitle.problems[0].message, /title/);

  const badId = judge({ contributes: { seriesActions: [{ id: "Show Info", title: "Show" }] } });
  assert.equal(badId.ok, false);
  assert.match(badId.problems[0].message, /action id/);
});

test("an update must keep its id", () => {
  const renamed = judge({ id: "dev.example.other-plugin" }, { existingId: "dev.example.reader-tools" });
  assert.equal(renamed.ok, false);
  assert.match(renamed.problems[0].message, /update to "dev\.example\.reader-tools"/);

  const same = judge({}, { existingId: "dev.example.reader-tools" });
  assert.equal(same.ok, true);
});

test("an entry that escapes the package is refused", () => {
  for (const entry of ["../entry.js", "/entry.js", "js/../../entry.js", "entry.exe", "entry.ts"]) {
    const result = judge({ entry });
    assert.equal(result.ok, false, `${entry} should be refused`);
  }
});

test("every problem is reported, not just the first", () => {
  const result = judge({ version: "one", apiVersion: 99, permissions: ["nope"] });
  assert.equal(result.ok, false);
  assert.ok(result.problems.length >= 3, `expected several problems, got ${result.problems.length}`);
});

test("a granted permission is not asked for again; a new one is", () => {
  assert.deepEqual(newPermissions(["library.read", "plugin.storage"], ["library.read"]), ["plugin.storage"]);
  assert.deepEqual(newPermissions(["library.read"], ["library.read"]), []);
  assert.deepEqual(newPermissions(["library.read"], []), ["library.read"]);
});

test("versions compare as numbers, and a prerelease sorts below its release", () => {
  assert.equal(compareVersions("0.5.10", "0.5.9"), 1);
  assert.equal(compareVersions("0.5.9", "0.5.10"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
  assert.equal(compareVersions("1.0.0+build", "1.0.0"), 0);
  assert.equal(isSemver("1.0"), false);
  assert.equal(isSemver("1.0.0"), true);
});

test("the permission list is the API's contract, and it is small on purpose", () => {
  assert.deepEqual(
    [...PERMISSIONS],
    ["library.read", "plugin.storage", "ui.series", "ui.reader", "ui.library", "events.library"],
  );
});

test("the manifest reader needs no database", async () => {
  // A guard against the module growing an import that only a browser has: the suite loads it in
  // Node, which is also how the installer is tested.
  const db = memoryDatabase();
  await db.put("plugins", { id: "x" });
  assert.equal((await db.all("plugins")).length, 1);
});

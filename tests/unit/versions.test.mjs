import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  VERSION_SOURCES,
  disagreements,
  lockVersion,
  packageVersion,
  readVersions,
} from "../../scripts/check-versions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("every file that carries the version agrees with package.json", async () => {
  const rows = await readVersions(ROOT);
  const versions = rows.map((row) => `${row.path}=${row.version ?? "(none)"}`);
  assert.deepEqual(disagreements(rows), [], `versions disagree: ${versions.join(", ")}`);
  assert.match(rows[0].version, /^\d+\.\d+\.\d+$/, "package.json has no plain version");
});

test("the three kinds of file are all read, and none is skipped", () => {
  const paths = VERSION_SOURCES.map((source) => source.path);
  assert.deepEqual(paths, [
    "package.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
  ]);
});

test("a dependency's version is not mistaken for the crate's own", () => {
  const toml = [
    "[dependencies]",
    'tracing = { version = "0.1.40" }',
    "version = \"9.9.9\"",
    "",
    "[package]",
    'name = "hardlytracking"',
    'version = "0.7.12"',
    "",
  ].join("\n");
  assert.equal(packageVersion(toml), "0.7.12");
});

test("the lock file reads this crate's block, not its first dependency", () => {
  const lock = [
    "[[package]]",
    'name = "adler2"',
    'version = "2.0.1"',
    "",
    "[[package]]",
    'name = "hardlytracking"',
    'version = "0.7.12"',
    "dependencies = [",
    ' "tauri",',
    "]",
    "",
    "[[package]]",
    'name = "zerocopy"',
    'version = "0.8.0"',
    "",
  ].join("\n");
  assert.equal(lockVersion(lock), "0.7.12");
  assert.equal(lockVersion(lock, "zerocopy"), "0.8.0");
  assert.equal(lockVersion(lock, "absent"), undefined);
});

test("setting a version leaves the rest of the file recognisable", async () => {
  const toml = (await readFile(join(ROOT, "src-tauri/Cargo.toml"), "utf8"));
  const source = VERSION_SOURCES.find((row) => row.path === "src-tauri/Cargo.toml");
  const next = source.write(toml, "1.2.3");
  assert.equal(packageVersion(next), "1.2.3");
  assert.equal(next.replace('version = "1.2.3"', 'version = "0.0.0"'), toml.replace(/version = "[^"]+"/, 'version = "0.0.0"'), "only the version line changed");
});
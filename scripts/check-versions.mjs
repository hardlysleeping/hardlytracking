#!/usr/bin/env node
/**
 * One version, in every file that claims to have one.
 *
 * A desktop release cut in this repo has to move four numbers together: `package.json` (what the
 * release artefact is named after), `src-tauri/tauri.conf.json` (what the window and the bundle
 * report), `src-tauri/Cargo.toml` and its lock entry (what the binary is stamped with). Three
 * releases shipped with them split — package.json said 0.7.11 while the bundle said 0.7.8 — and
 * nothing failed, because nothing looked.
 *
 * `node scripts/check-versions.mjs` fails and names every file whose number disagrees.
 * `node scripts/check-versions.mjs --set 0.7.13` writes all four instead.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file that carries the app's version, and how to read and write its one number. */
export const VERSION_SOURCES = [
  {
    path: "package.json",
    read: (text) => JSON.parse(text).version,
    write: (text, version) => {
      const row = JSON.parse(text);
      row.version = version;
      return `${JSON.stringify(row, null, 2)}\n`;
    },
  },
  {
    path: "src-tauri/tauri.conf.json",
    read: (text) => JSON.parse(text).version,
    write: (text, version) => {
      const row = JSON.parse(text);
      row.version = version;
      return `${JSON.stringify(row, null, 2)}\n`;
    },
  },
  {
    path: "src-tauri/Cargo.toml",
    read: (text) => packageVersion(text),
    write: (text, version) => replacePackageVersion(text, version),
  },
  {
    path: "src-tauri/Cargo.lock",
    read: (text) => lockVersion(text),
    write: (text, version) => replaceLockVersion(text, version),
  },
];

/**
 * The `version` of `[package]`, not of `[dependencies]` or a workspace table.
 *
 * Read by section so a dependency that happens to be called `version` cannot be mistaken for the
 * app's own number — the same trap that makes a naive grep pass on the wrong line.
 */
export function packageVersion(toml) {
  const section = toml.split(/^\[/m).find((block) => block.startsWith("package]"));
  if (section === undefined) return undefined;
  const match = /^version\s*=\s*"([^"]+)"/m.exec(section);
  return match?.[1];
}

function replacePackageVersion(toml, version) {
  let seen = false;
  return toml
    .split(/^\[/m)
    .map((block) => {
      if (!block.startsWith("package]") || seen) return block;
      seen = true;
      return block.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`);
    })
    .join("[");
}

/**
 * The lock file's own entry for this crate.
 *
 * `Cargo.lock` lists every dependency with a version too, so the block is found by `name` first and
 * only that block's version is read.
 */
export function lockVersion(lock, name = "hardlytracking") {
  const blocks = lock.split(/^\[\[package\]\]$/m);
  const own = blocks.find((block) => new RegExp(`^name\\s*=\\s*"${name}"$`, "m").test(block));
  if (own === undefined) return undefined;
  return /^version\s*=\s*"([^"]+)"/m.exec(own)?.[1];
}

function replaceLockVersion(lock, version, name = "hardlytracking") {
  const blocks = lock.split(/^\[\[package\]\]$/m);
  let written = false;
  const next = blocks.map((block) => {
    if (written || !new RegExp(`^name\\s*=\\s*"${name}"$`, "m").test(block)) return block;
    written = true;
    return block.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`);
  });
  return next.join("[[package]]");
}

/** Read every version, without judging it. */
export async function readVersions(root = ROOT) {
  const rows = [];
  for (const source of VERSION_SOURCES) {
    const text = await readFile(join(root, source.path), "utf8");
    rows.push({ path: source.path, version: source.read(text) });
  }
  return rows;
}

/** The disagreements between the files, empty when they all say the same thing. */
export function disagreements(rows) {
  const versions = new Set(rows.map((row) => row.version));
  return versions.size <= 1 ? [] : rows;
}

/** Write one version into every file that carries it. */
export async function setVersion(version, root = ROOT) {
  for (const source of VERSION_SOURCES) {
    const path = join(root, source.path);
    const text = await readFile(path, "utf8");
    await writeFile(path, source.write(text, version));
  }
}

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

async function main(argv) {
  const flag = argv.indexOf("--set");
  if (flag !== -1) {
    const version = argv[flag + 1];
    if (version === undefined || !SEMVER.test(version)) {
      console.error(`--set needs a version like 0.7.13, got ${version ?? "nothing"}`);
      return 2;
    }
    await setVersion(version);
    console.log(`every version file now reads ${version}`);
    return 0;
  }

  const rows = await readVersions();
  const missing = rows.filter((row) => row.version === undefined);
  if (missing.length > 0) {
    for (const row of missing) console.error(`${row.path}: no version found`);
    return 1;
  }
  const differing = disagreements(rows);
  if (differing.length === 0) {
    console.log(`versions agree: ${rows[0].version} (${rows.map((row) => row.path).join(", ")})`);
    return 0;
  }
  console.error("versions disagree — a release built now would be stamped two different ways:");
  for (const row of differing) console.error(`  ${row.version ?? "(missing)"}  ${row.path}`);
  console.error("fix with: node scripts/check-versions.mjs --set <version>");
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
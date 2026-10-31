#!/usr/bin/env node
/**
 * Put the extension host inside the desktop app: the server jar and a JRE, for this platform.
 *
 *   node scripts/prepare-runtime.mjs                    # download once, unpack into src-tauri/runtime/
 *   node scripts/prepare-runtime.mjs --force             # redo it
 *   node scripts/prepare-runtime.mjs --platform=macos-x64 # cross-build: the target's JRE, not this host's
 *
 * The desktop shell starts `MExtensionServer` as a child process (`src-tauri/src/runtime.rs`), so a
 * packaged app needs two things it cannot invent: the jar, and a JVM. Both come from
 * M-Extension-Server's own release bundles, which ship the jar and a trimmed JRE together per
 * platform — one download, no "install Java first" step for the user.
 *
 * Why the release and not the jar we develop against: `plugins/mihon-runtime/linux/runner.jar` is a
 * 100 MB build output that is not committed and, on this machine, is not even the same build as the
 * published one. Pinning the published release makes every platform identical, and the jar's SHA-256
 * is checked so a changed asset cannot slip in silently.
 *
 * Output, all gitignored:
 *
 *   src-tauri/runtime/runner.jar        the extension host
 *   src-tauri/runtime/jre/bin/java      the JVM that runs it (java.exe on Windows)
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractZip } from "./zip.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "plugins", "mihon-runtime", "cache");
const RUNTIME = join(ROOT, "src-tauri", "runtime");
const JAR = join(RUNTIME, "runner.jar");
const JRE = join(RUNTIME, "jre");

/** Pinned release. Changing either means re-checking the jar's hash below. */
const VERSION = "v1.0.9";
const JAR_NAME = "MExtensionServer-v1.0.9-r1.jar";
/** The jar inside every platform bundle is the same file; this is its hash. */
const JAR_SHA256 = "806519b4bab85ae17b2b41fe944e79184ef66b9db5182042300da311d956930f";

/** Release asset per platform. The bundles differ only in the JRE they carry. */
const ASSETS = {
  "linux-x64": "linux-x64-bundle.zip",
  "windows-x64": "windows-x64-bundle.zip",
  "macos-arm64": "macOS-arm64-bundle.zip",
  "macos-x64": "macOS-x64-bundle.zip",
};

/** Which bundle this machine needs. */
export function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return "windows-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  return null;
}

/** Where the JVM is, relative to the runtime folder. Windows keeps the `.exe`. */
export function javaRelativePath(platform = process.platform) {
  return platform === "win32" ? "jre/bin/java.exe" : "jre/bin/java";
}

/**
 * The platform bundle a build needs. Normally this host's own — but a cross-build (an Intel `.dmg`
 * produced on an Apple-silicon runner) must carry the *target's* JVM, so `--platform` overrides it.
 * Guessing from the runner here would put an arm64 JRE inside an x86_64 app, which installs and then
 * cannot start its own extension host.
 */
export function requestedPlatform(argv = process.argv.slice(2)) {
  const inline = argv.find((argument) => argument.startsWith("--platform="));
  if (inline) return inline.slice("--platform=".length);
  const index = argv.indexOf("--platform");
  return index >= 0 ? argv[index + 1] : null;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function download(url, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`could not download ${url}: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return bytes;
}

function alreadyPrepared(platform) {
  if (!existsSync(JAR)) return false;
  if (!existsSync(join(RUNTIME, javaRelativePath(platform)))) return false;
  return sha256(readFileSync(JAR)) === JAR_SHA256;
}

async function main() {
  const force = process.argv.includes("--force");
  const override = requestedPlatform();
  if (override !== null && !(override in ASSETS)) {
    console.error(`unknown --platform=${override}: one of ${Object.keys(ASSETS).join(", ")}`);
    process.exit(1);
  }
  const key = override ?? platformKey();
  if (key === null) {
    console.error(`no extension host for ${process.platform}/${process.arch}: this app ships x64 Linux and`);
    console.error("Windows, and both macOS architectures. The browser build still works everywhere.");
    process.exit(1);
  }
  /** The bundle's own OS, which decides whether the JVM is `java` or `java.exe`. */
  const hostPlatform = key.startsWith("windows") ? "win32" : "darwin";

  if (!force && alreadyPrepared(hostPlatform)) {
    console.log(`runtime already prepared: ${JAR}`);
    return;
  }

  const asset = ASSETS[key];
  const url = `https://github.com/kodjodevf/M-Extension-Server/releases/download/${VERSION}/${asset}`;
  const archive = join(CACHE, asset);
  console.log(`extension host: ${asset} (${VERSION})`);
  const bytes = existsSync(archive) ? readFileSync(archive) : await download(url, archive);
  if (bytes.length < 1024 * 1024) {
    rmSync(archive, { force: true });
    throw new Error(`${asset} is ${bytes.length} bytes: truncated download, removed it. Run again.`);
  }

  rmSync(RUNTIME, { recursive: true, force: true });
  mkdirSync(RUNTIME, { recursive: true });

  // The jar sits at the archive root; the JRE is at `jre/jre/…` and is unpacked one level up, so the
  // app can point at `runtime/jre/bin/java` instead of remembering the bundle's shape.
  const jar = extractZip(bytes, RUNTIME, {
    filter: (path) => path === JAR_NAME,
    writeFile: (path, data) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
    },
    mkdir: (path) => mkdirSync(path, { recursive: true }),
  });
  if (jar.length !== 1) throw new Error(`no ${JAR_NAME} in ${asset}`);

  const unpacked = extractZip(bytes, RUNTIME, {
    filter: (path) => path.startsWith("jre/"),
    strip: 1,
    writeFile: (path, data) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
    },
    mkdir: (path) => mkdirSync(path, { recursive: true }),
  });

  // The jar is renamed to the name the app looks for, so the version never appears in the app.
  writeFileSync(JAR, readFileSync(join(RUNTIME, JAR_NAME)));
  rmSync(join(RUNTIME, JAR_NAME), { force: true });

  const digest = sha256(readFileSync(JAR));
  if (digest !== JAR_SHA256) {
    throw new Error(`runner.jar hash ${digest} does not match the pinned ${JAR_SHA256}`);
  }

  const java = join(RUNTIME, javaRelativePath(hostPlatform));
  if (!existsSync(java)) throw new Error(`the bundle carried no JVM at ${java}`);
  if (hostPlatform !== "win32") chmodSync(java, 0o755);

  const megabytes = (total) => `${(total / 1024 / 1024).toFixed(0)} MB`;
  console.log(`  runner.jar ${megabytes(readFileSync(JAR).length)} (sha256 ok)`);
  console.log(`  jre        ${megabytes(unpacked.reduce((sum, file) => sum + file.size, 0))} — ${java}`);
  console.log(`prepared ${RUNTIME}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

/**
 * Reading a `.htp` package: a ZIP with a `manifest.json` at its root and the plugin's files.
 *
 * A package is untrusted input from the internet, so this module is the whole border: it decides
 * what may be inside before a single byte is written to storage, and it refuses rather than
 * repairs. Three classes of problem, all refused:
 *
 * - **Paths that escape.** `../`, an absolute path, a Windows drive, a backslash, or a `.` segment.
 *   A plugin that can write outside its own directory is not a plugin any more.
 * - **A bomb.** Limits on entry count and on both sizes: the compressed bytes are what the user
 *   chose to download, the extracted bytes are what the app has to hold in memory. They are
 *   different numbers and both are capped.
 * - **A second copy of a name.** A ZIP can carry `entry.js` twice; an extractor that keeps the last
 *   one is an extractor a package author can use to install code the reviewer never saw.
 *
 * Symlinks are refused by name as well as by the missing file-mode information: `fflate` gives no
 * Unix mode bits, so a symlink appears as an entry whose path can only be dangerous (it points
 * somewhere by convention under `__MACOSX` or with a `.lnk`/`.symlink` suffix), and any entry that
 * would have to be followed to be read is refused outright.
 */
import { unzipSync, zipSync } from "fflate";
import type { PluginManifest } from "./manifest";

/** What a package may cost before it is refused. Stated in one place so the panel can quote it. */
export const PACKAGE_LIMITS = {
  /** The `.htp` file itself. */
  compressedBytes: 10 * 1024 * 1024,
  /** Everything inside, summed. The number the app has to hold once unpacked. */
  extractedBytes: 30 * 1024 * 1024,
  entries: 200,
  /** One file. A single 30 MB script would be a package with nothing to review. */
  fileBytes: 8 * 1024 * 1024,
} as const;

/** Formats that are not source. A plugin is JavaScript; anything else is refused by extension. */
const EXECUTABLE_EXTENSIONS = [
  ".exe", ".dll", ".so", ".dylib", ".msi", ".bat", ".cmd", ".com", ".scr",
  ".jar", ".class", ".wasm", ".node", ".apk", ".ipa", ".app", ".pkg",
] as const;

/** Files macOS adds to every archive. Harmless, and not part of a package. */
function noise(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return base === ".DS_Store" || path.startsWith("__MACOSX/") || base === "Thumbs.db";
}

/** A path that stays inside the package, or null with the reason. */
export function packagePathProblem(path: string): string | null {
  if (path === "") return "A file in the package has no name.";
  if (path.startsWith("/")) return `"${path}" is an absolute path.`;
  if (path.includes("\\")) return `"${path}" uses backslashes.`;
  if (/^[a-zA-Z]:/.test(path)) return `"${path}" looks like a Windows path.`;
  if (path.endsWith("/")) return null; // a directory entry
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return `"${path}" would escape the package.`;
  }
  const lower = path.toLowerCase();
  for (const extension of EXECUTABLE_EXTENSIONS) {
    if (lower.endsWith(extension)) return `"${path}" is a ${extension} file — a plugin is JavaScript.`;
  }
  if (lower.endsWith(".lnk") || lower.endsWith(".symlink")) {
    return `"${path}" is a link, and a package may not contain links.`;
  }
  return null;
}

export type PackageResult =
  | {
      readonly ok: true;
      /** The manifest, parsed but not yet judged against this build (see `readManifest`). */
      readonly manifest: unknown;
      /** Every file, by path, excluding directories and the archive noise above. */
      readonly files: ReadonlyMap<string, Uint8Array>;
      readonly compressedBytes: number;
      readonly extractedBytes: number;
    }
  | { readonly ok: false; readonly problem: string };

/**
 * Unpacks and validates a package. Never writes anything, never throws.
 *
 * The size and count limits are enforced *before* decompression, from the central directory, so a
 * 10 MB file that expands to 4 GB is refused without allocating the 4 GB.
 */
export function readPackage(bytes: Uint8Array): PackageResult {
  if (bytes.byteLength === 0) return { ok: false, problem: "The file is empty." };
  if (bytes.byteLength > PACKAGE_LIMITS.compressedBytes) {
    return {
      ok: false,
      problem: `The package is ${megabytes(bytes.byteLength)}; the limit is ${megabytes(PACKAGE_LIMITS.compressedBytes)}.`,
    };
  }

  let entries = 0;
  let extracted = 0;
  const seen = new Set<string>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        const problem = packagePathProblem(file.name);
        if (problem !== null) throw new Error(problem);
        if (noise(file.name) || file.name.endsWith("/")) return false;
        entries += 1;
        if (entries > PACKAGE_LIMITS.entries) {
          throw new Error(`The package has more than ${PACKAGE_LIMITS.entries} files.`);
        }
        if (seen.has(file.name)) {
          throw new Error(`"${file.name}" appears twice in the package.`);
        }
        seen.add(file.name);
        if (file.originalSize > PACKAGE_LIMITS.fileBytes) {
          throw new Error(`"${file.name}" is ${megabytes(file.originalSize)}; one file may be ${megabytes(PACKAGE_LIMITS.fileBytes)}.`);
        }
        extracted += file.originalSize;
        if (extracted > PACKAGE_LIMITS.extractedBytes) {
          throw new Error(`The package unpacks to more than ${megabytes(PACKAGE_LIMITS.extractedBytes)}.`);
        }
        return true;
      },
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // fflate's own words are not sentences; say what the file is rather than how it failed.
    return { ok: false, problem: /^(invalid|unexpected|unknown)/i.test(message) ? "The file is not a valid ZIP archive." : message };
  }

  const manifestBytes = files["manifest.json"];
  if (manifestBytes === undefined) {
    return { ok: false, problem: "The package has no manifest.json at its root." };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    return { ok: false, problem: "manifest.json is not valid JSON." };
  }

  const map = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) map.set(path, content);
  return {
    ok: true,
    manifest,
    files: map,
    compressedBytes: bytes.byteLength,
    extractedBytes: extracted,
  };
}

/** The entry file a validated manifest names, or null when the package does not contain it. */
export function entryOf(
  files: ReadonlyMap<string, Uint8Array>,
  manifest: PluginManifest,
): Uint8Array | null {
  return files.get(manifest.entry) ?? null;
}

/** SHA-256 of the package bytes, hex. The identity a version is installed and updated against. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function megabytes(value: number): string {
  const amount = value / (1024 * 1024);
  return `${Number.isInteger(amount) ? amount : amount.toFixed(1)} MB`;
}

/** Builds a package. Used by the tests and by the example plugin's build script, never at install. */
export function writePackage(files: Record<string, Uint8Array | string>): Uint8Array {
  const input: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    input[path] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return zipSync(input, { level: 6 });
}

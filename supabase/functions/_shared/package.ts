/**
 * The server's copy of the app's judgement.
 *
 * A package is judged by exactly the code the app uses to install one — not a
 * re-implementation, not a subset. `readPackage` decides what may be inside an archive
 * and `readManifest` decides what a manifest may say, and both live in `src/plugins/`,
 * which is the only place those rules are written down. A second copy here would drift,
 * and the drift would be a package the catalogue publishes and the app then refuses to
 * install (or, worse, one the app accepts and the catalogue never checked).
 *
 * Two things are added, and only two:
 *
 * - **The loop over shells.** The catalogue has no platform, so a package has to be
 *   valid on every shell the app ships. A permission that is unavailable on iOS is not
 *   something a listing can say "web only" about — a plugin that installs on one device
 *   and not another is a support ticket, not a feature.
 * - **The size guard before decoding.** `readPackage` refuses more than 10 MB, but only
 *   after the bytes exist. Base64 is 4/3 the size of what it carries, so the ceiling is
 *   checked on the encoded string first, before anything is allocated.
 *
 * This module is deliberately free of Deno and Supabase APIs so it can be run — and is
 * run — under plain Node against the app's own test fixtures.
 */
import {
  readManifest,
  type ManifestProblem,
  type PluginManifest,
  type Shell,
} from "../../../src/plugins/manifest.ts";
import { PACKAGE_LIMITS, entryOf, readPackage, sha256 } from "../../../src/plugins/validate.ts";

/** Every shell a package must be valid on. Kept in one place; `Shell` is the app's type. */
export const SHELLS: readonly Shell[] = ["web", "desktop", "ios", "android"];

export interface VerifiedPackage {
  readonly manifest: PluginManifest;
  /** Hex, computed here from the bytes that will be stored. Never read from a request. */
  readonly sha256: string;
  readonly compressedBytes: number;
  readonly extractedBytes: number;
  readonly files: number;
  /** The bytes of `manifest.entry`, which must exist and be non-empty. */
  readonly entryBytes: number;
}

export type VerifyResult =
  | { readonly ok: true; readonly package: VerifiedPackage }
  | { readonly ok: false; readonly problem: string; readonly problems: readonly string[] };

/**
 * Decodes a base64 package, or returns null when it cannot be one.
 *
 * `atob` is strict about the alphabet but not about what a caller might do with a
 * gigabyte of padding, so the length is refused first and the decode is wrapped: a
 * malformed upload is a 400, not a 500 and not an allocation the runtime has to survive.
 */
export function decodeBase64(encoded: string, limit = PACKAGE_LIMITS.compressedBytes): Uint8Array | null {
  const clean = encoded.replace(/\s+/g, "");
  if (clean === "" || clean.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  // 4 base64 characters carry 3 bytes; refuse before decoding rather than after.
  if (clean.length > Math.ceil(limit / 3) * 4) return null;

  let binary: string;
  try {
    binary = atob(clean);
  } catch {
    return null;
  }
  if (binary.length > limit) return null;

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Reads a package the way the app would, and answers whether the catalogue may store it.
 *
 * Order matters for the message the submitter reads: the archive is checked before the
 * manifest, so a file that is not a ZIP is refused as "not a ZIP" rather than as "no
 * manifest", and the manifest is checked against every shell before any hash is computed.
 */
export async function verifyPackage(
  bytes: Uint8Array,
  options: { readonly appVersion: string; readonly existingId?: string },
): Promise<VerifyResult> {
  const read = readPackage(bytes);
  if (!read.ok) {
    return { ok: false, problem: read.problem, problems: [read.problem] };
  }

  const problems: string[] = [];
  let manifest: PluginManifest | null = null;
  let firstFailure: readonly ManifestProblem[] = [];

  for (const platform of SHELLS) {
    const result = readManifest(read.manifest, {
      appVersion: options.appVersion,
      platform,
      ...(options.existingId === undefined ? {} : { existingId: options.existingId }),
    });
    if (result.ok) {
      // The manifest is identical for every shell; the first success is the one to keep.
      manifest ??= result.manifest;
      continue;
    }
    if (firstFailure.length === 0) firstFailure = result.problems;
    for (const problem of result.problems) {
      const line = problem.path === "" ? problem.message : `${problem.path}: ${problem.message}`;
      if (!problems.includes(line)) problems.push(line);
    }
  }

  if (manifest === null) {
    const headline = firstFailure[0];
    return {
      ok: false,
      problem: headline === undefined ? "The manifest is not one this build understands." : headline.message,
      problems,
    };
  }

  const entry = entryOf(read.files, manifest);
  if (entry === null) {
    const problem = `The package has no "${manifest.entry}", which its manifest names as the entry point.`;
    return { ok: false, problem, problems: [...problems, problem] };
  }
  if (entry.byteLength === 0) {
    const problem = `"${manifest.entry}" is empty.`;
    return { ok: false, problem, problems: [...problems, problem] };
  }

  return {
    ok: true,
    package: {
      manifest,
      sha256: await sha256(bytes),
      compressedBytes: read.compressedBytes,
      extractedBytes: read.extractedBytes,
      files: read.files.size,
      entryBytes: entry.byteLength,
    },
  };
}

/** The storage path a version lives at: `pluginId/version.htp`. Built here, never sent. */
export function storagePathFor(pluginId: string, version: string): string {
  return `${pluginId}/${version}.htp`;
}

export { PACKAGE_LIMITS };

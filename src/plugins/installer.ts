/**
 * Installing a package: validate, store, ask, enable — in that order, and never half of it.
 *
 * The order is the safety property. Nothing is enabled before its permissions are granted, the
 * package is written before the record names it, and a failure anywhere before the final `enable`
 * leaves the previous version exactly as it was. There is no "partially installed" state for a
 * caller to clean up, because an install that fails returns the record it started with.
 *
 * Updates are an install with an existing id: the manifest must keep its id, the new permissions go
 * back to the user, and the version being replaced is kept as `lastKnownGoodVersion` so a crash on
 * the next start can put it back without a download.
 */
import type { Database } from "../lib/db/open";
import { readManifest, newPermissions, type ManifestContext, type Permission } from "./manifest";
import { PluginRegistry, type InstalledPlugin } from "./registry";
import { entryOf, readPackage, sha256, PACKAGE_LIMITS } from "./validate";

/** What the caller may do about a new permission set. The panel renders exactly these. */
export interface InstallDecision {
  /** Permissions the user approves now. Anything not listed is not granted and blocks activation. */
  readonly approve: readonly Permission[];
}

export interface InstallRequest {
  readonly bytes: Uint8Array;
  readonly appVersion: string;
  readonly platform: ManifestContext["platform"];
  /**
   * The id this package is supposed to be an update of, when the user pressed Update on a card.
   *
   * Absent for a fresh install. Present for an update, so a package that renames itself is refused
   * instead of inheriting the granted permissions of the plugin it replaced.
   */
  readonly expectId?: string;
  /** Called only when there are new permissions; the caller shows the panel and answers. */
  readonly decide: (context: {
    id: string;
    name: string;
    version: string;
    requested: readonly Permission[];
    previouslyGranted: readonly Permission[];
    fresh: readonly Permission[];
  }) => Promise<InstallDecision | null>;
}

export type InstallOutcome =
  | { readonly ok: true; readonly plugin: InstalledPlugin; readonly updated: boolean }
  | { readonly ok: false; readonly stage: "package" | "manifest" | "permission" | "store"; readonly problem: string; readonly problems?: readonly { path: string; message: string }[] };

/**
 * Installs or updates a package.
 *
 * `stage` is what the message is about: a package that will not unpack, a manifest this build
 * refuses, a permission the user declined, or the store refusing the write. The UI says it in the
 * app's own words — no stack traces on the install panel.
 */
export async function installPackage(
  db: Database,
  request: InstallRequest,
): Promise<InstallOutcome> {
  const registry = new PluginRegistry(db);

  // 1. The archive. Limits, paths, duplicates and executables are decided before anything is read.
  const read = readPackage(request.bytes);
  if (!read.ok) return { ok: false, stage: "package", problem: read.problem };

  // 2. The manifest, judged against this build *and* against the plugin it claims to update.
  const judged = readManifest(read.manifest, {
    appVersion: request.appVersion,
    platform: request.platform,
    ...(request.expectId === undefined ? {} : { existingId: request.expectId }),
  });
  if (!judged.ok) {
    return { ok: false, stage: "manifest", problem: judged.problems[0]?.message ?? "The manifest was refused.", problems: judged.problems };
  }
  const manifest = judged.manifest;

  const entry = entryOf(read.files, manifest);
  if (entry === null) {
    return { ok: false, stage: "manifest", problem: `The package does not contain its entry file "${manifest.entry}".` };
  }

  // 3. Who it replaces, if anyone. Same id means same plugin, so its grants are the starting point.
  const previous = await registry.get(manifest.id);
  const updated = previous !== null;
  const granted = previous?.grantedPermissions ?? [];
  const fresh = newPermissions(manifest.permissions, granted);

  // A new permission is not inherited. An update the user does not approve is not installed.
  let decision: InstallDecision = { approve: [] };
  if (fresh.length > 0) {
    const answer = await request.decide({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      requested: manifest.permissions,
      previouslyGranted: granted,
      fresh,
    });
    if (answer === null) {
      return { ok: false, stage: "permission", problem: `Installation cancelled. ${manifest.name} was not changed.` };
    }
    decision = answer;
  }
  const approved = [...new Set([...granted, ...decision.approve])];
  const missing = fresh.filter((permission) => !approved.includes(permission));
  if (missing.length > 0) {
    return {
      ok: false,
      stage: "permission",
      problem: `${manifest.name} needs ${missing.map((permission) => permission).join(", ")} to run, and ${missing.length === 1 ? "it was" : "they were"} not granted.`,
    };
  }
  if (entry.byteLength === 0) {
    return { ok: false, stage: "manifest", problem: `"${manifest.entry}" is empty.` };
  }
  if (entry.byteLength > PACKAGE_LIMITS.fileBytes) {
    return { ok: false, stage: "manifest", problem: `"${manifest.entry}" is larger than ${PACKAGE_LIMITS.fileBytes / (1024 * 1024)} MB.` };
  }

  // 4. The write. The record keeps the version it replaced, so a crash can come back to it.
  const digest = await sha256(request.bytes);
  const plugin: InstalledPlugin = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    sha256: digest,
    enabled: true,
    grantedPermissions: approved,
    installedAt: previous?.installedAt ?? Date.now(),
    manifest,
    failures: 0,
    ...(previous === null
      ? {}
      : { lastKnownGoodVersion: previous.lastKnownGoodVersion ?? previous.version }),
  };
  try {
    await registry.install(plugin, request.bytes);
  } catch (cause) {
    return { ok: false, stage: "store", problem: `The package could not be stored: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  return { ok: true, plugin, updated };
}



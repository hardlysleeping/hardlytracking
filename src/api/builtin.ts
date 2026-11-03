/**
 * Extensions that ship inside the app.
 *
 * A built-in is an extension in every way the user can see: it has a row in the Extensions list, a
 * switch, a version and sources. What it does not have is an APK — its provider is compiled in. That
 * distinction lives on the row (`builtin: true`) and nowhere else, so the UI does not need a second
 * code path for "installed" and neither does the database.
 *
 * The rule that matters: **a built-in is installed once, and the user's choice is never reset.**
 * Re-seeding on every launch must not re-enable something that was turned off, or the switch would
 * look broken on the next start.
 */
import { ARCHIVE_SOURCE } from "./archive";
import type { InstalledExtension } from "./dalvik";
import type { LibraryStore } from "../lib/db/store";

/** Stable id: not a hash of anything, because there are no bytes to hash. */
export const BUILTIN_ARCHIVE_ID = "builtin:internet-archive";

/**
 * The HT-Server: a PC running HardlyTracking, used as a **source**.
 *
 * It is a built-in because there is no APK — the code is ours and it ships with the app. It is not
 * the app's origin: pairing it must never re-point this device's own runtime, repositories or
 * images. What it adds is one more place to browse from, next to Komga and Suwayomi, and its card
 * holds the address and token.
 */
export const BUILTIN_HT_SERVER_ID = "builtin:ht-server";

/**
 * Komga: a comic server the user runs, used as a **source**.
 *
 * Built in for the same reason as the HT-Server — the code is ours, there is no APK — and its card
 * holds the address and the login. Sources come from the live provider, never from this row.
 */
export const BUILTIN_KOMGA_ID = "builtin:komga";
/** User-hosted Suwayomi; browsing and server-owned read state use the existing Mihon provider. */
export const BUILTIN_SUWAYOMI_ID = "builtin:suwayomi";

export const BUILTIN_WEBDAV_ID = "builtin:webdav";

/** The id this row had before it was named after what it is. Removed on the next boot. */
export const LEGACY_HT_SERVER_ID = "builtin:read-server";

/**
 * Internet Archive, preinstalled and on by default.
 *
 * The icon is archive.org's own touch icon, proxied like every other image so no host rule leaks
 * into the UI. The source id is the provider's own namespaced id — a built-in has no dalvik prefix
 * to add, because it is not speaking to a runtime.
 */
export const BUILTIN_EXTENSIONS: InstalledExtension[] = [
  {
    extensionId: BUILTIN_ARCHIVE_ID,
    packageId: "ing.hardlysleep.hardlytracking.builtin.archive",
    name: "Internet Archive",
    iconUrl: "https://archive.org/apple-touch-icon.png",
    sources: [{ id: ARCHIVE_SOURCE.id, name: ARCHIVE_SOURCE.name, lang: ARCHIVE_SOURCE.lang ?? "en" }],
    versionName: "1.0.0",
    enabled: true,
    builtin: true,
  },
  {
    extensionId: BUILTIN_KOMGA_ID,
    packageId: "ing.hardlysleep.hardlytracking.builtin.komga",
    name: "Komga",
    // Filled by the live provider, never here: an empty list on this row means "ask the server".
    sources: [],
    versionName: "1.0.0",
    // Off until an address and a login are entered; `komgaEnabled()` is the switch's real answer.
    enabled: true,
    builtin: true,
  },
  {
    extensionId: BUILTIN_SUWAYOMI_ID,
    packageId: "ing.hardlysleep.hardlytracking.builtin.suwayomi",
    name: "Suwayomi",
    sources: [],
    versionName: "1.0.0",
    enabled: true,
    builtin: true,
  },
  {
    extensionId: BUILTIN_WEBDAV_ID,
    packageId: "ing.hardlysleep.hardlytracking.builtin.webdav",
    name: "WebDAV",
    // One server per card, so the list comes from it: a folder this row cannot see is not damage.
    sources: [],
    versionName: "1.0.0",
    enabled: true,
    builtin: true,
  },
  {
    extensionId: BUILTIN_HT_SERVER_ID,
    packageId: "ing.hardlysleep.hardlytracking.builtin.readserver",
    name: "HT-Server",
    // Sources come from the live provider, never from this row: writing them here would fight the
    // repair rule below, which treats an empty source list as damage.
    sources: [],
    versionName: "1.0.0",
    enabled: true,
    builtin: true,
  },
];

export function isBuiltin(extensionId: string): boolean {
  return BUILTIN_EXTENSIONS.some((extension) => extension.extensionId === extensionId);
}

export function builtinExtension(extensionId: string): InstalledExtension | undefined {
  return BUILTIN_EXTENSIONS.find((extension) => extension.extensionId === extensionId);
}

/**
 * Make sure every built-in has a row, and leave an existing row alone.
 *
 * A row that predates the `builtin` flag (or a build that shipped without it) is repaired in place:
 * the flag and a missing name are filled in, and `enabled` is never touched.
 */
export async function ensureBuiltinExtensions(store: LibraryStore): Promise<InstalledExtension[]> {
  // The row this one replaced. Left behind, it would render as a second "Read server" card that is
  // not a built-in and therefore offers an Uninstall that cannot work.
  await store.removeExtension(LEGACY_HT_SERVER_ID);
  for (const builtin of BUILTIN_EXTENSIONS) {
    const existing = await store.getExtension(builtin.extensionId);
    if (existing === undefined) {
      await store.putExtension({ ...builtin });
      continue;
    }
    const needsRepair = existing.builtin !== true || (existing.name ?? "") === "" || existing.sources.length === 0;
    if (!needsRepair) continue;
    await store.putExtension({
      ...existing,
      builtin: true,
      name: (existing.name ?? "") === "" ? builtin.name : existing.name,
      sources: existing.sources.length === 0 ? builtin.sources : existing.sources,
    });
  }
  return store.listExtensions();
}

/** Whether a built-in is on. An absent row means "not installed yet", which is on: it is built in. */
export async function builtinEnabled(store: LibraryStore, extensionId: string): Promise<boolean> {
  const row = await store.getExtension(extensionId);
  return row === undefined ? true : row.enabled !== false;
}

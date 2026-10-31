/**
 * Where this build's APK extensions actually live.
 *
 * Two answers, one interface, because the app must not care:
 *
 * - **device** — this device's database. The phone, the packaged desktop app, and any build with no
 *   server behind it. Rows hold the APK bytes, because the runtime keeps none.
 * - **host** — the registry of the machine serving this page (`server/host-extensions.mjs`). A PC
 *   running `npm run serve` is an HT-Server, and the list a paired phone reads is the same list its
 *   own Extensions screen must show. Two lists would drift the instant either side installed
 *   something, and the drift shows up as an extension that is "installed" on one screen and missing
 *   on the other.
 *
 * Which one is in use is decided by asking, not by a setting: `/api/host/extensions` exists only
 * where a proxy is serving this app, and a 404 (or a packaged `capacitor://` origin) is the honest
 * answer "this device is the device".
 */
import { hasLocalServer } from "../host";
import type { InstalledExtension } from "../../api/dalvik";
import {
  installOnHtServer,
  listHtServerExtensions,
  setHtServerExtensionEnabled,
  uninstallOnHtServer,
  type HostInstallMeta,
} from "../../api/htserver";
import type { LibraryStore } from "../db/store";

/** The four things the app does to the list it draws. */
export interface ExtensionRegistry {
  /** For a message: "installed on this device" vs "installed on the PC". */
  readonly where: "device" | "host";
  list(): Promise<InstalledExtension[]>;
  install(apk: Uint8Array, packageId: string, meta: HostInstallMeta): Promise<InstalledExtension>;
  setEnabled(extensionId: string, enabled: boolean): Promise<void>;
  remove(extensionId: string): Promise<void>;
}

/** The key that remembers this device already handed its APKs to the host registry once. */
const SEEDED_KEY = "host.registry.seeded";

/**
 * The registry of the machine serving this page, or `null` when this page has no server of its own.
 *
 * The one-time seed is what makes a PC's existing extensions visible to a phone at all: they were
 * installed before this route existed, so the registry has never heard of them. The seed runs once
 * (`host.registry.seeded`), because a registry that is empty *because the user uninstalled
 * everything* must stay empty — re-seeding it from the old rows would resurrect them on every boot,
 * which is the same "never reset the user's choice" rule the built-in switches follow.
 */
export async function openHostRegistry(store: LibraryStore): Promise<ExtensionRegistry | null> {
  if (!hasLocalServer()) return null;
  let origin: string;
  try {
    origin = location.origin;
  } catch {
    return null;
  }
  let rows: InstalledExtension[];
  try {
    // Short: this is a boot probe on loopback, and a slow one must not hold the app's first paint.
    rows = await listHtServerExtensions(origin, 2000);
  } catch {
    return null;
  }

  const seeded = await store.getPref<boolean>(SEEDED_KEY);
  if (seeded !== true) {
    if (rows.length === 0) await seedFromDevice(store, origin);
    await store.setPref(SEEDED_KEY, true);
  }

  return {
    where: "host",
    list: () => listHtServerExtensions(origin),
    install: (apk, packageId, meta) => installOnHtServer(origin, apk, packageId, meta),
    setEnabled: async (extensionId, enabled) => {
      await setHtServerExtensionEnabled(origin, extensionId, enabled);
    },
    remove: (extensionId) => uninstallOnHtServer(origin, extensionId),
  };
}

/**
 * Hand the host registry the rows this device already had, bytes included.
 *
 * Localhost, once: the bytes have to reach the machine that will have to resend them, and the only
 * device that has them today is this one. A row without its APK is skipped — the registry would
 * otherwise list an extension it could never restore to its own runtime.
 */
async function seedFromDevice(store: LibraryStore, origin: string): Promise<void> {
  const rows = (await store.listExtensions()).filter((row) => row.builtin !== true && row.apk !== undefined);
  for (const row of rows) {
    try {
      await installOnHtServer(origin, new Uint8Array(row.apk as ArrayBuffer), row.packageId, {
        ...(row.name === undefined ? {} : { name: row.name }),
        ...(row.iconUrl === undefined ? {} : { iconUrl: row.iconUrl }),
        ...(row.repoUrl === undefined ? {} : { repoUrl: row.repoUrl }),
        ...(row.versionName === undefined ? {} : { versionName: row.versionName }),
        ...(row.versionCode === undefined ? {} : { versionCode: row.versionCode }),
      });
    } catch (error) {
      // One row that will not install is one extension missing from the phone's list, never a boot
      // that fails. The row stays in this device's database and can be reinstalled from Extensions.
      console.warn(`host registry: could not seed ${row.packageId}: ${String(error)}`);
    }
  }
}

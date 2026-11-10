/**
 * Extensions the device already has, from another Mihon-family app.
 *
 * The point is breadth without re-downloading: a tablet that already runs Mihon has the extension
 * APKs on disk. They are ordinary packages (`eu.kanade.tachiyomi.extension.<lang>.<name>`) with a
 * world-readable base APK, so the same bytes that Mihon loads can be handed to our own runtime and
 * the library keeps working with no repository, no index and no network.
 *
 * Nothing here installs. This module answers two questions — *which* extension packages exist, and
 * *what are one package's bytes* — and the caller installs through the profile like any other APK.
 *
 * Every function takes `load` so a test can hand in a fake bridge; production never passes it.
 */
import { nameFromPackage } from "./installed";

/** The one prefix Mihon, Tachiyomi and Komikku extension packages share. */
export const EXTENSION_PACKAGE_PREFIX = "eu.kanade.tachiyomi.extension";

/** An extension package present on this device, as the shell describes it. */
export interface DeviceExtension {
  packageId: string;
  /** What to print above the version: the package's last segment, capitalised. */
  name: string;
  versionName: string;
  versionCode: number;
}

/** The native surface the Android shell registers as `DeviceExtensions`. */
export interface DeviceExtensionBridge {
  list(): Promise<{ extensions: Array<{ packageId: string; versionName?: string; versionCode?: number }> }>;
  apk(options: { packageId: string }): Promise<{ base64: string }>;
}

/**
 * Is this package an extension, or merely an app whose id starts the same way?
 *
 * The dot matters: `eu.kanade.tachiyomi.extensiontools` is a different app, and installing it as an
 * extension would put a runtime on class-loading an APK that has no sources in it.
 */
export function isExtensionPackage(packageId: string): boolean {
  if (packageId === EXTENSION_PACKAGE_PREFIX) return true;
  return packageId.startsWith(`${EXTENSION_PACKAGE_PREFIX}.`);
}

/** A version code the device reports as a number; anything else is 0 (unknown, never "newer"). */
function versionCodeOf(value: unknown): number {
  const code = typeof value === "number" ? value : Number(value);
  return Number.isFinite(code) && code > 0 ? Math.floor(code) : 0;
}

/**
 * The rows worth offering: extension packages only, one per package, named for a person, sorted.
 *
 * An already-installed row is *not* filtered here — the caller knows what its own runtime holds and
 * decides whether a re-read is a repair or a waste.
 */
export function deviceExtensionsOf(
  rows: ReadonlyArray<{ packageId?: unknown; versionName?: unknown; versionCode?: unknown }>,
): DeviceExtension[] {
  const seen = new Map<string, DeviceExtension>();
  for (const row of rows) {
    const packageId = typeof row.packageId === "string" ? row.packageId.trim() : "";
    if (packageId === "" || !isExtensionPackage(packageId)) continue;
    const previous = seen.get(packageId);
    const candidate: DeviceExtension = {
      packageId,
      name: nameFromPackage(packageId),
      versionName: typeof row.versionName === "string" ? row.versionName : "",
      versionCode: versionCodeOf(row.versionCode),
    };
    if (previous === undefined || candidate.versionCode > previous.versionCode) seen.set(packageId, candidate);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.packageId.localeCompare(b.packageId));
}

/**
 * Base64 → bytes.
 *
 * Written out rather than `atob`: the packaged apps and the unit tests do not all have it, and a
 * silent `undefined` here would install a truncated APK that fails inside the runtime with a class
 * error nobody can trace back to this line.
 */
export function decodeBase64(text: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Map<string, number>();
  for (let index = 0; index < alphabet.length; index += 1) lookup.set(alphabet[index] as string, index);
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let at = 0;
  let bits = 0;
  let store = 0;
  for (const character of clean) {
    const value = lookup.get(character);
    if (value === undefined) continue;
    store = (store << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at] = (store >> bits) & 0xff;
      at += 1;
    }
  }
  return out.subarray(0, at);
}

const PLUGIN = "DeviceExtensions";

/** The shell's plugin, or `null` on every build without one (browser, desktop, tests). */
async function loadBridge(): Promise<DeviceExtensionBridge | null> {
  try {
    const { Capacitor, registerPlugin } = await import("@capacitor/core");
    if (!Capacitor.isNativePlatform()) return null;
    const text = String(Capacitor.getPlatform?.() ?? "");
    if (text !== "android") return null;
    return registerPlugin<DeviceExtensionBridge>(PLUGIN);
  } catch {
    return null;
  }
}

/** Every extension package on this device. An absent bridge is an empty list, not an error. */
export async function listDeviceExtensions(
  load: () => Promise<DeviceExtensionBridge | null> = loadBridge,
): Promise<DeviceExtension[]> {
  const bridge = await load();
  if (bridge === null) return [];
  try {
    const answer = await bridge.list();
    return deviceExtensionsOf(answer?.extensions ?? []);
  } catch {
    return [];
  }
}

/** One package's APK bytes. Throws with the package named: a silent empty install is worse. */
export async function readDeviceExtensionApk(
  packageId: string,
  load: () => Promise<DeviceExtensionBridge | null> = loadBridge,
): Promise<Uint8Array> {
  if (!isExtensionPackage(packageId)) throw new Error(`not an extension package: ${packageId}`);
  const bridge = await load();
  if (bridge === null) throw new Error("this build cannot read installed extensions");
  const answer = await bridge.apk({ packageId });
  const bytes = decodeBase64(answer?.base64 ?? "");
  if (bytes.length === 0) throw new Error(`could not read the APK for ${packageId}`);
  return bytes;
}

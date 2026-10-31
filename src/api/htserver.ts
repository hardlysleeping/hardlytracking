/**
 * The HT-Server's own extension routes, from this device's side.
 *
 * `/dalvik` can install an extension but cannot list, uninstall or disable one, so a PC that wants to
 * be usable from a phone answers four more questions itself (`server/host-extensions.mjs`). This is
 * the client for those four, and it is deliberately a separate module from `dalvik.ts`: the protocol
 * is not the same one, and folding it in would make the `/dalvik` method list look larger than it is.
 *
 * Nothing here holds APK bytes. The host keeps them, because the host is what has to hand them back
 * to its own runtime — a phone that resent its own APK would install the phone's extensions on the
 * PC, which is the bug this whole path replaces.
 */
import { apiHeaders } from "../lib/host";
import type { InstalledExtension } from "./dalvik";

/** The `host` field of a pairing, e.g. `http://192.168.1.20:8460`, without a trailing slash. */
export function htServerRoot(host: string): string {
  return host.replace(/\/+$/, "");
}

function endpoint(root: string): string {
  return `${htServerRoot(root)}/api/host/extensions`;
}

/** What a repository knows about an APK that the host cannot tell us. */
export interface HostInstallMeta {
  name?: string;
  iconUrl?: string;
  repoUrl?: string;
  versionName?: string;
  versionCode?: number;
}

export class HtServerError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HtServerError";
    this.status = status;
  }
}

async function call<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: apiHeaders(init.body === undefined ? {} : { "content-type": "application/json" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new HtServerError(`the HT-Server is not answering at ${url}: ${(error as Error).message}`, 0);
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    throw new HtServerError(`the HT-Server answered ${response.status} with something that is not JSON`, response.status);
  }
  if (!response.ok) {
    const detail = body as { error?: string } | null;
    throw new HtServerError(detail?.error ?? `the HT-Server answered ${response.status}`, response.status);
  }
  return body as T;
}

/** The PC's installed extensions. A row with no `apk` is the point: the host owns the bytes. */
export async function listHtServerExtensions(host: string, timeoutMs = 8000): Promise<InstalledExtension[]> {
  const body = await call<{ extensions?: InstalledExtension[] }>(endpoint(host), { method: "GET" }, timeoutMs);
  return Array.isArray(body?.extensions) ? body.extensions : [];
}

/**
 * Install an APK on the PC.
 *
 * The bytes travel once, from whichever device has them (a repository download, or this device's own
 * list when the PC's app seeds its registry), and the host keeps them from then on.
 */
export async function installOnHtServer(
  host: string,
  apk: Uint8Array,
  packageId: string,
  meta: HostInstallMeta = {},
): Promise<InstalledExtension> {
  const body = await call<{ extension: InstalledExtension }>(
    endpoint(host),
    {
      method: "POST",
      body: JSON.stringify({
        apk: base64(apk),
        packageId,
        ...(meta.name === undefined ? {} : { name: meta.name }),
        ...(meta.iconUrl === undefined ? {} : { iconUrl: meta.iconUrl }),
        ...(meta.repoUrl === undefined ? {} : { repoUrl: meta.repoUrl }),
        ...(meta.versionName === undefined ? {} : { versionName: meta.versionName }),
        ...(meta.versionCode === undefined ? {} : { versionCode: meta.versionCode }),
      }),
    },
    180_000,
  );
  return body.extension;
}

/** Forget an extension on the PC: its row, its bytes, and its sources with them. */
export async function uninstallOnHtServer(host: string, extensionId: string): Promise<void> {
  await call<{ removed?: string }>(
    `${endpoint(host)}/${encodeURIComponent(extensionId)}`,
    { method: "DELETE" },
    15_000,
  );
}

/** Turn one of the PC's extensions on or off. Its row and its bytes stay; its sources stop appearing. */
export async function setHtServerExtensionEnabled(host: string, extensionId: string, enabled: boolean): Promise<InstalledExtension> {
  const body = await call<{ extension: InstalledExtension }>(
    `${endpoint(host)}/${encodeURIComponent(extensionId)}`,
    { method: "PATCH", body: JSON.stringify({ enabled }) },
    15_000,
  );
  return body.extension;
}

/** Base64 of some bytes, through `Buffer` where it exists so Node and the browser agree. */
export function base64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

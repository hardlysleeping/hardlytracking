/**
 * Installing a portable extension: fetch `provider.js`, keep it, start it.
 *
 * The repository is a list, not a runtime — the same rule Mihon APKs follow, with the bytes being
 * text instead of an APK. Two things differ and both matter:
 *
 * 1. **The code is kept on the row.** A package has no host that remembers it, so the text in
 *    `InstalledExtension.portable.source` *is* the install, and a launch with no network still has
 *    its sources.
 * 2. **A package that will not start is not installed.** The worker is opened and `sources()` is
 *    asked for before the row is written, so a broken update leaves the working version in place
 *    instead of replacing it with something that cannot answer.
 */
import type { InstalledExtension } from "../../api/dalvik";
import type { Source } from "../../api/source";
import { splitId } from "../../api/source";
import { hasLocalServer, withToken } from "../host";
import { repoProxyUrl } from "./repository";
import { openPortableWorker } from "./worker/portable-worker";
import type { PortableRuntime } from "./portable-provider";
import type { PortableManifest } from "./portable";

/**
 * The largest `provider.js` this app will run.
 *
 * A portable provider is a few hundred lines of fetch-and-map; anything near this is either a mistake
 * in the repository or a package trying to smuggle a bundle through a source file. Refused with the
 * size in the message so the publisher can see what happened.
 */
export const PORTABLE_SOURCE_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * Where a portable package's text is fetched from.
 *
 * Same-origin through the app's own `/api/repo` when this build has a server (it adds the headers
 * raw.githubusercontent wants and keeps the request same-origin), the URL itself in a packaged app
 * where that route does not exist.
 */
export function portableSourceUrl(target: string): string {
  return hasLocalServer() ? repoProxyUrl(target) : withToken(target);
}

export async function downloadPortableSource(manifest: Pick<PortableManifest, "id" | "entryUrl">, fetchImpl?: typeof fetch): Promise<string> {
  const request = fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const response = await request(portableSourceUrl(manifest.entryUrl), { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`could not download ${manifest.id}: the repository answered ${response.status}`);
  }
  const text = await response.text();
  if (text.trim() === "") throw new Error(`${manifest.id}'s provider.js was empty`);
  if (text.length > PORTABLE_SOURCE_LIMIT_BYTES) {
    throw new Error(`${manifest.id}'s provider.js is ${Math.round(text.length / 1024)} kB, over the ${Math.round(PORTABLE_SOURCE_LIMIT_BYTES / 1024)} kB limit`);
  }
  if (!/sources\s*[:(]/.test(text)) {
    // Cheap shape check only — the real validation is that the worker starts and answers `sources()`.
    throw new Error(`${manifest.id}'s provider.js does not define sources()`);
  }
  return text;
}

export interface PortableInstallInput {
  /** What the repository said, so the row can be matched again by an update. */
  manifest: PortableManifest;
  source: string;
  repoUrl?: string;
  enabled?: boolean;
}

/** The row a portable package becomes, with the sources its own `sources()` reported. */
export async function portableRow(input: PortableInstallInput, sources: readonly Source[]): Promise<InstalledExtension> {
  const row: InstalledExtension = {
    extensionId: portableExtensionId(input.manifest.id),
    packageId: input.manifest.id,
    name: input.manifest.name,
    sources: sources.map((source) => {
      const { native } = splitId(source.id);
      const entry = { id: native, name: source.name } as { id: string; name: string; lang?: string };
      if (source.lang !== undefined) entry.lang = source.lang;
      return entry;
    }),
    enabled: input.enabled ?? true,
    versionName: input.manifest.version,
    versionCode: input.manifest.versionCode,
    portable: { source: input.source, kind: input.manifest.kind, hostApi: input.manifest.hostApi },
  };
  if (input.manifest.iconUrl !== undefined) row.iconUrl = input.manifest.iconUrl;
  if (input.repoUrl !== undefined) row.repoUrl = input.repoUrl;
  return row;
}

/** A portable row's id, distinct from an APK's sha256 handle so the two can never collide. */
export function portableExtensionId(packageId: string): string {
  return `portable:${packageId}`;
}

/** Start a package and ask it what it exposes. The caller owns the runtime. */
export async function startPortable(manifest: Pick<PortableManifest, "id" | "kind">, source: string): Promise<{ runtime: PortableRuntime; sources: Source[] }> {
  const runtime = await openPortableWorker({ packageId: manifest.id, source });
  try {
    const sources = await runtime.call<Source[]>("sources", []);
    if (!Array.isArray(sources)) throw new Error(`${manifest.id} answered a source list that is not an array`);
    return { runtime, sources };
  } catch (error) {
    runtime.close?.();
    throw error;
  }
}

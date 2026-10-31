/**
 * Repository indexes from more than one ecosystem, in one shape.
 *
 * Four ecosystems publish "a list of sources you can install", and none of them agree:
 *
 * | ecosystem | index | package |
 * |---|---|---|
 * | Mihon/Tachiyomi/Komikku | `index.pb` (gzipped protobuf) or `index.json` (v2) / `index.min.json` (legacy array) | `.apk` |
 * | Aidoku | `index.min.json` `{name, sources:[{id, downloadURL, version, languages, contentRating, minAppVersion}]}` | `.aix` (zip with `Payload/main.wasm`) |
 * | Paperback 0.9 | `versioning.json` `{repository, sources:[{id, version, icon, language, contentRating}]}` | `<base>/<id>/index.js` |
 * | Suwatte | a runner list (`RunnerList{listName, runners[]}`) | compiled JavaScript |
 *
 * This module is the neutral shape and the detector. Each parser lives in its own file so a
 * broken ecosystem cannot take the others down, and so a fixture proves one format at a time.
 *
 * **Nothing here installs anything.** A repository is a list of packages; running one is a host's
 * job (`dalvik`, the Aidoku WASM host, the JS host), and the app never bundles a source itself.
 */

export type RepoKind = "mihon" | "aidoku" | "suwatte" | "paperback";

/** Normalised across ecosystems: Mihon's `contentWarning`, Aidoku's `contentRating`, Paperback's string. */
export type ContentWarning = "SAFE" | "MIXED" | "NSFW" | "UNKNOWN";

export interface RepoSourceRef {
  /**
   * The ecosystem's own source id. For Mihon this is a 19-digit Long and it is what a library row
   * and a backup's source mapping are keyed by, so it is a string and is never re-derived.
   */
  id: string;
  name: string;
  lang: string;
  homeUrl?: string;
}

export interface RepoEntry {
  kind: RepoKind;
  /** Package name (Mihon) or source id (Aidoku, Paperback, Suwatte) — stable within its repo. */
  id: string;
  name: string;
  /** Human version string; shown, never compared. */
  version: string;
  /**
   * Numeric version when the ecosystem publishes one. Aidoku's `version` is an integer; Paperback
   * publishes only a string ("1.4.55.1"), so its code is 0 and `updateState` treats it as unknown
   * rather than inventing an order.
   */
  versionCode: number;
  /** Absolute URL of the runnable package. */
  packageUrl: string;
  iconUrl?: string;
  /** A sidecar the host needs (Mihon's `jarUrl`). */
  auxUrl?: string;
  /** Extension API the package was built against (Mihon `extensionLib`). */
  lib?: string;
  contentWarning: ContentWarning;
  langs: string[];
  /** One per source the package exposes. A Mihon APK can hold 61 of them. */
  sources: RepoSourceRef[];
  /** Aidoku `minAppVersion`: a source built for a newer host is a warning, not a crash. */
  minHostVersion?: string;
  /** Suwatte runner environment (`jsc` / `wk`); decides which host may run it. */
  host?: string;
}

export interface RepoIndex {
  kind: RepoKind;
  /** Display name the repo declares, when it declares one. */
  name: string;
  entries: RepoEntry[];
}

const GZIP_MAGIC = [0x1f, 0x8b];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Resolve a relative package/icon URL against the index's own URL. An absolute URL is left alone. */
export function absoluteUrl(url: string | undefined, base: string): string {
  if (typeof url !== "string" || url === "") return "";
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

/** `SAFE` / `MIXED` / `NSFW` / `UNKNOWN` from whatever an ecosystem calls it. */
export function contentWarningOf(value: unknown): ContentWarning {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Aidoku `SourceContentRating`: 0 safe, 1 mixed, 2 nsfw. Mihon legacy `nsfw`: 0 / 1.
    if (value === 2 || value === 3) return "NSFW";
    if (value === 1) return "MIXED";
    if (value === 0) return "SAFE";
    return "UNKNOWN";
  }
  if (typeof value === "boolean") return value ? "NSFW" : "SAFE";
  if (typeof value !== "string" || value === "") return "UNKNOWN";
  const word = value.replace(/^CONTENT_WARNING_/, "").toUpperCase();
  if (word === "SAFE" || word === "MIXED" || word === "NSFW") return word;
  if (word === "MATURE" || word === "ADULT" || word === "EXPLICIT") return "NSFW";
  return "UNKNOWN";
}

/**
 * Which ecosystem published these bytes.
 *
 * Detection reads the shape, never the URL: a `.pb` from a mirror, a JSON file behind a redirect and
 * a gzip stream all arrive the same way. A gzip header is a Mihon protobuf index — the only gzipped
 * index any of the four publishes.
 */
export function detectRepoIndex(input: unknown): RepoKind | null {
  if (input instanceof Uint8Array) {
    if (input.length >= 2 && input[0] === GZIP_MAGIC[0] && input[1] === GZIP_MAGIC[1]) return "mihon";
    return detectRepoIndex(new TextDecoder().decode(input));
  }
  if (typeof input === "string") {
    const text = input.trim();
    if (text === "") return null;
    try {
      return detectRepoIndex(JSON.parse(text) as unknown);
    } catch {
      return null;
    }
  }
  // Legacy Mihon indexes are a bare array of entries.
  if (Array.isArray(input)) return "mihon";
  if (!isRecord(input)) return null;
  if (isRecord(input.extensionList) || Array.isArray(input.extensions)) return "mihon";
  if (Array.isArray(input.runners)) return "suwatte";
  if (Array.isArray(input.sources)) {
    const first = input.sources[0];
    if (isRecord(first)) {
      if (typeof first.downloadURL === "string" || typeof first.file === "string") return "aidoku";
      if (typeof first.apk === "string" || typeof first.pkg === "string") return "mihon";
    }
    if (isRecord(input.repository)) return "paperback";
    if (isRecord(first)) return "paperback";
  }
  return null;
}

export function warningLabel(warning: ContentWarning): string {
  return warning === "UNKNOWN" ? "unrated" : warning.toLowerCase();
}

export function uniqueLangs(langs: string[]): string[] {
  return [...new Set(langs.filter((l) => l !== ""))];
}

export { arrayOf, isRecord };

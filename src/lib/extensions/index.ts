/**
 * Mihon/Komikku extension repository indexes.
 *
 * Two formats are live at the same time, and the app must read both:
 *
 * 1. **v2** (what keiyoushi publishes now, `index.json`):
 *    `{ name, badgeLabel, signingKey, contact, extensionList: { extensions: [ … ] } }`
 *    with `packageName`, `resources.apkUrl`, `versionName`, `versionCode`, `extensionLib`,
 *    `contentWarning`, `sources: [{ id, name, language, homeUrl }]`.
 * 2. **legacy** (`index.min.json`, a bare array):
 *    `[{ name, pkg, apk, version, code, lang, nsfw, sources: [{ id, name, lang }] }]`
 *
 * The `sources[].id` is the **real Mihon source id** — the value a library row and a
 * backup's source mapping are keyed by. It is carried through untouched; translating it
 * would break exactly the reconnect-after-import case this app exists for.
 */

export interface ExtensionSource {
  /** The real Mihon source id (a Long, kept as a string — it overflows a JS number). */
  id: string;
  name: string;
  lang: string;
  homeUrl?: string;
}

export interface ExtensionEntry {
  name: string;
  /** Android package name, e.g. `eu.kanade.tachiyomi.extension.all.mangadex`. */
  pkg: string;
  version: string;
  versionCode: number;
  /** Version of the extension API it was built against (`extensionLib`). */
  lib: string;
  apkUrl: string;
  iconUrl?: string;
  jarUrl?: string;
  /** `SAFE` / `MIXED` / `NSFW` / `UNKNOWN` — normalised from either format. */
  contentWarning: string;
  sources: ExtensionSource[];
  /**
   * The manifest of a portable (JavaScript) package.
   *
   * A portable entry has no APK: its "bytes" are one `provider.js` fetched from `entryUrl`. The
   * install path needs the manifest itself (id, kind, host API, source declarations), so the whole
   * thing travels with the entry instead of being re-parsed from an index that may have changed
   * between the tap and the download.
   */
  portable?: import("./portable").PortableManifest;
}

export interface ExtensionIndex {
  /** Repository display name, when the index declares one. */
  name: string;
  extensions: ExtensionEntry[];
}

function warn(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") return "UNKNOWN";
  const value = raw.replace(/^CONTENT_WARNING_/, "").toUpperCase();
  return value === "" ? "UNKNOWN" : value;
}

/** Legacy indexes use `nsfw: 0|1`; v2 uses a `contentWarning` enum. */
function warningOf(entry: Record<string, unknown>): string {
  if (typeof entry.contentWarning === "string") return warn(entry.contentWarning);
  if (entry.nsfw === 1 || entry.nsfw === true) return "NSFW";
  if (entry.nsfw === 0 || entry.nsfw === false) return "SAFE";
  return "UNKNOWN";
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function sourcesOf(entry: Record<string, unknown>): ExtensionSource[] {
  const raw = Array.isArray(entry.sources) ? entry.sources : [];
  return raw
    .map((s) => s as Record<string, unknown>)
    .map((s) => {
      const source: ExtensionSource = {
        id: String(s.id ?? ""),
        name: String(s.name ?? ""),
        lang: String(s.language ?? s.lang ?? ""),
      };
      if (typeof s.homeUrl === "string") source.homeUrl = s.homeUrl;
      return source;
    })
    .filter((s) => s.id !== "");
}

/** One entry, either format. Returns `null` for a row we cannot install (no package or APK). */
export function parseExtension(entry: unknown): ExtensionEntry | null {
  if (entry === null || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const pkg = typeof e.packageName === "string" ? e.packageName : typeof e.pkg === "string" ? e.pkg : "";
  const resources = (e.resources ?? {}) as Record<string, unknown>;
  const apkUrl =
    typeof resources.apkUrl === "string" ? resources.apkUrl : typeof e.apk === "string" ? e.apk : "";
  if (pkg === "" || apkUrl === "") return null;
  const out: ExtensionEntry = {
    name: String(e.name ?? pkg),
    pkg,
    version: String(e.versionName ?? e.version ?? "0"),
    versionCode: numberOr(e.versionCode ?? e.code, 0),
    lib: String(e.extensionLib ?? e.lib ?? "1.6"),
    apkUrl,
    contentWarning: warningOf(e),
    sources: sourcesOf(e),
  };
  if (typeof resources.iconUrl === "string") out.iconUrl = resources.iconUrl;
  if (typeof resources.jarUrl === "string") out.jarUrl = resources.jarUrl;
  return out;
}

/**
 * A URL as written in an index, against the index's own address.
 *
 * Real indexes are not consistent: keiyoushi's v2 JSON writes absolute URLs, while several others
 * write `apk/mangadex.apk` beside themselves. A relative one has to be joined to the index before it
 * can be fetched at all — `/api/repo?url=<relative>` is refused as unparseable, which surfaces as
 * "could not be downloaded: 400" and looks like a broken repository rather than a broken link.
 *
 * No base (a caller parsing an index it did not fetch) or an unparseable one leaves the value alone,
 * because inventing a host would be worse than keeping the string the publisher wrote.
 */
function absolute(value: string, base: string | undefined): string {
  if (base === undefined || value === "" || /^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

function resolveUrls(entry: ExtensionEntry, base: string | undefined): ExtensionEntry {
  if (base === undefined) return entry;
  const out: ExtensionEntry = { ...entry, apkUrl: absolute(entry.apkUrl, base) };
  if (entry.iconUrl !== undefined) out.iconUrl = absolute(entry.iconUrl, base);
  if (entry.jarUrl !== undefined) out.jarUrl = absolute(entry.jarUrl, base);
  return out;
}

/**
 * An index in either shape. Unknown/blank rows are dropped rather than half-parsed: an
 * entry without an APK URL cannot be installed, and pretending otherwise makes the store
 * show an extension that can never be added.
 *
 * `indexUrl` is where this JSON came from. Given it, every relative `apkUrl`/`iconUrl`/`jarUrl`
 * is resolved against that address, so an index that writes short paths beside itself installs.
 */
export function parseIndex(raw: unknown, indexUrl?: string): ExtensionIndex {
  if (Array.isArray(raw)) {
    return {
      name: "Mihon repository",
      extensions: raw.map(parseExtension).filter((e): e is ExtensionEntry => e !== null).map((e) => resolveUrls(e, indexUrl)),
    };
  }
  if (raw !== null && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const list = o.extensionList as Record<string, unknown> | undefined;
    const entries = Array.isArray(list?.extensions) ? (list.extensions as unknown[]) : [];
    return {
      name: typeof o.name === "string" && o.name !== "" ? o.name : "Mihon repository",
      extensions: entries.map(parseExtension).filter((e): e is ExtensionEntry => e !== null).map((e) => resolveUrls(e, indexUrl)),
    };
  }
  throw new Error("not an extension index: expected an array or an object with extensionList");
}

/**
 * Install/upgrade decision for one installed extension.
 *
 * `versionCode` is the authority (that is what Android uses); the version string is shown,
 * never compared. A downgrade is not offered — a repository that rolls back a version must
 * not silently replace a working install.
 */
export type UpdateState = "new" | "up-to-date" | "update" | "downgrade";

/**
 * Which installed extensions one repository has a newer build of.
 *
 * Kept here, next to `updateState`, because the comparison is the part with a wrong answer that
 * looks right: a built-in has no APK to update, an extension installed from a different repository
 * must not be "updated" from this one (its version codes come from another publisher's counter), and
 * a lower code is a downgrade the user did not ask for.
 */
export interface AvailableUpdate {
  pkg: string;
  entry: ExtensionEntry;
  repoUrl: string;
}

export function planUpdates(
  installed: ReadonlyArray<{ packageId: string; versionCode?: number; builtin?: boolean }>,
  entries: ReadonlyArray<ExtensionEntry>,
  repoUrl: string,
): AvailableUpdate[] {
  const rows = new Map(installed.map((row) => [row.packageId, row]));
  const found: AvailableUpdate[] = [];
  for (const entry of entries) {
    const row = rows.get(entry.pkg);
    if (row === undefined || row.builtin === true || row.versionCode === undefined) continue;
    if (updateState({ versionCode: row.versionCode }, entry) !== "update") continue;
    found.push({ pkg: entry.pkg, entry, repoUrl });
  }
  return found;
}

export function updateState(installed: { versionCode: number } | undefined, candidate: ExtensionEntry): UpdateState {
  if (installed === undefined) return "new";
  if (candidate.versionCode > installed.versionCode) return "update";
  if (candidate.versionCode < installed.versionCode) return "downgrade";
  return "up-to-date";
}

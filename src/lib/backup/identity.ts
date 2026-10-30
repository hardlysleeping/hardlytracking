/**
 * Which extension can open a series — asked of the id, and answered honestly.
 *
 * A backup restores *rows*, not extensions. The APK that turned `dalvik:2499…:/manga/x` into a
 * readable title is not in the file, so an import has exactly one job here: for every series, say
 * whether something installed can open it, or say plainly that nothing can. Three answers, and no
 * fourth:
 *
 * - **attached** — an installed extension exposes that source (or the series is `local`, where the
 *   library row *is* the content and no extension is involved).
 * - **missing** — the id names a dalvik source, and no enabled installed extension provides it. The
 *   series row is still imported; it simply cannot be opened until the extension is installed.
 * - **unknown** — the id does not carry enough information to answer. `mihon:12` names a manga on
 *   the Suwayomi runtime, not an extension source; the runtime knows whether it still exists and
 *   this device does not. Guessing "attached" there would be a promise the app cannot keep, and
 *   guessing "missing" would send the reader looking for an APK that was never the answer.
 *
 * The id shapes are the ones `src/api/dalvik.ts` writes and `src/state/library.svelte.ts` reads:
 *
 *   local:<native>                    the device's own library row
 *   dalvik:<sourceId>:<manga url>     a dalvik series; the source id is the first segment
 *   dalvik:src:<sourceId>             a *source*, not a series
 *   dalvik:ch:<sourceId>:<url>        a *chapter*, not a series
 *   mihon:<id>                        a Suwayomi manga id; no source in it
 *   komga:<id>                        a Komga series; a server, not an extension
 *
 * A mapping row (`sourceMappings`) is consulted first, because the device that added the series
 * wrote down the source it used. That is evidence, not a guess; the id shape is the fallback.
 */
import type { InstalledExtension } from "../../api/dalvik";
import type { ProviderKind } from "../../api/source";
import type { SyncDocument } from "../sync/document";

/** Why a source could not be named. Always a statement about the id, never about the reader. */
export type UnknownWhy =
  /** The id is a chapter or a source, not a series. */
  | "not-a-series-id"
  /** The id names a series on a host that owns its own library; no extension source is in it. */
  | "no-source-in-id"
  /** The id is not a namespaced id we know at all. */
  | "unrecognised-id";

/** What a series id (or a mapping) says about where the series comes from. */
export interface SeriesSource {
  /** The provider the id names, or `null` when the shape is not one this app writes. */
  provider: ProviderKind | null;
  /** The extension's own source id — only when the id (or a mapping) actually carries one. */
  sourceId?: string;
  /** The APK's package. No series id shape carries it today; a mapping row can. */
  packageId?: string;
  /** Set when nothing could be derived; the reason, not a substituted value. */
  why?: UnknownWhy;
}

const PROVIDERS: ProviderKind[] = ["mihon", "dalvik", "komga", "local", "archive"];

/** `<provider>:<native>`, or `null` for an id with no provider prefix this app writes. */
function split(seriesId: string): { provider: ProviderKind; native: string } | null {
  const at = seriesId.indexOf(":");
  if (at < 1) return null;
  const provider = seriesId.slice(0, at) as ProviderKind;
  if (!PROVIDERS.includes(provider)) return null;
  const native = seriesId.slice(at + 1);
  if (native === "") return null;
  return { provider, native };
}

/**
 * The source a series id names, or the reason it names none.
 *
 * Pure: no store, no network, no knowledge of what is installed. `reattach` is what compares this
 * answer against the extensions on the device.
 */
export function sourceOf(seriesId: string): SeriesSource {
  const parts = split(seriesId);
  if (parts === null) return { provider: null, why: "unrecognised-id" };
  const { provider, native } = parts;

  if (provider === "local") {
    // The device library needs no extension: the row is the series.
    return { provider, sourceId: "local" };
  }

  if (provider === "dalvik") {
    // `dalvik:src:…` and `dalvik:ch:…` are a source and a chapter, and reading either as a series
    // would invent a source id of "src" or "ch".
    if (native.startsWith("src:") || native.startsWith("ch:")) {
      return { provider, why: "not-a-series-id" };
    }
    const colon = native.indexOf(":");
    if (colon < 1) return { provider, why: "not-a-series-id" };
    const sourceId = native.slice(0, colon);
    const rest = native.slice(colon + 1);
    if (sourceId === "" || rest === "") return { provider, why: "not-a-series-id" };
    return { provider, sourceId };
  }

  // mihon and komga: a series on a host, keyed by the host's own id. No source is in the id, and
  // nothing on this device can be installed to change that.
  if (native.startsWith("ch:")) return { provider, why: "not-a-series-id" };
  return { provider, why: "no-source-in-id" };
}

export type AttachStatus = "attached" | "missing" | "unknown";

/** One series, and what this device can do with it. */
export interface SeriesAttachment {
  seriesId: string;
  title: string;
  status: AttachStatus;
  provider: ProviderKind | null;
  /** The source that would have to exist. Absent when the id does not name one. */
  sourceId?: string;
  /** The APK that would have to be installed, when anything knows its package. */
  packageId?: string;
  /** The installed extension that owns the source, when one does. */
  extensionId?: string;
  extensionName?: string;
  /** Why it is not attached: no APK at all, or an APK the user turned off. */
  reason?: "not-installed" | "disabled";
  /** Where the source claim came from — the id itself, or a mapping row in the file. */
  from: "id" | "mapping";
  /** Why the answer is `unknown`; never set for the other two. */
  why?: UnknownWhy;
}

export interface ReattachSummary {
  attached: number;
  missing: number;
  unknown: number;
  /** One entry per source no enabled extension provides, with how many series depend on it. */
  missingSources: MissingSource[];
}

export interface MissingSource {
  sourceId: string;
  /** The APK's package, when the file or a mapping names it. Never derived from a source id. */
  packageName?: string;
  seriesCount: number;
  /** True when the APK is installed but switched off — the fix is "enable", not "install". */
  disabled?: boolean;
}

/** A source id → extension index, built once per import rather than per series. */
function installedSources(installed: readonly InstalledExtension[]): Map<string, InstalledExtension> {
  const map = new Map<string, InstalledExtension>();
  for (const extension of installed) {
    for (const source of extension.sources ?? []) {
      if (source.id === undefined || source.id === "") continue;
      if (!map.has(source.id)) map.set(source.id, extension);
    }
  }
  return map;
}

/**
 * Reattach every series in a document to the extension that owns its source.
 *
 * `installed` is this device's `extensions` store. Order follows the document, so a UI can list
 * the result in the same order the file has it.
 */
export function reattach(
  document: Pick<SyncDocument, "series" | "sourceMappings" | "extensions">,
  installed: readonly InstalledExtension[],
): SeriesAttachment[] {
  const bySource = installedSources(installed);
  const mappings = new Map(document.sourceMappings.map((row) => [row.seriesId, row]));
  // A file can name the APK that owns a source (its `extensions` list). That is the only way an
  // import can say *which* extension is missing rather than just *that* one is.
  const declared = new Map<string, string>();
  for (const extension of document.extensions) {
    for (const sourceId of extension.sourceIds) if (sourceId !== "") declared.set(sourceId, extension.packageId);
  }

  return document.series.map((series) => {
    const mapping = mappings.get(series.id);
    const fromMapping = mapping !== undefined && mapping.sourceId !== "";
    const source = fromMapping
      ? { provider: mapping.provider, sourceId: mapping.sourceId, ...(mapping.packageId === undefined ? {} : { packageId: mapping.packageId }) }
      : sourceOf(series.id);
    const from: SeriesAttachment["from"] = fromMapping ? "mapping" : "id";
    const base = {
      seriesId: series.id,
      title: series.title,
      provider: source.provider,
      ...(source.sourceId === undefined ? {} : { sourceId: source.sourceId }),
      from,
    };

    // The device library is content this app already owns; no extension can be missing for it.
    if (source.provider === "local") return { ...base, status: "attached" as const };

    if (source.provider === "dalvik" && source.sourceId !== undefined) {
      const owner = bySource.get(source.sourceId);
      const packageId = source.packageId ?? owner?.packageId ?? declared.get(source.sourceId);
      if (owner === undefined) {
        return {
          ...base,
          status: "missing" as const,
          ...(packageId === undefined ? {} : { packageId }),
          reason: "not-installed" as const,
        };
      }
      const attachment = {
        ...base,
        extensionId: owner.extensionId,
        extensionName: owner.name ?? owner.packageId,
        ...(packageId === undefined ? {} : { packageId }),
      };
      if (owner.enabled === false) return { ...attachment, status: "missing" as const, reason: "disabled" as const };
      return { ...attachment, status: "attached" as const };
    }

    return {
      ...base,
      status: "unknown" as const,
      why: source.why ?? "no-source-in-id",
    };
  });
}

/** Group a reattach result: counts plus the sources that would have to be installed. */
export function summarizeReattach(attachments: readonly SeriesAttachment[]): ReattachSummary {
  const missingSources = new Map<string, MissingSource>();
  let attached = 0;
  let missing = 0;
  let unknown = 0;

  for (const row of attachments) {
    if (row.status === "attached") {
      attached += 1;
      continue;
    }
    if (row.status === "unknown") {
      unknown += 1;
      continue;
    }
    missing += 1;
    const sourceId = row.sourceId ?? "";
    const current = missingSources.get(sourceId);
    const next: MissingSource = {
      sourceId,
      ...(row.packageId === undefined ? {} : { packageName: row.packageId }),
      seriesCount: (current?.seriesCount ?? 0) + 1,
      ...(current?.disabled === true || row.reason === "disabled" ? { disabled: true } : {}),
    };
    missingSources.set(sourceId, next);
  }

  return {
    attached,
    missing,
    unknown,
    missingSources: [...missingSources.values()].sort(
      (a, b) => b.seriesCount - a.seriesCount || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0),
    ),
  };
}

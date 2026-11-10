/**
 * Portable extensions: provider code that arrives from a repository, like every other extension.
 *
 * A Mihon extension is an APK the runtime unpacks. A portable extension is one JavaScript file the
 * app runs in the same Worker host the Paperback/Suwatte runners use. Nothing else differs — it is
 * listed by a repository, installed from it, versioned by `versionCode` and updated the same way.
 *
 * Three rules this module exists to enforce:
 *
 * 1. **The package declares its identity; the id spelling is a contract.** Library rows, read marks,
 *    page positions, downloads and sync documents are keyed by provider ids, so a package names the
 *    `kind` it presents (`komga`, `mihon`, `archive`, …) and a port that renames an id orphans every
 *    saved row. An unknown kind is refused rather than guessed.
 * 2. **The host API is a version, not a hope.** A package built for a newer host answers calls this
 *    app cannot make; it is refused by name, with both numbers in the message, so the next update
 *    can say why instead of "the extension is broken".
 * 3. **The code is fetched over https or not at all.** A repository that serves `provider.js` over
 *    plain http is a package that can be rewritten by anything on the path, and the entry is dropped
 *    like any other unreadable row — one broken entry must never empty a repository.
 */
import { PROVIDER_KINDS, type ProviderKind } from "../../api/source";
import { absoluteUrl, isRecord, type RepoEntry, type RepoIndex } from "../repos/index";

/** The only runtime this module describes. Mihon APKs go to the dalvik host, not here. */
export const PORTABLE_RUNTIME = "portable-js";

/**
 * The host API this build speaks.
 *
 * Bump it only for a change a package cannot detect for itself (a method that changed meaning, a
 * field that moved). Adding an optional capability does not bump it: old packages keep working.
 */
export const PORTABLE_HOST_API = 1;

export class PortablePackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortablePackageError";
  }
}

export interface PortableSourceDecl {
  /** What the source calls itself, when the package knows before a call is made. */
  name?: string;
  lang: string;
  /** The id shape the package reproduces, e.g. `komga:<server>:lib:<libraryId>`. Documentation. */
  idPattern?: string;
}

export interface PortableManifest {
  /** Package name — the install identity, and what an update matches on. */
  id: string;
  name: string;
  version: string;
  versionCode: number;
  runtime: typeof PORTABLE_RUNTIME;
  /** The provider kind whose ids this package presents. */
  kind: ProviderKind;
  hostApi: number;
  /** Absolute URL of `provider.js`. */
  entryUrl: string;
  iconUrl?: string;
  /** What the app must be, at minimum, to run it — a warning on the card, never a crash. */
  minAppVersion?: string;
  sources: PortableSourceDecl[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function sourcesOf(raw: unknown): PortableSourceDecl[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((s) => {
      const decl: PortableSourceDecl = { lang: text(s.lang ?? s.language) };
      if (typeof s.name === "string") decl.name = s.name;
      if (typeof s.idPattern === "string") decl.idPattern = s.idPattern;
      return decl;
    });
}

/**
 * One entry, in the shape a repository publishes it.
 *
 * Throws `PortablePackageError` naming the reason, because these strings reach the Extensions screen:
 * "this extension needs host API 2, this app speaks 1" is actionable, "invalid manifest" is not.
 * `base` is where the entry was read from, so a relative `providerUrl` resolves.
 */
export function parsePortableManifest(entry: unknown, base: string): PortableManifest {
  if (!isRecord(entry)) throw new PortablePackageError("not a portable extension: expected an object");
  const runtime = text(entry.runtime);
  if (runtime !== PORTABLE_RUNTIME) {
    throw new PortablePackageError(`runtime "${runtime === "" ? "missing" : runtime}" is not "${PORTABLE_RUNTIME}"`);
  }
  const id = text(entry.packageName ?? entry.id);
  if (id === "") throw new PortablePackageError("a portable extension needs a package name");
  const hostApi = numberOr(entry.hostApi, PORTABLE_HOST_API);
  if (hostApi > PORTABLE_HOST_API) {
    throw new PortablePackageError(
      `${id} needs host API ${hostApi}, this app speaks ${PORTABLE_HOST_API}; update HardlyTracking to install it`,
    );
  }
  const kind = text(entry.kind);
  if (!(PROVIDER_KINDS as readonly string[]).includes(kind)) {
    throw new PortablePackageError(
      `${id} declares provider kind "${kind === "" ? "nothing" : kind}", which this app does not run`,
    );
  }
  const resources = isRecord(entry.resources) ? entry.resources : {};
  const rawEntry = text(resources.providerUrl ?? entry.entry);
  if (rawEntry === "") throw new PortablePackageError(`${id} has no provider.js to fetch`);
  const entryUrl = absoluteUrl(rawEntry, base);
  if (!/^https:\/\//i.test(entryUrl)) {
    throw new PortablePackageError(`${id} is served over ${entryUrl.split(":")[0]}, and portable code is only run from https`);
  }
  const manifest: PortableManifest = {
    id,
    name: text(entry.name) === "" ? id : text(entry.name),
    version: text(entry.versionName ?? entry.version) === "" ? "0" : text(entry.versionName ?? entry.version),
    versionCode: numberOr(entry.versionCode ?? entry.code, 0),
    runtime: PORTABLE_RUNTIME,
    kind: kind as ProviderKind,
    hostApi,
    entryUrl,
    sources: sourcesOf(entry.sources),
  };
  const icon = text(resources.iconUrl);
  if (icon !== "") manifest.iconUrl = absoluteUrl(icon, base);
  if (typeof entry.minAppVersion === "string" && entry.minAppVersion !== "") manifest.minAppVersion = entry.minAppVersion;
  return manifest;
}

/**
 * The official repository's index, in the neutral `RepoIndex` shape every other ecosystem uses.
 *
 * Rows that cannot be installed are dropped (they never appear as an Install that will fail), but a
 * row that is merely *older than this app* is kept: `parsePortableManifest` decides that, and its
 * refusal is what the card shows.
 *
 * Both a bare array and `{extensionList: {extensions: []}}` are accepted, because the app's own
 * publisher writes the first while every other index writes the second.
 */
export function parsePortableRepo(raw: unknown, base: string): RepoIndex {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && isRecord(raw.extensionList) && Array.isArray(raw.extensionList.extensions)
      ? (raw.extensionList.extensions as unknown[])
      : null;
  if (list === null) {
    throw new PortablePackageError("not a portable extension index: expected an array or extensionList.extensions");
  }
  const entries: RepoEntry[] = [];
  for (const item of list) {
    let manifest: PortableManifest;
    try {
      manifest = parsePortableManifest(item, base);
    } catch (error) {
      // One unreadable row is one extension missing from the store, never an empty repository.
      if (error instanceof PortablePackageError) continue;
      throw error;
    }
    const entry: RepoEntry = {
      kind: "portable",
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      versionCode: manifest.versionCode,
      packageUrl: manifest.entryUrl,
      contentWarning: "UNKNOWN",
      langs: [...new Set(manifest.sources.map((s) => s.lang).filter((lang) => lang !== ""))],
      sources: manifest.sources.map((s, at) => ({
        id: String(at),
        name: s.name ?? manifest.name,
        lang: s.lang,
      })),
      runtime: PORTABLE_RUNTIME,
      providerKind: manifest.kind,
      hostApi: manifest.hostApi,
    };
    if (manifest.iconUrl !== undefined) entry.iconUrl = manifest.iconUrl;
    if (manifest.minAppVersion !== undefined) entry.minHostVersion = manifest.minAppVersion;
    entries.push(entry);
  }
  const name = isRecord(raw) && typeof raw.name === "string" && raw.name !== "" ? raw.name : "Portable extensions";
  return { kind: "portable", name, entries };
}

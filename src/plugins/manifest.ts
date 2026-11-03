/**
 * What a plugin package is allowed to say about itself.
 *
 * Two versions, because they answer different questions and one cannot stand in for the other:
 *
 * - `apiVersion` names the *host API surface* the plugin was written against. It is the host's
 *   contract: "these are the calls that exist and mean what you think they mean". A plugin that
 *   asks for an API this build does not implement must be refused, because the alternative is a
 *   plugin running against half a host and failing in ways nobody can explain.
 * - `minAppVersion` is *this app's* compatibility: it catches a plugin that needs a feature which
 *   landed in a particular release, or a build old enough to have a bug the plugin works around.
 *
 * A package that only declared `minAppVersion` (the earlier plan) could not express either safely:
 * bumping the API without renaming anything would silently change behaviour for every plugin.
 *
 * Everything here is pure. Validation returns a list of sentences a person can read, in the words
 * of the thing that is wrong, because the installer shows them verbatim next to a Reject button.
 */
import { compareVersions, isSemver } from "../lib/semver";

/** The manifest shape this build understands. A file that says anything else is refused. */
export const MANIFEST_VERSION = 1;

/** The highest host API this build implements. `apiVersion` above it is a future plugin. */
export const PLUGIN_API_VERSION = 1;

/**
 * Permissions a plugin may ask for.
 *
 * Deliberately short. Each one is a sentence the install panel shows the user, and a permission
 * that cannot be honoured on some platform is in `PLATFORM_SUPPORT` below rather than being
 * quietly ignored — a plugin that ran without a grant it thought it had is worse than one that
 * refused to install.
 */
export const PERMISSIONS = [
  /** Read titles you already have: id, title, cover, chapter list with read marks. */
  "library.read",
  /** Its own key/value space, namespaced to this plugin, removed when it is uninstalled. */
  "plugin.storage",
  /** A menu entry on a series page. */
  "ui.series",
  /** A menu entry in the reader. */
  "ui.reader",
  /** A menu entry on the library screen. */
  "ui.library",
  /** Learn when a series is opened, added or removed. No payload beyond ids. */
  "events.library",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** What the install panel says each permission means. Shown, not summarised. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  "library.read": "Read the titles in your library (titles, covers, chapters, read marks)",
  "plugin.storage": "Keep its own settings on this device",
  "ui.series": "Add an entry to a series page",
  "ui.reader": "Add an entry to the reader",
  "ui.library": "Add an entry to the library screen",
  "events.library": "Be told when you open, add or remove a title",
};

/** Which shell can honour which permission. A plugin cannot install where its API is absent. */
export const PLATFORM_SUPPORT: Record<Shell, readonly Permission[]> = {
  web: PERMISSIONS,
  desktop: PERMISSIONS,
  ios: PERMISSIONS,
  android: PERMISSIONS,
};

export type Shell = "web" | "desktop" | "ios" | "android";

/** One entry a plugin contributes to the app's own menus. */
export interface Contribution {
  readonly id: string;
  readonly title: string;
}

/** The parsed, validated manifest. Nothing unknown survives into this type. */
export interface PluginManifest {
  readonly manifestVersion: typeof MANIFEST_VERSION;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: number;
  readonly minAppVersion: string;
  readonly entry: string;
  readonly permissions: readonly Permission[];
  readonly networkHosts: readonly string[];
  readonly contributes: {
    readonly seriesActions: readonly Contribution[];
    readonly readerActions: readonly Contribution[];
    readonly libraryActions: readonly Contribution[];
  };
  readonly description?: string;
  readonly author?: string;
}

/** One sentence about what is wrong. `path` is where to look, for a developer reading it. */
export interface ManifestProblem {
  readonly path: string;
  readonly message: string;
}

export type ManifestResult =
  | { readonly ok: true; readonly manifest: PluginManifest }
  | { readonly ok: false; readonly problems: readonly ManifestProblem[] };

export interface ManifestContext {
  /** The running app version, e.g. `0.5.8`. */
  readonly appVersion: string;
  readonly platform: Shell;
  /**
   * The id of the plugin being updated, when this is an update.
   *
   * Required for updates: a package that changes its own id is a different plugin, and letting it
   * through would silently replace someone's installation with another one that inherits its
   * granted permissions.
   */
  readonly existingId?: string;
}

/** `dev.example.reader-tools` — reverse-DNS-ish, lowercase, at least two segments. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

/** A relative path inside the package: no `..`, no leading slash, no drive letter, no backslash. */
function relativePath(value: string): boolean {
  if (value === "" || value.startsWith("/") || value.includes("\\")) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  return !value.split("/").some((part) => part === ".." || part === ".");
}

/** A string field, trimmed, with a non-empty requirement. */
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    const text = str(item);
    if (text === null) return null;
    out.push(text);
  }
  return out;
}

/**
 * Reads a manifest and decides whether this build may run it.
 *
 * Never throws and never repairs: a manifest with one unknown permission is refused whole, because
 * installing "most of" a plugin means it runs with a permission it did not get, or without one it
 * assumed. Every problem found is reported, not just the first — a developer fixing a package
 * should not have to install it eleven times to learn eleven things.
 */
export function readManifest(raw: unknown, context: ManifestContext): ManifestResult {
  const problems: ManifestProblem[] = [];
  const bad = (path: string, message: string) => problems.push({ path, message });

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, problems: [{ path: "", message: "The manifest is not an object." }] };
  }
  const source = raw as Record<string, unknown>;

  if (source.manifestVersion !== MANIFEST_VERSION) {
    bad(
      "manifestVersion",
      `This build reads manifestVersion ${MANIFEST_VERSION}; the package says ${String(source.manifestVersion)}.`,
    );
  }

  const id = str(source.id);
  if (id === null) bad("id", "A plugin needs an id.");
  else if (!ID_PATTERN.test(id)) bad("id", `"${id}" is not a plugin id — use reverse-DNS, lower-case, e.g. dev.example.reader-tools.`);
  else if (context.existingId !== undefined && id !== context.existingId) {
    bad("id", `This is an update to "${context.existingId}", but the package calls itself "${id}".`);
  }

  const name = str(source.name);
  if (name === null) bad("name", "A plugin needs a name.");

  const version = str(source.version);
  if (version === null) bad("version", "A plugin needs a version.");
  else if (!isSemver(version)) bad("version", `"${version}" is not a semantic version.`);

  const apiVersion = source.apiVersion;
  if (typeof apiVersion !== "number" || !Number.isInteger(apiVersion) || apiVersion < 1) {
    bad("apiVersion", "apiVersion must be a whole number of at least 1.");
  } else if (apiVersion > PLUGIN_API_VERSION) {
    bad(
      "apiVersion",
      `The plugin needs host API ${apiVersion}; this build implements ${PLUGIN_API_VERSION}.`,
    );
  }

  const minAppVersion = str(source.minAppVersion) ?? "0.0.0";
  if (!isSemver(minAppVersion)) bad("minAppVersion", `"${minAppVersion}" is not a semantic version.`);
  else if (isSemver(context.appVersion) && compareVersions(minAppVersion, context.appVersion) > 0) {
    bad(
      "minAppVersion",
      `The plugin needs HardlyTracking ${minAppVersion} or newer; this is ${context.appVersion}.`,
    );
  }

  const entry = str(source.entry) ?? "entry.js";
  if (!relativePath(entry) || !entry.endsWith(".js")) {
    bad("entry", `"${entry}" must be a relative .js path inside the package.`);
  }

  const permissions: Permission[] = [];
  const declared = source.permissions === undefined ? [] : stringList(source.permissions);
  if (declared === null) {
    bad("permissions", "permissions must be a list of permission names.");
  } else {
    const supported = PLATFORM_SUPPORT[context.platform] ?? PERMISSIONS;
    for (const permission of declared) {
      if (!(PERMISSIONS as readonly string[]).includes(permission)) {
        // Refused, not ignored: a plugin that quietly loses a grant it depends on breaks later.
        bad("permissions", `"${permission}" is not a permission this build knows.`);
        continue;
      }
      if (!supported.includes(permission as Permission)) {
        bad("permissions", `"${permission}" is not available on ${context.platform}.`);
        continue;
      }
      if (!permissions.includes(permission as Permission)) permissions.push(permission as Permission);
    }
  }

  const hosts = source.networkHosts === undefined ? [] : stringList(source.networkHosts);
  if (hosts === null) bad("networkHosts", "networkHosts must be a list of host names.");
  else {
    for (const host of hosts) {
      if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host) || host.includes("..")) {
        bad("networkHosts", `"${host}" is not a host name.`);
      }
    }
  }

  const contributes = readContributions(source.contributes, bad);

  const description = str(source.description);
  const author = str(source.author);

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    manifest: {
      manifestVersion: MANIFEST_VERSION,
      id: id as string,
      name: name as string,
      version: version as string,
      apiVersion: apiVersion as number,
      minAppVersion,
      entry,
      permissions,
      networkHosts: hosts ?? [],
      contributes,
      ...(description === null ? {} : { description }),
      ...(author === null ? {} : { author }),
    },
  };
}

const KINDS = ["seriesActions", "readerActions", "libraryActions"] as const;

/**
 * Contribution ids, which must be unique across every kind.
 *
 * Unique per plugin rather than per menu: the app dispatches an action by `<plugin>:<action>`, so a
 * `show-info` in two menus would be two entries that the host cannot tell apart.
 */
function readContributions(
  raw: unknown,
  bad: (path: string, message: string) => void,
): PluginManifest["contributes"] {
  const out: { seriesActions: Contribution[]; readerActions: Contribution[]; libraryActions: Contribution[] } = {
    seriesActions: [],
    readerActions: [],
    libraryActions: [],
  };
  if (raw === undefined) return out;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    bad("contributes", "contributes must be an object of lists.");
    return out;
  }
  const source = raw as Record<string, unknown>;
  const seen = new Set<string>();
  for (const kind of KINDS) {
    const list = source[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      bad(`contributes.${kind}`, `${kind} must be a list.`);
      continue;
    }
    for (const [index, item] of list.entries()) {
      const path = `contributes.${kind}[${index}]`;
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        bad(path, "A contribution is an object with an id and a title.");
        continue;
      }
      const entry = item as Record<string, unknown>;
      const id = str(entry.id);
      const title = str(entry.title);
      if (id === null || !ID_PATTERN.test(`x.${id}`)) {
        bad(`${path}.id`, `"${String(entry.id)}" is not an action id — lower-case, no spaces or dots.`);
        continue;
      }
      if (title === null) {
        bad(`${path}.title`, "An action needs a title to show in the menu.");
        continue;
      }
      if (seen.has(id)) {
        bad(`${path}.id`, `"${id}" is already used by another action in this plugin.`);
        continue;
      }
      seen.add(id);
      out[kind].push({ id, title });
    }
  }
  return out;
}

/** Every permission the manifest asked for that the user has not granted yet. */
export function newPermissions(
  requested: readonly string[],
  granted: readonly string[],
): Permission[] {
  return requested.filter(
    (permission): permission is Permission =>
      (PERMISSIONS as readonly string[]).includes(permission) && !granted.includes(permission),
  );
}

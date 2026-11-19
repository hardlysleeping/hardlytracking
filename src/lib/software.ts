/**
 * One package, as a page of its own.
 *
 * An extension row used to be the whole story: a name, a version, an Install button, and whatever
 * the index happened to say that day. An App Store review asks for the other half — a place that
 * says what a package *is* (who publishes it, which ecosystem, which languages, which sources, what
 * rating, whether it is installed) before anything is installed, reachable by a link so a person can
 * send it to someone else.
 *
 * Three rules live here, as data, so a test can pin them:
 *
 * 1. **Opening a package page writes nothing.** `softwareFacts` is a pure function of what is
 *    already known; the only work an open does is *read* a repository index. There is no
 *    `addRepository` and no install on this path — a link names a package, it does not act on one.
 * 2. **A package from a repository this app has not added is described, not offered.** Its facts are
 *    read from the index and its actions are empty; the page points at the repository panel, where
 *    adding is a tap of its own (checklist §1).
 * 3. **A package the index no longer carries is not a 404.** The page still opens, says the
 *    repository dropped it, and an installed copy keeps the two actions that matter: disable and
 *    uninstall.
 *
 * The canonical web form is `https://hardlytracking.app/source?repo=…&id=…` — the same page on a
 * device without the app, because the app is a static build that can be served from that host.
 */
import { ecosystemLabel, repositoryEcosystem } from "./extensions/proposal";
import { updateState, type ExtensionEntry } from "./extensions/index";
import type { Repository } from "./extensions/repository";
import { isFetchableRepo } from "./deep-link";
import { detectPlatform } from "./webview/index";
import { pathTo } from "./nav";

/** The host the canonical links live on. One constant, so the entitlement and the page agree. */
export const SOFTWARE_SITE = "https://hardlytracking.app";

/** A package named by a link or a row: which package, and which repository said so. */
export interface SoftwareRef {
  pkg: string;
  /** `null` when the link did not say — then the installed row or the app's repositories answer. */
  repo: string | null;
}

/** What the app already knows about one installed package. Structural, so a row satisfies it. */
export interface SoftwareInstalledRow {
  packageId: string;
  name?: string;
  versionName?: string;
  versionCode?: number;
  enabled?: boolean;
  builtin?: boolean;
  repoUrl?: string;
  sources: ReadonlyArray<{ id: string; name: string; lang?: string }>;
}

/** The repositories the app has added — the only ones a package can be installed from. */
export interface SoftwareRepoRow {
  url: string;
  name: string;
  indexUrl: string;
}

/** The actions a page may offer. Empty is a valid answer, and the important one. */
export type SoftwareAction = "install" | "update" | "disable" | "enable" | "uninstall";

export interface SoftwareFacts {
  pkg: string;
  name: string;
  /** "Mihon / Keiyoushi · APK extensions", or the honest generic when nothing said otherwise. */
  ecosystem: string;
  version: string | null;
  repository: { name: string; url: string; host: string } | null;
  languages: string[];
  /** `SAFE` / `MIXED` / `NSFW` / `UNKNOWN` — the index's own word, kept unflattened. */
  warning: string;
  /** The same thing in the words a row shows: Safe, Mature, 18+, Unrated. */
  rating: string;
  sources: Array<{ id: string; name: string; lang: string }>;
  state: "not-installed" | "installed" | "disabled";
  /** Ships inside the app: there is no APK to remove, only a switch. */
  builtin: boolean;
  installedVersion: string | null;
  availableVersion: string | null;
  updateAvailable: boolean;
  /** Whether the package's repository is one the app has added. False = describe only. */
  repoAdded: boolean;
  /** The index was read and no longer carries this package. */
  upstreamRemoved: boolean;
  actions: SoftwareAction[];
}

export interface SoftwareInput {
  ref: SoftwareRef;
  /** The index read for the ref's repository, or `null` when it could not be read. */
  index: Repository | null;
  /** Repositories the app has added. */
  repos: ReadonlyArray<SoftwareRepoRow>;
  installed: ReadonlyArray<SoftwareInstalledRow>;
}

/** "Safe" / "Mature" / "18+" / "Unrated" — never a raw enum in front of a person. */
export function ratingLabel(warning: string): string {
  if (warning === "SAFE") return "Safe";
  if (warning === "MIXED") return "Mature";
  if (warning === "NSFW") return "18+";
  return "Unrated";
}

function unique(values: ReadonlyArray<string>): string[] {
  const seen: string[] = [];
  for (const value of values) {
    const lang = value.trim();
    if (lang !== "" && !seen.includes(lang)) seen.push(lang);
  }
  return seen;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** `eu.kanade.tachiyomi.extension.all.mangafire` → `Mangafire`, when nothing better is known. */
function nameFromPackage(pkg: string): string {
  const last = pkg.split(".").filter(Boolean).pop() ?? pkg;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/**
 * Everything the page says, from what is already known.
 *
 * Pure: it takes the index (or the failure to read one), the added repositories and the installed
 * rows, and answers with facts and an action list. Nothing here writes, fetches, or navigates.
 */
export function softwareFacts(input: SoftwareInput): SoftwareFacts {
  const { ref } = input;
  const row = input.installed.find((candidate) => candidate.packageId === ref.pkg);
  const entry: ExtensionEntry | null = input.index?.extensions.find((candidate) => candidate.pkg === ref.pkg) ?? null;

  // Which repository this page is about: what the link said, else where the install came from.
  const repoUrl = ref.repo ?? row?.repoUrl ?? input.index?.url ?? null;
  const known = repoUrl === null ? undefined : input.repos.find((repo) => repo.url === repoUrl);
  const repoAdded = repoUrl !== null && known !== undefined;

  const sources = (entry?.sources ?? row?.sources ?? []).map((source) => ({
    id: source.id,
    name: source.name,
    lang: (source.lang ?? "").trim(),
  }));

  const updateAvailable =
    row !== undefined &&
    row.builtin !== true &&
    row.versionCode !== undefined &&
    entry !== null &&
    updateState({ versionCode: row.versionCode }, entry) === "update";

  const state: SoftwareFacts["state"] = row === undefined ? "not-installed" : row.enabled === false ? "disabled" : "installed";

  const actions: SoftwareAction[] = [];
  if (row === undefined) {
    // Installing is only offered for a repository the user has added: a link must not add one.
    if (repoAdded && entry !== null) actions.push("install");
  } else {
    if (updateAvailable) actions.push("update");
    // The switch always exists; uninstall does not, because a built-in ships inside the app.
    actions.push(row.enabled === false ? "enable" : "disable");
    if (row.builtin !== true) actions.push("uninstall");
  }

  const warning = entry?.contentWarning ?? "UNKNOWN";
  const repository =
    repoUrl === null
      ? null
      : {
          name: known?.name ?? input.index?.name ?? hostOf(repoUrl),
          url: repoUrl,
          host: hostOf(known?.indexUrl ?? input.index?.indexUrl ?? repoUrl),
        };

  return {
    pkg: ref.pkg,
    name: entry?.name ?? ((row?.name ?? "").trim() || nameFromPackage(ref.pkg)),
    ecosystem: input.index === null ? "Extension repository" : ecosystemLabel(repositoryEcosystem(input.index)),
    version: entry?.version ?? row?.versionName ?? null,
    repository,
    languages: unique(sources.map((source) => source.lang)),
    warning,
    rating: ratingLabel(warning),
    sources,
    state,
    builtin: row?.builtin === true,
    installedVersion: row?.versionName ?? null,
    availableVersion: entry?.version ?? null,
    updateAvailable,
    repoAdded,
    upstreamRemoved: input.index !== null && entry === null,
    actions,
  };
}

/**
 * A repository a link named, refused before it is fetched.
 *
 * A `javascript:` or `file:` payload is not a repository; saying so here means the page can explain
 * it instead of showing whatever the fetch layer answers.
 */
export function repoRefusal(repo: string | null): string | null {
  if (repo === null) return null;
  if (!isFetchableRepo(repo)) return `“${repo}” is not an http(s) address, so there is no index to read.`;
  return null;
}

/** The in-app address of a package page: `#/software/<pkg>` or `#/software/<repo>/<pkg>`. */
export function softwareHref(ref: SoftwareRef): string {
  return pathTo("software", ref.repo, ref.pkg);
}

/** The canonical link — what a person shares, and what opens on a device without the app. */
export function canonicalSoftwareUrl(ref: SoftwareRef): string {
  const params = new URLSearchParams();
  if (ref.repo !== null) params.set("repo", ref.repo);
  params.set("id", ref.pkg);
  return `${SOFTWARE_SITE}/source?${params.toString()}`;
}

/**
 * The package a canonical web link names, if this page load is one.
 *
 * `https://hardlytracking.app/source?repo=…&id=…` — the path is `/source`, the package is `id`, the
 * repository is `repo` and may be absent (then the app answers from what it already knows). Any
 * other URL is not a software link, and the caller keeps whatever it was doing.
 */
export function softwareRefFromLocation(href: string): SoftwareRef | null {
  let url: URL;
  try {
    url = new URL(href, "https://localhost");
  } catch {
    return null;
  }
  if (!/\/source\/?$/.test(url.pathname)) return null;
  const id = (url.searchParams.get("id") ?? "").trim();
  if (id === "") return null;
  const repo = (url.searchParams.get("repo") ?? "").trim();
  return { pkg: id, repo: repo === "" ? null : repo };
}

/**
 * iOS hands the app a universal link instead of a page: `getLaunchUrl` for a cold start, then the
 * `appUrlOpen` event. Both end in the same place — a package page — and neither installs anything.
 *
 * Inert off the packaged shell, like `watchOpenedFiles`: the web build already has the URL.
 */
export async function watchSoftwareLinks(onOpen: (ref: SoftwareRef) => void): Promise<(() => void) | null> {
  if (detectPlatform() !== "capacitor") return null;
  const { App } = await import("@capacitor/app");

  const handle = (url: string | null | undefined): void => {
    if (url === null || url === undefined) return;
    const ref = softwareRefFromLocation(url);
    if (ref !== null) onOpen(ref);
  };

  // The cold start: the link is why the app launched, and the event has already been missed.
  const launch = await App.getLaunchUrl();
  handle(launch?.url);

  const listener = await App.addListener("appUrlOpen", ({ url }) => handle(url));
  return () => void listener.remove();
}

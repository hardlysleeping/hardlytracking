/**
 * Extension repositories — the way extensions are actually installed.
 *
 * Nobody downloads an APK by hand. A repository is one URL that answers with an index of
 * extensions, and the app installs from it: index → the APK you asked for → the host.
 *
 * Two things this module refuses to do, because both would be silent data loss:
 *
 * 1. **Guess a repository's index URL wrongly and stop.** A pasted base URL is tried against
 *    the two names the ecosystem publishes (`index.json`, then `index.min.json`); if neither
 *    parses, the error names both URLs that were tried, so the next paste can be right.
 * 2. **Trust the index's ids.** The real Mihon source ids come from the index and are carried
 *    as strings; the extension's identity is its package name and version code, and an APK is
 *    only ever installed for the entry it belongs to.
 *
 * Everything is fetched through the app's own `/api/repo` passthrough so the page stays on one
 * origin: repository indexes live on one host and APKs redirect to another.
 */
import { parseIndex, type ExtensionEntry, type ExtensionIndex } from "./index";
import { apiUrl, hasLocalServer, withToken } from "../host";

export interface Repository {
  /** What the user pasted, normalised; this is the key a repository is remembered by. */
  url: string;
  /** The index URL that actually answered. */
  indexUrl: string;
  name: string;
  extensions: ExtensionEntry[];
}

export class RepositoryError extends Error {
  readonly tried: string[];

  constructor(message: string, tried: string[] = []) {
    super(message);
    this.name = "RepositoryError";
    this.tried = tried;
  }
}

/** `/api/repo?url=…` — same origin, so no CORS and no mixed content. */
export function repoProxyUrl(target: string): string {
  return withToken(apiUrl(`/api/repo?url=${encodeURIComponent(target)}`));
}

/**
 * How a repository index is actually fetched.
 *
 * Through our own `/api/repo` when this build has a server — it adds the headers some hosts want and
 * keeps the request same-origin. A packaged app has no such route, so it asks the repository
 * directly: every index host in this ecosystem serves CORS `*`, because Mihon itself is a native
 * client and the index has to be publicly readable.
 */
export function repoFetchUrl(target: string): string {
  return hasLocalServer() ? repoProxyUrl(target) : target;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The schemes an install link can use. Mihon's own is `mihon://`; forks kept their old names. */
const INSTALL_SCHEMES = ["mihon:", "tachiyomi:", "komikku:", "yokai:"];

/**
 * Turn what the user actually has into a repository URL.
 *
 * The ecosystem publishes *install links*, not repository roots:
 *
 *   mihon://extension-store?url=https://raw.githubusercontent.com/…/repo/index.pb
 *
 * That is what the wiki's Install button carries and what people paste, so it is what the field
 * accepts. A GitHub blob URL is rewritten to its raw form for the same reason — it is a link people
 * copy out of a browser, not a URL an HTTP client can read.
 */
export function parseInstallLink(input: string): string {
  const text = input.trim();
  if (text === "") return "";
  const scheme = INSTALL_SCHEMES.find((candidate) => text.toLowerCase().startsWith(candidate));
  if (scheme !== undefined) {
    // `mihon://extension-store?url=…` — the host is the action, the query carries the payload.
    const query = text.slice(text.indexOf("?") + 1);
    if (text.includes("?")) {
      for (const pair of query.split("&")) {
        const [key, value = ""] = pair.split("=");
        if (key === "url" || key === "repo") {
          try {
            return trimSlash(decodeURIComponent(value));
          } catch {
            return trimSlash(value);
          }
        }
      }
    }
    return "";
  }
  const blob = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i.exec(text);
  if (blob !== null) return trimSlash(`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`);
  return trimSlash(text);
}

/**
 * The index URLs to try for what the user typed.
 *
 * A URL that already names a file is taken at its word. Anything else is a repository root,
 * and the two published names are tried in order — v2 first, because that is what the live
 * indexes are today, with the legacy name as the fallback.
 */
export function candidateIndexUrls(input: string): string[] {
  const url = parseInstallLink(input);
  if (url === "") return [];
  // An index file named outright: `.json` is read as-is, `.pb` is a protobuf index we do not parse,
  // so its JSON siblings in the same directory are tried first and the `.pb` itself is last (it
  // fails with a message that says so, rather than pretending the repository is empty).
  if (/\.json$/i.test(url)) return [url];
  if (/\.pb$/i.test(url)) {
    const base = url.replace(/\/[^/]*$/, "");
    return [`${base}/index.json`, `${base}/index.min.json`, url];
  }
  // A repository root. `index.json` is the v2 name the live indexes use; the legacy name is the
  // fallback. `index.pb` is deliberately not tried here: we cannot read it, so offering it would
  // only turn a working repository into a parse error.
  return [`${url}/index.json`, `${url}/index.min.json`];
}

export interface LoadOptions {
  fetchImpl?: typeof fetch;
}

/** Read a repository's index, trying the candidate URLs and reporting what was tried. */
export async function loadRepository(input: string, options: LoadOptions = {}): Promise<Repository> {
  const doFetch = options.fetchImpl ?? ((target: string) => fetch(repoFetchUrl(target)));
  const candidates = candidateIndexUrls(input);
  if (candidates.length === 0) {
    throw new RepositoryError(
      "that is not a repository link — paste the repository URL, or the Install link from the extension list",
    );
  }

  const failures: string[] = [];
  for (const indexUrl of candidates) {
    let text: string;
    try {
      const response = await doFetch(indexUrl);
      if (!response.ok) {
        failures.push(`${indexUrl} → ${response.status}`);
        continue;
      }
      text = await response.text();
    } catch (error) {
      failures.push(`${indexUrl} → ${(error as Error).message}`);
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      failures.push(`${indexUrl} → not JSON`);
      continue;
    }

    const index: ExtensionIndex = parseIndex(raw);
    if (index.extensions.length === 0) {
      // An empty index is a valid answer, but not a useful repository; say so rather than
      // registering a repository with nothing in it.
      failures.push(`${indexUrl} → index has no extensions`);
      continue;
    }
    return {
      url: parseInstallLink(input),
      indexUrl,
      name: index.name === "" ? hostOf(indexUrl) : index.name,
      extensions: index.extensions,
    };
  }

  const normalized = parseInstallLink(input);
  const triedPb = candidates.length > 0 && candidates[candidates.length - 1].endsWith(".pb");
  throw new RepositoryError(
    triedPb
      ? `could not read a repository index from ${normalized} — that link points at a protobuf index (index.pb), which this build cannot read, and no JSON index was found beside it`
      : `could not read a repository index from ${normalized}`,
    failures,
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The bytes of an APK, through the same passthrough. */
export async function downloadApk(entry: ExtensionEntry, options: LoadOptions = {}): Promise<Uint8Array> {
  const doFetch = options.fetchImpl ?? ((target: string) => fetch(repoFetchUrl(target)));
  const response = await doFetch(entry.apkUrl);
  if (!response.ok) {
    throw new RepositoryError(`${entry.name} (${entry.version}) could not be downloaded: ${response.status}`, [entry.apkUrl]);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** The one line under an entry: version, API, source count, warning. */
export function describeEntry(entry: ExtensionEntry): string {
  const parts = [`v${entry.version}`, `${entry.sources.length} source${entry.sources.length === 1 ? "" : "s"}`];
  if (entry.lib !== "") parts.push(`lib ${entry.lib}`);
  if (entry.contentWarning !== "SAFE" && entry.contentWarning !== "UNKNOWN") parts.push(entry.contentWarning.toLowerCase());
  return parts.join(" · ");
}

/** Case-insensitive match on name, package and source names — what people actually search by. */
export function matches(entry: ExtensionEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (entry.name.toLowerCase().includes(q) || entry.pkg.toLowerCase().includes(q)) return true;
  return entry.sources.some((source) => source.name.toLowerCase().includes(q) || source.lang.toLowerCase() === q);
}

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
  return `/api/repo?url=${encodeURIComponent(target)}`;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The index URLs to try for what the user typed.
 *
 * A URL that already names a file is taken at its word. Anything else is a repository root,
 * and the two published names are tried in order — v2 first, because that is what the live
 * indexes are today, with the legacy name as the fallback.
 */
export function candidateIndexUrls(input: string): string[] {
  const url = trimSlash(input.trim());
  if (url === "") return [];
  if (/\.json$/i.test(url)) return [url];
  return [`${url}/index.json`, `${url}/index.min.json`];
}

export interface LoadOptions {
  fetchImpl?: typeof fetch;
}

/** Read a repository's index, trying the candidate URLs and reporting what was tried. */
export async function loadRepository(input: string, options: LoadOptions = {}): Promise<Repository> {
  const doFetch = options.fetchImpl ?? ((target: string) => fetch(repoProxyUrl(target)));
  const candidates = candidateIndexUrls(input);
  if (candidates.length === 0) throw new RepositoryError("no repository URL given");

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
      url: trimSlash(input.trim()),
      indexUrl,
      name: index.name === "" ? hostOf(indexUrl) : index.name,
      extensions: index.extensions,
    };
  }

  throw new RepositoryError(`could not read a repository index from ${input.trim()}`, failures);
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
  const doFetch = options.fetchImpl ?? ((target: string) => fetch(repoProxyUrl(target)));
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

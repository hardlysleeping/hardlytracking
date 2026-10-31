/**
 * Pasted links, turned into something a queue can act on.
 *
 * The Downloads screen takes a pile of links — an Internet Archive item, a page from whichever
 * comic source is installed — and has to answer, for each one, "which source owns this, and what
 * do I search it for". That answer is pure: no network, no Svelte, no store. The view does the
 * looking-up; this module only decides what to look up, so a test can pin the decisions.
 *
 * Nothing here guesses a series id out of a URL that belongs to a source we cannot read. A link
 * whose host matches no installed source is reported as such, because a wrong match would download
 * the wrong book and the user would only find out later.
 */

/** One line of the paste box, as far as this module is concerned. */
export interface PastedLink {
  /** The line exactly as pasted, trimmed, so a report can quote it back. */
  raw: string;
  /** An absolute http(s) URL, or null when the line is not one. */
  url: string | null;
  /** The host, lowercased and without a leading `www.`, or null. */
  host: string | null;
}

/** The parts of a source this module needs. `Source` satisfies it. */
export interface LinkSource {
  id: string;
  name: string;
  baseUrl?: string;
}

/** What a link resolved to, or why it could not. */
export type LinkTarget =
  | { kind: "archive"; seriesId: string; url: string }
  | { kind: "source"; sourceId: string; sourceName: string; query: string; url: string }
  | { kind: "error"; reason: string; url: string | null; raw: string };

/**
 * Split a paste into candidate links.
 *
 * Links arrive one per line, but a browser's "copy all links" puts them on one line separated by
 * spaces, and a chat message wraps them. Both are the same intent, so the split is on any
 * whitespace; empty lines vanish.
 */
export function readPastedLines(text: string): PastedLink[] {
  return text
    .split(/\s+/)
    .map((piece) => stripTrailing(piece.trim()))
    .filter((piece) => piece !== "")
    .map(toPasted);
}

/** A URL pasted from a chat window often carries the brackets or comma of the sentence around it. */
function stripTrailing(text: string): string {
  return text.replace(/[([{"'“‘]+/gu, "").replace(/[)\]}.,;:!?'"”’]+$/u, "");
}

function toPasted(raw: string): PastedLink {
  const absolute = /^https?:\/\//i.test(raw) ? raw : /^[\w.-]+\.[a-z]{2,}\//i.test(raw) ? `https://${raw}` : null;
  if (absolute === null) return { raw, url: null, host: null };
  try {
    const parsed = new URL(absolute);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { raw, url: null, host: null };
    return { raw, url: parsed.toString(), host: hostOf(parsed) };
  } catch {
    return { raw, url: null, host: null };
  }
}

/** The comparable host: lowercase, no `www.`, no port. */
export function hostOf(url: URL | string): string | null {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return null;
  }
  return parsed.hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * Do two hosts name the same site?
 *
 * A source is often reachable at a mirror or a subdomain (`m.batcave.biz`), so a strict equality
 * would refuse a link the extension can read perfectly well. A shared suffix is the same site; two
 * unrelated domains never share one.
 */
export function sameHost(a: string, b: string): boolean {
  const left = a.toLowerCase().replace(/^www\./, "");
  const right = b.toLowerCase().replace(/^www\./, "");
  if (left === "" || right === "") return false;
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

/** The installed source that serves this host, if any. */
export function sourceForHost<T extends LinkSource>(sources: readonly T[], host: string): T | null {
  for (const source of sources) {
    if (source.baseUrl === undefined) continue;
    const sourceHost = hostOf(source.baseUrl);
    if (sourceHost === null) continue;
    if (sameHost(host, sourceHost)) return source;
  }
  return null;
}

/**
 * The Internet Archive item a link names.
 *
 * `archive.org/details/<id>`, `archive.org/download/<id>/<file>`, and the same paths on
 * `ia801504.us.archive.org`-style nodes. The item id is the series id's second half — that is how
 * the archive provider keys a series, so this is a direct hit rather than a search.
 */
export function archiveItemId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = hostOf(parsed);
  if (host === null || !sameHost(host, "archive.org")) return null;
  const parts = parsed.pathname.split("/").filter((part) => part !== "");
  const at = parts.findIndex((part) => part === "details" || part === "download");
  if (at === -1) return null;
  const id = parts[at + 1];
  if (id === undefined || id === "") return null;
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

/**
 * What to search a source for, given one of its own links.
 *
 * `/comic/solo-leveling-3/` means "Solo Leveling 3". Slugs are also used for ids the source will
 * find by name anyway, so the last segment is the best available query; a trailing all-digits
 * segment is an id, not a word, so the one before it is used instead.
 */
export function queryFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  const parts = parsed.pathname
    .split("/")
    .filter((part) => part !== "")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  while (parts.length > 0) {
    const last = parts[parts.length - 1] ?? "";
    if (/^\d+$/.test(last)) {
      parts.pop();
      continue;
    }
    return words(last);
  }
  return "";
}

/** `solo-leveling_v2` → `solo leveling v2`, without the file extension. */
function words(segment: string): string {
  return segment
    .replace(/\.(html?|php|aspx?)$/i, "")
    .replace(/[-_+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve one pasted link against the sources this app has installed.
 *
 * The order matters: the Internet Archive is answered by item id, because a search could pick a
 * different scan of the same book. Everything else is a search on the one source whose host the
 * link belongs to — never on "some source that might have it", which is how a wrong title gets
 * downloaded.
 */
export function resolveLink(link: PastedLink, sources: readonly LinkSource[]): LinkTarget {
  if (link.url === null || link.host === null) {
    return { kind: "error", reason: "not a link", url: null, raw: link.raw };
  }
  const item = archiveItemId(link.url);
  if (item !== null) return { kind: "archive", seriesId: `archive:${item}`, url: link.url };

  const source = sourceForHost(sources, link.host);
  if (source === null) {
    return {
      kind: "error",
      reason: `no installed source serves ${link.host}`,
      url: link.url,
      raw: link.raw,
    };
  }
  const query = queryFromUrl(link.url);
  if (query === "") {
    return { kind: "error", reason: `${source.name} link has no title in it`, url: link.url, raw: link.raw };
  }
  return { kind: "source", sourceId: source.id, sourceName: source.name, query, url: link.url };
}

/** Resolve a whole paste, keeping the order the user pasted in. */
export function resolveLinks(text: string, sources: readonly LinkSource[]): LinkTarget[] {
  return readPastedLines(text).map((link) => resolveLink(link, sources));
}

/**
 * The best of a source's search results for a slug.
 *
 * Exact title first (case and punctuation ignored), then the first result the source itself
 * ranked first. Returning the source's own first hit when nothing matches exactly is deliberate:
 * the alternative is refusing a title the user can see on the site, and a wrong guess is visible
 * in the queue before it downloads anything.
 */
export function bestMatch<T extends { title: string }>(results: readonly T[], query: string): T | null {
  if (results.length === 0) return null;
  const wanted = normalise(query);
  const exact = results.find((row) => normalise(row.title) === wanted);
  if (exact !== undefined) return exact;
  const contains = results.find((row) => normalise(row.title).includes(wanted) || wanted.includes(normalise(row.title)));
  return contains ?? results[0];
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

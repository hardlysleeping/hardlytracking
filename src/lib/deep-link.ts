/**
 * Links that install a repository, from outside the app.
 *
 * The extension lists publish install links, not repository roots:
 *
 *   mihon://extension-store?url=https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb
 *
 * Three ways one can reach us, and all three end in the same place — a repository URL handed to
 * `library.addRepository`:
 *
 * 1. **Pasted** into the Add repository field (the browser tab case; an OS will not route `mihon://`
 *    to a tab).
 * 2. **`?repo=…` / `?url=…` on our own URL**, which is what `web+mihon` protocol registration points
 *    at, and what a QR code or a link on a page can use.
 * 3. **A packaged build receiving the scheme**, where the OS opens the app and hands us the URL; the
 *    registration itself is platform config, the parsing is here.
 *
 * Parsing is pure so it can be tested: no `location`, no `navigator`, no network.
 */

/** The query keys an install link may use for its payload. */
const PAYLOAD_KEYS = ["url", "repo"];

/** Read a payload out of a query string (`?url=…&x=1`, with or without the leading `?`). */
export function repoFromQuery(query: string): string | null {
  const text = query.startsWith("?") ? query.slice(1) : query;
  if (text.trim() === "") return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(text);
  } catch {
    return null;
  }
  for (const key of PAYLOAD_KEYS) {
    const value = params.get(key);
    if (value !== null && value.trim() !== "") return value.trim();
  }
  return null;
}

/**
 * The repository URL inside an app URL, wherever it sits.
 *
 * Accepts the hash form the router uses (`#/extensions?repo=…`), the plain query form (`?repo=…`),
 * and a bare install link (`mihon://extension-store?url=…`).
 */
export function repoFromLocation(href: string): string | null {
  const hashIndex = href.indexOf("#");
  if (hashIndex >= 0) {
    const hash = href.slice(hashIndex + 1);
    const queryIndex = hash.indexOf("?");
    if (queryIndex >= 0) {
      const fromHash = repoFromQuery(hash.slice(queryIndex));
      if (fromHash !== null) return fromHash;
    }
  }
  const queryIndex = href.indexOf("?");
  if (queryIndex >= 0) {
    // Stop at the hash: `?a=1#/x?b=2` must not read the second half as part of the first.
    const end = hashIndex >= 0 ? hashIndex : href.length;
    const fromQuery = repoFromQuery(href.slice(queryIndex, end));
    if (fromQuery !== null) return fromQuery;
  }
  return null;
}

/**
 * A repository URL is only useful to us if we can fetch it: http(s) only.
 *
 * A `mihon://` payload that itself contains another scheme (or a file path) is refused here rather
 * than handed to the proxy, which would refuse it anyway with a less useful message.
 */
export function isFetchableRepo(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Register `web+mihon://` with the browser, so a link using it opens this app in a tab.
 *
 * Browsers only allow `web+` schemes from a page, and they require the handler URL to be on this
 * origin — hence `?repo=%s` rather than the hash. A bare `mihon://` link cannot be registered from
 * the web at all; the packaged build owns that scheme (platform config), and pasting the link into
 * the field is the tab's answer.
 */
export function registerProtocolHandler(): "registered" | "unsupported" | "refused" {
  if (typeof navigator === "undefined" || typeof navigator.registerProtocolHandler !== "function") {
    return "unsupported";
  }
  try {
    navigator.registerProtocolHandler("web+mihon", `${location.origin}/?repo=%s`);
    return "registered";
  } catch {
    return "refused";
  }
}

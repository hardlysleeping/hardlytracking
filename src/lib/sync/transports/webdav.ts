/**
 * WebDAV as a sync transport.
 *
 * WebDAV is the one provider that needs no SDK and no account-specific API: Nextcloud,
 * ownCloud, Synology, Fastmail files and a self-hosted box all speak it, and it maps a
 * document to a URL. So the whole transport is a GET and a PUT of that URL — nothing
 * about collections, revisions or merging appears here, because none of that is a
 * transport's business.
 *
 * The details that are easy to get wrong, and why they are done this way:
 *
 * - **A missing document is `null`.** 404 and 410 both mean "the store holds nothing
 *   yet" (a server may answer either for a path that was never created, and a deleted
 *   document is the same starting point). Every other non-2xx is a real failure.
 * - **Errors carry the status and a short body excerpt, never the credentials.** A
 *   server's 401 page is useful; the Authorization header is not something to copy into
 *   a log. The URL is displayed with any userinfo stripped for the same reason.
 * - **`fetchImpl` is injectable.** Tests run against a local stub server with no
 *   network, and a desktop build can pass Tauri's HTTP client without this module
 *   knowing that Tauri exists.
 */
import { SyncTransportError } from "../transport";
import type { SyncTransport } from "../transport";

export interface WebdavTransportOptions {
  /** Full URL of the document itself, not the collection that holds it. */
  url: string;
  username: string;
  password: string;
  /** Defaults to the global `fetch`; injected by tests and by a native HTTP client. */
  fetchImpl?: typeof fetch;
}

/** How much of an error body is worth showing. Enough to identify, short enough to read. */
const EXCERPT_LIMIT = 200;

export function webdavTransport(options: WebdavTransportOptions): SyncTransport {
  const url = options.url;
  const name = `webdav:${displayUrl(url)}`;
  const authorization = basicAuth(options.username, options.password);
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name,

    async read(): Promise<string | null> {
      const response = await request(doFetch, name, url, {
        method: "GET",
        headers: { Authorization: authorization },
      });
      if (response.status === 404 || response.status === 410) return null;
      await requireOk(response, name, "GET", url);
      try {
        return await response.text();
      } catch (error) {
        throw new SyncTransportError(name, `could not read the body from ${displayUrl(url)}: ${describe(error)}`, error);
      }
    },

    async write(text: string): Promise<void> {
      const response = await request(doFetch, name, url, {
        method: "PUT",
        headers: {
          Authorization: authorization,
          // The document is JSON by contract; a server that sniffs content types
          // should store it as JSON rather than as an opaque download.
          "Content-Type": "application/json",
        },
        body: text,
      });
      await requireOk(response, name, "PUT", url);
      // The body of a successful PUT is server noise; drain it so the connection is
      // released instead of being held by an unread stream.
      await response.text().catch(() => undefined);
    },
  };
}

/** One place where a network-level failure becomes a transport error. */
async function request(
  doFetch: typeof fetch,
  name: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await doFetch(url, init);
  } catch (error) {
    throw new SyncTransportError(
      name,
      `could not reach ${displayUrl(url)}: ${describe(error)}`,
      error,
    );
  }
}

async function requireOk(response: Response, name: string, method: string, url: string): Promise<void> {
  if (response.ok) return;
  const excerpt = await readExcerpt(response);
  const suffix = excerpt === "" ? "" : `: ${excerpt}`;
  throw new SyncTransportError(
    name,
    `${method} ${displayUrl(url)} failed with HTTP ${response.status}${suffix}`,
  );
}

/** A short, single-line sample of an error body — never a whole HTML error page. */
async function readExcerpt(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return "";
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > EXCERPT_LIMIT ? `${collapsed.slice(0, EXCERPT_LIMIT)}...` : collapsed;
}

/**
 * HTTP Basic, built from UTF-8 bytes rather than `btoa(user + ":" + pass)`.
 *
 * `btoa` throws on any character above U+00FF, which is exactly what a non-Latin
 * password or a display name used as a login looks like. Encoding to bytes first keeps
 * the header correct in the browser, in Node and in the desktop build.
 */
function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

/**
 * The URL as it may be shown: credentials removed.
 *
 * Some servers accept `https://user:pass@host/path`, and a reader who configures it
 * that way would otherwise find the password in every error message this module emits.
 */
function displayUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.username === "" && parsed.password === "") return raw;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return raw;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

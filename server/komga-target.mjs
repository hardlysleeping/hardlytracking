/**
 * Where a `/api/komga/…` request should go.
 *
 * The browser build cannot talk to Komga: Komga sends no `Access-Control-Allow-Origin`, so a page
 * served from anywhere else is refused before credentials are even considered. The packaged builds
 * do not have the problem (Capacitor's HTTP and the desktop shell bypass CORS), which is why the
 * route exists only for the page and why the page is the only client that asks for it.
 *
 * The address travels in the path — `/api/komga/<base64url of the origin>/api/v1/…` — rather than in
 * a header, because covers and page images are fetched as URLs and a `<img>` cannot send a header.
 *
 * The rule that keeps this from being an open proxy: **only a server on the user's own network.**
 * This route's entire purpose is "the Komga you run", and a public Komga does not need it — the
 * packaged app talks to those directly.
 */

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/i;

/** Loopback, RFC1918, link-local, CGNAT (tailnet) — and `.local`, which is mDNS on your own LAN. */
export function privateHost(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "::1" || host === "0.0.0.0") return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true;
  if (/^(fc|fd|fe80)/i.test(host)) return true;
  return PRIVATE_HOST.test(host);
}

/**
 * `/api/komga/<encoded base>/<path>?<search>` -> the URL to fetch, or a refusal.
 *
 * Returns `{ status, error }` rather than throwing: every failure here is a client mistake or a
 * refused address, and the route turns both into plain text.
 */
export function komgaTarget(pathname, search = "") {
  const rest = String(pathname).replace(/^\/api\/komga\/?/, "");
  const slash = rest.indexOf("/");
  const encoded = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? "/" : rest.slice(slash);
  if (encoded === "") return { status: 400, error: "missing Komga address" };

  let base;
  try {
    base = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return { status: 400, error: "unreadable Komga address" };
  }

  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    return { status: 400, error: "bad Komga address" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { status: 400, error: "only http(s)" };
  }
  if (!privateHost(parsed.hostname)) {
    return { status: 403, error: "only a Komga on your own network is proxied — the installed apps talk to the others directly" };
  }
  // The path is appended to the origin, never to a user-supplied path: `new URL(tail, parsed)` would
  // let `//evil.example/x` replace the host, which is the whole request going somewhere else.
  return { url: `${parsed.origin}${tail}${search}` };
}

/** The inverse, for the client and for tests: an absolute Komga URL -> the path this route serves. */
export function komgaProxyPath(baseUrl, path = "/") {
  const encoded = Buffer.from(String(baseUrl), "utf8").toString("base64url");
  return `/api/komga/${encoded}${path.startsWith("/") ? path : `/${path}`}`;
}

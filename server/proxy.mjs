/**
 * The self-hosted runtime's front door.
 *
 * One origin, so the browser never meets CORS: the built Svelte app is served from
 * here, and everything the app asks of the Mihon runtime goes through `/api/mihon`.
 *
 *   GET  /api/mihon/v1/manga/12/thumbnail  ->  runtime /api/v1/manga/12/thumbnail
 *   POST /api/mihon/graphql                ->  runtime /api/graphql
 *   POST /api/dalvik/dalvik                ->  extension host /dalvik
 *   GET  /api/dalvik/image/<uuid>          ->  extension host /image/<uuid>
 *   GET  /api/repo?url=<index or apk url>  ->  the URL itself (extension repositories)
 *
 * The rule is a prefix swap and nothing else, which is why `stripApiPrefix` in
 * src/api/mihon.ts mirrors it. `RUNTIME_URL` is the only thing that changes when the
 * runtime is Suwayomi today or an in-house extension host later.
 *
 * `/api/dalvik` is the M-Extension-Server host: it speaks `/dalvik`, `/capabilities` and
 * its own `/image/` proxy, all under one origin on a loopback port. Proxying it keeps the
 * page on a single origin, which is also why `DalvikClient.asset()` re-points the absolute
 * `http://127.0.0.1:<port>/image/…` addresses it mints.
 */
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { upstreamPath } from "./upstream-path.mjs";
import { komgaTarget } from "./komga-target.mjs";
import { networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createHostExtensions, forgotExtension } from "./host-extensions.mjs";

const PORT = Number(process.env.PORT ?? 8460);
/**
 * Where to listen. Loopback by default; `HOST=0.0.0.0` makes this machine the runtime for a phone
 * on the same network (or tailnet) — the desktop app serving the mobile one.
 */
const HOST = process.env.HOST ?? "127.0.0.1";
/**
 * A shared secret for that mode. Static files stay open (a browser navigation cannot send a
 * header), every `/api/*` call needs it, as `x-hardlytracking-token` or `?token=`.
 */
const TOKEN = (process.env.HARDLYTRACKING_TOKEN ?? "").trim();
const RUNTIME = (process.env.RUNTIME_URL ?? "http://127.0.0.1:4567").replace(/\/+$/, "");
const DALVIK = (process.env.DALVIK_URL ?? "http://127.0.0.1:8792").replace(/\/+$/, "");
const DIST = process.env.DIST ?? fileURLToPath(new URL("../dist/", import.meta.url));
/**
 * Where the HT-Server keeps its extension registry — a sibling of `dist/`, because `dist/` is a build
 * output that `npm run build` empties. The PC's own app and a paired phone both read this list, so it
 * is the host's, not a build's.
 */
const STATE = process.env.HT_STATE_DIR ?? fileURLToPath(new URL("../data/", import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  // pdf.js ships its worker as `.mjs`, and a browser refuses to `import()` a module served as
  // application/octet-stream — the symptom is "Setting up fake worker failed" and a PDF that will not
  // open. Any `.mjs` in the bundle needs this line.
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length"]);

/**
 * `content-encoding` is dropped because Node's `fetch` decodes gzip/deflate/br for us: the
 * bytes we forward are already plain, so passing the header on makes the browser try to
 * gunzip plain text — a 200 whose body cannot be read ("TypeError: Failed to fetch"), which
 * is what the dalvik host's gzipped `/capabilities` did. We also ask upstream for identity,
 * so there is nothing to decode in the first place.
 */
const RESPONSE_DROP = new Set([...HOP_BY_HOP, "content-encoding"]);


async function body(request) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** The request's headers, minus hop-by-hop ones, with the session promoted and identity encoding. */
function forwardHeaders(request) {
  const headers = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP.has(key) && typeof value === "string") headers[key] = value;
  }
  // A browser tab cannot set `Cookie` — it is a forbidden header and `fetch` drops it silently — so
  // the app sends the session as `x-hardlytracking-cookies` and it is promoted here. Without this,
  // every WebView login works in the packaged app and does nothing in the PWA, which is the build
  // most people run.
  if (typeof headers["x-hardlytracking-cookies"] === "string") {
    headers["cookie"] = headers["x-hardlytracking-cookies"];
    delete headers["x-hardlytracking-cookies"];
  }
  headers["accept-encoding"] = "identity";
  return headers;
}

async function proxy(request, response, upstreamBase, prefix, replacement = "") {
  const incoming = new URL(request.url ?? "/", "http://localhost");
  const target = `${upstreamBase}${upstreamPath(incoming.pathname, prefix, replacement)}${incoming.search}`;
  const headers = forwardHeaders(request);

  let upstream;
  try {
    upstream = await fetch(target, { method: request.method, headers, body: await body(request) });
  } catch (error) {
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: `runtime unreachable at ${upstreamBase}`, detail: String(error) }));
    return;
  }

  const out = {};
  upstream.headers.forEach((value, key) => {
    if (!RESPONSE_DROP.has(key)) out[key] = value;
  });
  response.writeHead(upstream.status, out);
  if (upstream.body === null) {
    response.end();
    return;
  }
  for await (const chunk of upstream.body) response.write(chunk);
  response.end();
}

/**
 * Komga, for the page.
 *
 * The packaged builds reach Komga themselves; a page cannot, because Komga sends no CORS headers. The
 * address travels in the path (`server/komga-target.mjs` explains why) and only a server on the
 * user's own network is accepted. Everything else — method, body, `authorization` — is forwarded as
 * it arrives, because Komga authenticates with the login the person already uses, and this box never
 * stores it.
 */
async function serveKomga(request, response) {
  const incoming = new URL(request.url ?? "/", "http://localhost");
  const routed = komgaTarget(incoming.pathname, incoming.search);
  if (routed.url === undefined) {
    response.writeHead(routed.status ?? 400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(routed.error ?? "komga route");
    return;
  }

  const headers = forwardHeaders(request);
  delete headers["x-hardlytracking-token"];
  delete headers["x-hardlytracking-cookies"];
  delete headers["host"];

  let upstream;
  try {
    upstream = await fetch(routed.url, { method: request.method, headers, body: await body(request) });
  } catch (error) {
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: `Komga unreachable at ${new URL(routed.url).origin}`, detail: String(error) }));
    return;
  }

  // Buffered, not streamed. These are JSON answers, covers and single pages — kilobytes, not the
  // 40 MB scans `/api/file` carries — and a browser that is handed a chunked body whose encoding
  // header we stripped waits for bytes that never come. One buffer, one exact `content-length`.
  const bytes = Buffer.from(await upstream.arrayBuffer());
  const out = {};
  upstream.headers.forEach((value, key) => {
    // `www-authenticate` is Komga's challenge to *Komga*, and forwarding it makes the browser issue
    // one against this app's own origin — the page then sits waiting on an auth retry that never
    // settles instead of reading a plain 401. The client only needs the status.
    if (RESPONSE_DROP.has(key) || key === "content-length" || key === "www-authenticate") return;
    out[key] = value;
  });
  out["content-length"] = String(bytes.length);
  response.writeHead(upstream.status, out);
  response.end(bytes);
}

const host = createHostExtensions({ dir: STATE, dalvikUrl: DALVIK });

/**
 * The extension host, with one addition: the host reinstalls its own APK when the runtime forgot it.
 *
 * The runtime keeps an APK in memory only, keyed by its SHA-256, so after a restart every call for
 * that extension answers "Extension handle … is no longer loaded; resend the APK". Until now the
 * only party that could resend was the client — which, for a phone talking to a PC, meant the phone
 * sending *its own* APK bytes to the PC and silently installing the phone's extensions there. The
 * bytes belong to the machine that installed the extension, so this machine keeps them
 * (`host-store.mjs`) and replays the call here. A client never sees the retry, and a phone never
 * needs the PC's APKs.
 *
 * Only a JSON `/dalvik` call is buffered; an image keeps streaming, because buffering a page is how
 * a proxy turns a big download into a stalled one.
 */
async function serveDalvik(request, response) {
  const incoming = new URL(request.url ?? "/", "http://localhost");
  const target = `${DALVIK}${upstreamPath(incoming.pathname, /^\/api\/dalvik/)}${incoming.search}`;
  const headers = forwardHeaders(request);
  // The browser's own `User-Agent` must never reach the runtime: the runtime applies whatever UA it
  // receives to the *extension's* HTTP client (`NetworkHelper.setUA`), so a forwarded Chrome UA (or
  // `fetch`'s own `node`) becomes the extension's identity, and sites that block browser or unknown
  // user-agents answer an HTML challenge page the extension then reads as JSON. MangaDex did exactly
  // that — `getPopularManga` came back as `<!doctype html>`, surfaced as a Jackson "Unexpected JSON
  // token" 500 and an empty source. A tab cannot set `User-Agent` itself (forbidden header, dropped
  // silently), so a UA the app means to send travels as `x-hardlytracking-user-agent`, the same way
  // the session travels as `x-hardlytracking-cookies`. Absent means absent: the runtime keeps the
  // extension's own identity, which is what a source expects.
  const appUserAgent = headers["x-hardlytracking-user-agent"];
  delete headers["x-hardlytracking-user-agent"];
  delete headers["user-agent"];
  if (typeof appUserAgent === "string" && appUserAgent !== "") headers["user-agent"] = appUserAgent;
  // `node:http` (unlike `fetch`) forwards `host` verbatim, and this one names the proxy's own port.
  delete headers["host"];
  const payload = await body(request);
  const isCall = request.method === "POST" && incoming.pathname === "/api/dalvik/dalvik";

  let upstream;
  try {
    upstream = await rawRequest(target, { method: request.method, headers, body: payload });
  } catch (error) {
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: `runtime unreachable at ${DALVIK}`, detail: String(error) }));
    return;
  }

  const out = {};
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (!RESPONSE_DROP.has(key) && value !== undefined) out[key] = value;
  }

  if (!isCall) {
    response.writeHead(upstream.statusCode ?? 502, out);
    upstream.pipe(response);
    return;
  }

  let text = await textOf(upstream);
  let status = upstream.statusCode ?? 502;
  if (status >= 400) {
    let detail = null;
    try {
      detail = JSON.parse(text);
    } catch {
      detail = null;
    }
    // The id is on the call the client sent; the runtime's error may or may not repeat it.
    let sent = null;
    try {
      sent = payload === undefined ? null : JSON.parse(payload.toString("utf8"));
    } catch {
      sent = null;
    }
    const extensionId =
      typeof detail?.extensionId === "string"
        ? detail.extensionId
        : typeof sent?.extensionId === "string"
          ? sent.extensionId
          : null;
    if (extensionId !== null && forgotExtension(detail?.error)) {
      const apk = await host.store.apk(extensionId);
      if (apk !== null) {
        try {
          await host.installOnRuntime(apk.toString("base64"));
          const replay = await rawRequest(target, { method: "POST", headers, body: payload });
          text = await textOf(replay);
          status = replay.statusCode ?? 502;
          console.log(`dalvik: reinstalled ${extensionId} from the host's own APK and replayed the call (${status})`);
        } catch (error) {
          // A replay that fails is the caller's answer: the runtime's first error is what it sees.
          console.log(`dalvik: could not reinstall ${extensionId}: ${String(error)}`);
        }
      }
    }
  }
  response.writeHead(status, out);
  response.end(text);
}

/**
 * A request to the runtime made with `node:http`, not `fetch`.
 *
 * `fetch` fills a missing `User-Agent` with `node` and there is no way to ask it not to (an
 * `undefined` value is sent as the string `"undefined"`). That default is poison on this hop: the
 * runtime applies the UA it receives to the extension's HTTP client, and MangaDex answers `node`
 * with an HTML challenge page. A raw request sends exactly the headers it is given, so an absent UA
 * stays absent.
 */
function rawRequest(target, { method, headers, body }) {
  const url = new URL(target);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = send(url, { method, headers }, resolve);
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

/** A stream's bytes as one string — for a small JSON answer, never for an image. */
async function textOf(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Extension repositories and their APKs, fetched for the page.
 *
 * A browser cannot be relied on here: repository indexes live on `raw.githubusercontent.com`
 * and APKs on release assets that redirect to another host, and a self-hosted build may be
 * served over http while the asset is https (mixed content). One passthrough keeps every
 * fetch same-origin, which is also why the page needs no CORS configuration.
 *
 * Only GET, only http(s), and only up to a cap — this route exists to read two file types,
 * not to be an open proxy for the network.
 */
const REPO_MAX_BYTES = 80 * 1024 * 1024;

async function serveRepo(request, response) {
  const incoming = new URL(request.url ?? "/", "http://localhost");
  const target = incoming.searchParams.get("url");
  if (target === null || !/^https?:\/\//i.test(target)) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "url must be an absolute http(s) URL" }));
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "repositories are read-only" }));
    return;
  }
  let upstream;
  try {
    upstream = await fetch(target, { headers: { "accept-encoding": "identity", "user-agent": "HardlyTracking" }, redirect: "follow" });
  } catch (error) {
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: `could not fetch ${target}`, detail: String(error) }));
    return;
  }
  if (!upstream.ok) {
    response.writeHead(upstream.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: `${target} answered ${upstream.status}` }));
    return;
  }
  const length = Number(upstream.headers.get("content-length") ?? "0");
  if (length > REPO_MAX_BYTES) {
    response.writeHead(413, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: `that file is ${length} bytes; the cap is ${REPO_MAX_BYTES}` }));
    return;
  }
  const bytes = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(200, {
    "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
    "Content-Length": String(bytes.length),
    "Cache-Control": "no-store",
  });
  response.end(bytes);
}

/**
 * Page images that need headers.
 *
 * Mihon extensions hand back a page as a URL *plus* the headers its source demands —
 * `Referer: https://mangafire.to/` and so on. An `<img>` cannot send those, and the CDN answers 403
 * without them, so the page has to be fetched by something that can. That something is this route:
 * `?url=` is the image, `?h=` is the base64url JSON header set the extension asked for.
 *
 * It is a fetch-anything endpoint, so it is deliberately narrow: http(s) only, no loopback or
 * private address, image content types only, a size cap, and a timeout. That keeps it from becoming
 * a proxy for the whole LAN.
 */
const IMAGE_MAX_BYTES = 32 * 1024 * 1024;
/**
 * A scanned volume.
 *
 * Bigger than the image ceiling because a comic is one file: a 200-page scan lands between 10 and
 * 60 MB, and archive.org's worst items run past 150. Still a ceiling — the largest real volume that
 * is not a mistake is about this size.
 */
const FILE_MAX_BYTES = 192 * 1024 * 1024;

/**
 * What a book file may be.
 *
 * A CBR is a RAR with a different name, so both spellings arrive, and some storage nodes answer a
 * generic binary type. A web page is the case this refuses: a 404 notice has to be an error, not an
 * archive handed to the reader to fail on.
 */
const FILE_TYPES = /^(application\/(pdf|zip|x-cbz|vnd\.comicbook\+zip|x-rar-compressed|vnd\.rar|octet-stream)|image\/vnd\.rar)/i;
const HEADER_ALLOW = new Set(["user-agent", "referer", "origin", "accept", "accept-language", "cookie"]);

function privateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^127\./.test(host) || host === "::1" || host === "0.0.0.0") return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host) || /^fc|^fd|^fe80/i.test(host)) return true;
  return false;
}

/**
 * Fetch one URL on the browser's behalf and hand back what it answered.
 *
 * Two routes use it, and each exists because a browser cannot make the request itself. `/api/img`
 * is for page images that need a `Referer` a browser will not let us set. `/api/file` is for a
 * scanned volume: a 10-60 MB PDF or CBR from archive.org, fetched through our own server so the page
 * is not asked to download it cross-origin. Neither is a general proxy — private addresses are
 * refused, each kind is capped, and both sit behind the same token.
 */
async function serveUpstream(request, response, kind) {
  const incoming = new URL(request.url ?? "/", "http://localhost");
  const target = incoming.searchParams.get("url");
  const encoded = incoming.searchParams.get("h");
  if (target === null) {
    response.writeHead(400, { "Content-Type": "text/plain" });
    response.end("missing url");
    return;
  }
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain" });
    response.end("bad url");
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    response.writeHead(400, { "Content-Type": "text/plain" });
    response.end("only http(s)");
    return;
  }
  if (privateHost(parsed.hostname)) {
    response.writeHead(403, { "Content-Type": "text/plain" });
    response.end("private address refused");
    return;
  }

  const headers = {};
  if (encoded !== null) {
    try {
      const asked = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      for (const [name, value] of Object.entries(asked)) {
        if (HEADER_ALLOW.has(name.toLowerCase()) && typeof value === "string") headers[name] = value;
      }
    } catch {
      // A malformed header set is not a reason to fail the image; fetch it without them.
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const upstream = await fetch(parsed, { headers, signal: controller.signal, redirect: "follow" });
    if (!upstream.ok) {
      response.writeHead(upstream.status, { "Content-Type": "text/plain" });
      response.end(`upstream ${upstream.status}`);
      return;
    }
    const type = upstream.headers.get("content-type") ?? "";
    // Each route accepts one kind of answer and says so: an image route that returned HTML would
    // draw a broken picture, and a file route that returned a web page would hand a comic reader a
    // 404 notice to parse as an archive.
    const wanted = kind === "file" ? FILE_TYPES : /^image\//i;
    if (!wanted.test(type)) {
      response.writeHead(415, { "Content-Type": "text/plain" });
      response.end(kind === "file" ? "not a book file" : "not an image");
      return;
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > (kind === "file" ? FILE_MAX_BYTES : IMAGE_MAX_BYTES)) {
      response.writeHead(413, { "Content-Type": "text/plain" });
      response.end("too large");
      return;
    }
    response.writeHead(200, {
      "Content-Type": type,
      "Content-Length": String(bytes.length),
      // A page image never changes: the same URL is the same picture.
      "Cache-Control": "public, max-age=86400",
    });
    response.end(bytes);
  } catch (error) {
    response.writeHead(504, { "Content-Type": "text/plain" });
    response.end(`fetch failed: ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function serveStatic(request, response) {
  const incoming = new URL(request.url ?? "/", "http://localhost");
  const relative = normalize(decodeURIComponent(incoming.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, relative);
  if (!extname(file)) file = join(DIST, "index.html");
  try {
    const data = await readFile(file);
    response.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": extname(file) === ".html" ? "no-cache" : "public, max-age=3600" });
    response.end(data);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not built: run `npm run build` first");
  }
}

/**
 * Apple's association file for this host's universal links.
 *
 * It has to sit at the host root, unauthenticated, as `application/json` — a browser navigation
 * cannot send a header, and Apple's fetch does not follow a redirect. The file itself is
 * `deploy/apple-app-site-association`, which is what gets copied to whichever host serves
 * `hardlytracking.app`; serving it here too means the path is testable on this machine instead of
 * only after a deploy.
 */
async function serveAasa(request, response) {
  try {
    const data = await readFile(fileURLToPath(new URL("../deploy/apple-app-site-association", import.meta.url)));
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=600" });
    response.end(data);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("no apple-app-site-association in deploy/");
  }
}

/** The addresses a phone could use to reach this server, when it is listening on the network. */
function networkAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      // Docker bridges and veth pairs are not addresses a phone can use; listing seven of them
      // buries the one that works.
      if (/^(br-|docker|veth|virbr)/.test(name)) continue;
      out.push({ name, address: entry.address });
    }
  }
  return out;
}

function authorised(request, url) {
  if (TOKEN === "") return true;
  const header = request.headers["x-hardlytracking-token"];
  if (typeof header === "string" && header === TOKEN) return true;
  return url.searchParams.get("token") === TOKEN;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  // A packaged app loads from `capacitor://localhost`, so every API call from it is cross-origin and
  // the browser refuses the answer without these. The token is still the gate: `*` here says who may
  // read the response, not who may make the request.
  if (path.startsWith("/api/")) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    // Every header the `/dalvik` protocol sends has to be allowed, or a phone's call never leaves
    // the browser: `source-base-url` rides on every call, and the session is `x-hardlytracking-cookies`
    // (a tab cannot set `Cookie`). A preflight that omits one is a request the browser refuses —
    // "Failed to fetch", with nothing in the server log.
    response.setHeader(
      "Access-Control-Allow-Headers",
      "content-type, x-hardlytracking-token, x-hardlytracking-cookies, source-base-url, x-mangayomi-webview-port",
    );
    // DELETE and PATCH are how a phone uninstalls and disables a PC's extension; a preflight that
    // does not list them is a request the browser never sends.
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
  }

  // Pairing info and the API are the only guarded things: the app itself has to load before it can
  // send a header, so static files stay open and the token is what protects the library.
  if (path === "/api/host-info") {
    if (!authorised(request, url)) {
      response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "token required" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(
      JSON.stringify({
        host: HOST,
        port: PORT,
        serving: HOST !== "127.0.0.1" && HOST !== "localhost",
        tokenRequired: TOKEN !== "",
        addresses: networkAddresses(),
        runtime: RUNTIME,
        dalvik: DALVIK,
      }),
    );
    return;
  }

  if (path.startsWith("/api/") && !authorised(request, url)) {
    response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "token required — open the link the desktop app shows you" }));
    return;
  }

  const handler = path === "/.well-known/apple-app-site-association"
    ? serveAasa
    : path === "/api/repo"
    ? serveRepo
    : path === "/api/img"
    ? (req, res) => serveUpstream(req, res, "image")
    : path === "/api/file"
    ? (req, res) => serveUpstream(req, res, "file")
    : path.startsWith("/api/komga/")
    ? serveKomga
    : path.startsWith("/api/dalvik/")
    ? serveDalvik
    : path.startsWith("/api/mihon/")
      ? (req, res) => proxy(req, res, RUNTIME, /^\/api\/mihon/, "/api")
      : path.startsWith("/api/host/")
        // The host's own registry: what this PC has installed, and the four things a phone may do
        // to it. Not a proxy — these routes are answered here, from `data/host-extensions.json`.
        ? (req, res) => host.handle(req, res, url)
        : serveStatic;
  handler(request, response).catch((error) => {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`proxy error: ${String(error)}`);
  });
});

server.listen(PORT, HOST, () => {
  const where = HOST === "127.0.0.1" ? "this machine only" : HOST;
  console.log(`HardlyTracking on http://${HOST}:${PORT} (${where}; runtime ${RUNTIME}, dalvik ${DALVIK}, dist ${DIST})`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    for (const entry of networkAddresses()) console.log(`  phone: http://${entry.address}:${PORT}/`);
    if (TOKEN === "") console.log("  no HARDLYTRACKING_TOKEN set: anyone who can reach this port can read the library");
  }
});

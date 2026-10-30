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
import { createServer } from "node:http";
import { upstreamPath } from "./upstream-path.mjs";
import { networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

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

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
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

async function proxy(request, response, upstreamBase, prefix, replacement = "") {
  const incoming = new URL(request.url ?? "/", "http://localhost");
  const target = `${upstreamBase}${upstreamPath(incoming.pathname, prefix, replacement)}${incoming.search}`;
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

async function serveImage(request, response) {
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
    if (!type.startsWith("image/")) {
      response.writeHead(415, { "Content-Type": "text/plain" });
      response.end("not an image");
      return;
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > IMAGE_MAX_BYTES) {
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
    response.setHeader("Access-Control-Allow-Headers", "content-type, x-hardlytracking-token");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

  const handler = path === "/api/repo"
    ? serveRepo
    : path === "/api/img"
    ? serveImage
    : path.startsWith("/api/dalvik/")
    ? (req, res) => proxy(req, res, DALVIK, /^\/api\/dalvik/)
    : path.startsWith("/api/mihon/")
      ? (req, res) => proxy(req, res, RUNTIME, /^\/api\/mihon/, "/api")
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

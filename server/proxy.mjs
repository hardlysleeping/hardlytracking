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
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8460);
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

async function proxy(request, response, upstreamBase, prefix) {
  const incoming = new URL(request.url ?? "/", "http://localhost");
  const target = `${upstreamBase}${incoming.pathname.replace(prefix, "")}${incoming.search}`;
  const headers = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP.has(key) && typeof value === "string") headers[key] = value;
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

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const handler = path === "/api/repo"
    ? serveRepo
    : path.startsWith("/api/dalvik/")
    ? (req, res) => proxy(req, res, DALVIK, /^\/api\/dalvik/)
    : path.startsWith("/api/mihon/")
      ? (req, res) => proxy(req, res, RUNTIME, /^\/api\/mihon/)
      : serveStatic;
  handler(request, response).catch((error) => {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`proxy error: ${String(error)}`);
  });
});

server.listen(PORT, () => {
  console.log(`HardlyTracking on http://127.0.0.1:${PORT} (runtime ${RUNTIME}, dalvik ${DALVIK}, dist ${DIST})`);
});

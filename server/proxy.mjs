/**
 * The self-hosted runtime's front door.
 *
 * One origin, so the browser never meets CORS: the built Svelte app is served from
 * here, and everything the app asks of the Mihon runtime goes through `/api/mihon`.
 *
 *   GET  /api/mihon/v1/manga/12/thumbnail  ->  runtime /api/v1/manga/12/thumbnail
 *   POST /api/mihon/graphql                ->  runtime /api/graphql
 *
 * The rule is a prefix swap and nothing else, which is why `stripApiPrefix` in
 * src/api/mihon.ts mirrors it. `RUNTIME_URL` is the only thing that changes when the
 * runtime is Suwayomi today or an in-house extension host later.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8460);
const RUNTIME = (process.env.RUNTIME_URL ?? "http://127.0.0.1:4567").replace(/\/+$/, "");
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

async function body(request) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function proxy(request, response) {
  const incoming = new URL(request.url ?? "/", "http://localhost");
  const target = `${RUNTIME}${incoming.pathname.replace(/^\/api\/mihon/, "/api")}${incoming.search}`;
  const headers = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP.has(key) && typeof value === "string") headers[key] = value;
  }

  let upstream;
  try {
    upstream = await fetch(target, { method: request.method, headers, body: await body(request) });
  } catch (error) {
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: `runtime unreachable at ${RUNTIME}`, detail: String(error) }));
    return;
  }

  const out = {};
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key)) out[key] = value;
  });
  response.writeHead(upstream.status, out);
  if (upstream.body === null) {
    response.end();
    return;
  }
  for await (const chunk of upstream.body) response.write(chunk);
  response.end();
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
  const handler = path.startsWith("/api/mihon/") ? proxy : serveStatic;
  handler(request, response).catch((error) => {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`proxy error: ${String(error)}`);
  });
});

server.listen(PORT, () => {
  console.log(`HardlyTracking on http://127.0.0.1:${PORT} (runtime ${RUNTIME}, dist ${DIST})`);
});

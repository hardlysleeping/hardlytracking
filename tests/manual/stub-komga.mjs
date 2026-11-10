/**
 * A stand-in Komga, for proving the browser build's /api/komga hop end to end.
 *
 *   node tests/manual/stub-komga.mjs        # :25611, login tester / secret
 *
 * Point Settings → Extensions → Komga at http://127.0.0.1:25611 and sign in as tester / secret. Every
 * request is kept in GET /__log, authorization header included, so the forwarding can be read back
 * instead of assumed. Not part of `npm test`: it is a server, run by hand when the hop changes.
 *
 * Answers the five routes `src/api/komga.ts` uses, with basic auth, a 2x2 PNG for every cover and
 * page, and a log of every request so the route's forwarding can be read back. Test scaffolding
 * only: no credentials, no real library.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 25611);
const USER = process.env.KOMGA_USER ?? "tester";
const PASS = process.env.KOMGA_PASS ?? "secret";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0000003010100" +
    "5c5d5a5f0000000049454e44ae426082",
  "hex",
);

const LIBRARIES = [{ id: "lib-1", name: "Stub library" }];
const SERIES = {
  id: "s-1",
  name: "Stub Saga",
  libraryId: "lib-1",
  booksCount: 3,
  booksReadCount: 0,
  metadata: { title: "Stub Saga", summary: "A stand-in series.", status: "ONGOING" },
  booksMetadata: { authors: [{ name: "Test Author" }] },
};
const BOOKS = [1, 2, 3].map((n) => ({
  id: `b-${n}`,
  name: `Stub Saga ${String(n).padStart(2, "0")}`,
  number: n,
  seriesId: "s-1",
  media: { pagesCount: 2, mediaType: "image/jpeg", status: "READY" },
  metadata: { title: `Stub Saga ${String(n).padStart(2, "0")}`, numberSort: n },
  // b-3 arrives already finished, the way a book read in Komga's own web UI would.
  ...(n === 3 ? { readProgress: { page: 2, completed: true, readDate: new Date().toISOString() } } : {}),
}));

const log = [];

function json(res, body, status = 200) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": bytes.length });
  res.end(bytes);
}

/**
 * Serve under a path, the way a reverse proxy publishes Komga at `https://host/komga`.
 *
 *   KOMGA_PATH=/komga node tests/manual/stub-komga.mjs
 *
 * Anything outside that path answers 404 — which is exactly what a base URL whose path was dropped
 * gets, so the browser build's `/api/komga` hop can be proven to keep it.
 */
const PREFIX = (process.env.KOMGA_PATH ?? "").replace(/\/+$/, "");

const server = createServer((req, res) => {
  const asked = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  log.push(`${req.method} ${asked.pathname}${asked.search} auth=${req.headers.authorization ?? "none"} ua=${(req.headers["user-agent"] ?? "").slice(0, 12)}`);
  if (PREFIX !== "" && !asked.pathname.startsWith(`${PREFIX}/`) && asked.pathname !== "/__log") {
    const body = '{"error":"no route here"}';
    res.writeHead(404, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
    return res.end(body);
  }
  const rest = PREFIX === "" ? asked.pathname : asked.pathname.slice(PREFIX.length) || "/";
  const url = new URL(`${rest}${asked.search}`, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/__log") return json(res, log);
  if (url.pathname === "/api/v1/users/me") {
    const expected = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="Komga"', "content-length": "0" });
      return res.end();
    }
    return json(res, { id: "u-1", email: "stub@example.com" });
  }

  const expected = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
  if (req.headers.authorization !== expected) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="Komga"', "content-length": "0" });
    return res.end();
  }

  if (url.pathname === "/api/v1/libraries") return json(res, LIBRARIES);
  if (url.pathname === "/api/v1/series") {
    const search = url.searchParams.get("search") ?? "";
    const rows = search === "" || /stub/i.test(search) ? [SERIES] : [];
    return json(res, { content: rows, last: true, totalPages: 1, number: 0 });
  }
  if (url.pathname === "/api/v1/series/s-1") return json(res, SERIES);
  if (url.pathname === "/api/v1/books") return json(res, { content: BOOKS, last: true, totalPages: 1, number: 0 });
  if (/^\/api\/v1\/books\/b-\d+\/pages$/.test(url.pathname)) {
    return json(res, [
      { number: 1, fileName: "p1.png", mediaType: "image/png" },
      { number: 2, fileName: "p2.png", mediaType: "image/png" },
    ]);
  }
  if (/^\/api\/v1\/series\/s-1\/thumbnail$|^\/api\/v1\/books\/b-\d+\/pages\/\d+$/.test(url.pathname)) {
    res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
    return res.end(PNG);
  }
  if (/^\/api\/v1\/books\/b-\d+\/read-progress$/.test(url.pathname)) {
    res.writeHead(204);
    return res.end();
  }
  json(res, { error: `no stub for ${url.pathname}` }, 404);
});

server.listen(PORT, "127.0.0.1", () => console.log(`stub komga on http://127.0.0.1:${PORT} (${USER}/${PASS})`));

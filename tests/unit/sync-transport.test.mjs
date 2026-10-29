import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyDocument, parseSync, serializeSync } from "../../src/lib/sync/document.ts";
import { SyncTransportError } from "../../src/lib/sync/transport.ts";
import { DEFAULT_SYNC_FILE, folderTransport } from "../../src/lib/sync/transports/folder.ts";
import { webdavTransport } from "../../src/lib/sync/transports/webdav.ts";

const base = process.env.TMPDIR ?? tmpdir();
const stamp = { at: 1_700_000_000_000, device: "dev-a" };
const USER = "sync-user";
const PASS = "s3cret-pass-phrase";

/** A real document with rows in more than one collection, so a transport is not just copying `{}`. */
function sample() {
  const doc = emptyDocument("dev-a", 1_700_000_000_000);
  doc.series = [
    { id: "mihon:2", provider: "mihon", title: "Second", categoryIds: ["c1"], ...stamp },
    { id: "mihon:1", provider: "mihon", title: "First", author: "A", categoryIds: [], ...stamp },
  ];
  doc.categories = [{ id: "c1", name: "Comics", order: 0, hidden: false, pinned: true, ...stamp }];
  doc.progress = [{ chapterId: "mihon:ch:1", seriesId: "mihon:1", page: 3, total: 20, ...stamp }];
  doc.readState = [{ chapterId: "mihon:ch:1", read: true, ...stamp }];
  doc.tombstones = [{ kind: "series", id: "mihon:gone", ...stamp }];
  return doc;
}

async function tempDir(t) {
  const dir = await mkdtemp(join(base, "ht-sync-transport-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A local stand-in for a WebDAV server: records every request, answers what the test asks. */
async function stubServer(t) {
  const requests = [];
  const reply = { status: 200, body: "" };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.statusCode = reply.status;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(reply.body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  const { port } = server.address();
  return { requests, reply, url: `http://127.0.0.1:${port}/dav/hardlytracking-sync.json` };
}

// ---------------------------------------------------------------- folder

test("folder: write then read returns the same bytes", async (t) => {
  const dir = await tempDir(t);
  const transport = folderTransport({ dir });
  const text = serializeSync(sample());

  await transport.write(text);
  assert.equal(await transport.read(), text);
  assert.equal(await readFile(join(dir, DEFAULT_SYNC_FILE), "utf8"), text);
});

test("folder: a store that holds nothing yet reads as null, not as an error", async (t) => {
  const dir = await tempDir(t);
  assert.equal(await folderTransport({ dir }).read(), null);

  const missing = join(dir, "not-created-yet");
  assert.equal(await folderTransport({ dir: missing }).read(), null);
});

test("folder: writing twice leaves one valid document and no temp files behind", async (t) => {
  const dir = await tempDir(t);
  const transport = folderTransport({ dir });
  const first = serializeSync(sample());
  const second = serializeSync(emptyDocument("dev-b", 1_700_000_001_000));

  await transport.write(first);
  await transport.write(second);

  const entries = await readdir(dir);
  assert.deepEqual(entries, [DEFAULT_SYNC_FILE], `only the document may remain, found ${entries.join(", ")}`);

  const back = await transport.read();
  assert.equal(back, second, "the second write wins");
  assert.equal(serializeSync(parseSync(back)), second, "and it is still a valid document");
});

test("folder: a missing directory is created, including nested ones", async (t) => {
  const root = await tempDir(t);
  const dir = join(root, "sync", "hardlytracking");
  const transport = folderTransport({ dir });
  const text = serializeSync(sample());

  await transport.write(text);

  assert.equal(await transport.read(), text);
  assert.deepEqual(await readdir(dir), [DEFAULT_SYNC_FILE]);
});

test("folder: the file name can be overridden without changing the default", async (t) => {
  const dir = await tempDir(t);
  await mkdir(join(dir, "legacy"), { recursive: true });
  const transport = folderTransport({ dir, file: join("legacy", "old-name.json") });
  const text = serializeSync(sample());

  await transport.write(text);

  assert.equal(await transport.read(), text);
  assert.deepEqual(await readdir(join(dir, "legacy")), ["old-name.json"]);
});

// ---------------------------------------------------------------- webdav

test("webdav: PUT carries the method, the exact path, Basic auth and the identical bytes", async (t) => {
  const server = await stubServer(t);
  const transport = webdavTransport({ url: server.url, username: USER, password: PASS });
  const text = serializeSync(sample());

  await transport.write(text);

  assert.equal(server.requests.length, 1);
  const put = server.requests[0];
  assert.equal(put.method, "PUT");
  assert.equal(put.path, "/dav/hardlytracking-sync.json");
  assert.equal(put.headers.authorization, `Basic ${Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64")}`);
  assert.equal(put.headers["content-type"], "application/json");
  assert.deepEqual(Buffer.from(put.body, "utf8"), Buffer.from(text, "utf8"), "byte-identical body");
});

test("webdav: a 404 means the store holds nothing yet", async (t) => {
  const server = await stubServer(t);
  server.reply.status = 404;
  server.reply.body = "not found";

  assert.equal(await webdavTransport({ url: server.url, username: USER, password: PASS }).read(), null);
  assert.equal(server.requests[0].method, "GET");
});

test("webdav: a 410 is also an empty store, not a failure", async (t) => {
  const server = await stubServer(t);
  server.reply.status = 410;

  assert.equal(await webdavTransport({ url: server.url, username: USER, password: PASS }).read(), null);
});

test("webdav: a 500 is a transport error naming the status and never the password", async (t) => {
  const server = await stubServer(t);
  server.reply.status = 500;
  server.reply.body = "storage backend unavailable\nplease retry";

  const transport = webdavTransport({ url: server.url, username: USER, password: PASS });

  await assert.rejects(transport.read(), (error) => {
    assert.ok(error instanceof SyncTransportError, "a transport failure, not a raw fetch error");
    assert.equal(error.transport, transport.name);
    assert.match(error.message, /500/);
    assert.match(error.message, /storage backend unavailable/, "the body excerpt is shown");
    assert.ok(!error.message.includes(PASS), "the password must never appear in a message");
    assert.ok(!error.message.includes("Authorization"), "nor the header that carries it");
    return true;
  });

  await assert.rejects(transport.write(serializeSync(sample())), (error) => {
    assert.ok(error instanceof SyncTransportError);
    assert.match(error.message, /PUT/);
    assert.match(error.message, /500/);
    assert.ok(!error.message.includes(PASS));
    return true;
  });
});

test("webdav: a 200 body is returned exactly, and an unreachable host is a transport error", async (t) => {
  const server = await stubServer(t);
  const text = serializeSync(sample());
  server.reply.status = 200;
  server.reply.body = text;

  const transport = webdavTransport({ url: server.url, username: USER, password: PASS });
  assert.equal(await transport.read(), text);

  const broken = webdavTransport({ url: "http://127.0.0.1:1/dav/doc.json", username: USER, password: PASS });
  await assert.rejects(broken.read(), (error) => {
    assert.ok(error instanceof SyncTransportError);
    assert.match(error.message, /could not reach/);
    assert.ok(!error.message.includes(PASS));
    return true;
  });
});

test("webdav: an injected fetch is used instead of the global one", async (t) => {
  const text = serializeSync(sample());
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, body: init.body });
    return new Response(init.method === "GET" ? text : "", { status: 200 });
  };

  const transport = webdavTransport({
    url: "https://cloud.example.invalid/dav/doc.json",
    username: USER,
    password: PASS,
    fetchImpl,
  });

  await transport.write(text);
  assert.equal(await transport.read(), text);
  assert.deepEqual(seen.map((call) => call.method), ["PUT", "GET"]);
  assert.equal(seen[0].body, text);
});

// ---------------------------------------------------------------- both

test("both transports carry the same bytes, and the document survives write -> read -> parse", async (t) => {
  const dir = await tempDir(t);
  const server = await stubServer(t);
  const text = serializeSync(sample());
  server.reply.status = 200;
  server.reply.body = text;

  const folder = folderTransport({ dir });
  const webdav = webdavTransport({ url: server.url, username: USER, password: PASS });

  await folder.write(text);
  await webdav.write(text);

  const fromFolder = await folder.read();
  const fromWebdav = await webdav.read();

  assert.equal(fromFolder, text);
  assert.equal(fromWebdav, text);
  assert.equal(fromFolder, fromWebdav, "two transports, one byte stream");

  const folderDoc = parseSync(fromFolder);
  const webdavDoc = parseSync(fromWebdav);
  assert.deepEqual(folderDoc, webdavDoc);
  assert.equal(serializeSync(folderDoc), text, "serialize(parse(transport bytes)) === original");
  assert.equal(serializeSync(webdavDoc), text);
  assert.equal(folderDoc.series.length, 2);
});

test("both transports carry an empty document unchanged too", async (t) => {
  const dir = await tempDir(t);
  const server = await stubServer(t);
  const text = serializeSync(emptyDocument("dev-empty", 1_700_000_000_000));
  server.reply.body = text;

  const folder = folderTransport({ dir });
  const webdav = webdavTransport({ url: server.url, username: USER, password: PASS });

  await folder.write(text);
  await webdav.write(text);

  assert.equal(await folder.read(), text);
  assert.equal(await webdav.read(), text);
  assert.equal(serializeSync(parseSync(await folder.read())), text);
});

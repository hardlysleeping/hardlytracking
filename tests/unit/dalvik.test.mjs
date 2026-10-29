import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DalvikClient, DalvikError, createDalvikProvider, packageIdFromApkName } from "../../src/api/dalvik.ts";

/** A stand-in runtime: records every body and answers from a table. */
async function stubRuntime(handlers, capabilities = { mangayomiMihonBridge: 1, imageProxy: true }) {
  const seen = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/capabilities") {
      seen.push({ url: req.url, body: null, headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(capabilities));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ url: req.url, body, headers: req.headers });
      const handler = handlers[body.method];
      if (handler === undefined) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `Unknown method: ${body.method}`, code: 500 }));
        return;
      }
      const { status = 200, json, headers = {} } = handler(body);
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(typeof json === "string" ? json : JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const source = { id: "2499283573021220255", name: "MangaDex", lang: "en", baseUrl: "https://mangadex.org" };
const manga = {
  url: "/manga/93704d83-322c-4214-99bc-6984cf536795",
  title: "Kirara Hoshikita Wants to Shine!",
  artist: "Ichiki",
  author: "Ichiki",
  description: "A romantic comedy.",
  status: 1,
  thumbnail_url: "/image/191ea870-33a1-42ee-b7fc-652ff9ef94b5",
  initialized: false,
};
const chapter = {
  url: "/chapter/52717964-ef7e-47a7-9792-e779e91b916f",
  name: "Ch.3",
  date_upload: 1791631124000,
  chapter_number: -1,
  scanlator: "Luminare Translations",
};
const page = {
  index: 0,
  url: "https://cmdxd98sb0x3yprd.mangadex.network,https://api.mangadex.org/at-home/server/x,1793309641144",
  imageUrl: "/image/1c82cffc-a130-423b-adb2-212d14df3a3e",
  headers: null,
};

function runtimeHandlers() {
  return {
    sourcesManga: () => ({ json: [source], headers: { "x-mangayomi-extension-id": "12fde776apk" } }),
    getPopularManga: () => ({ json: { mangas: [manga], hasNextPage: true } }),
    getLatestManga: () => ({ json: { mangas: [manga], hasNextPage: false } }),
    getSearchManga: () => ({ json: { mangas: [manga], hasNextPage: false } }),
    getDetailsManga: () => ({ json: manga }),
    getChapterList: () => ({ json: [chapter] }),
    getPageList: () => ({ json: [page] }),
  };
}

test("install sends the APK as base64 and takes the id the runtime hands back", async () => {
  const runtime = await stubRuntime(runtimeHandlers());
  try {
    const client = new DalvikClient({ baseUrl: runtime.baseUrl });
    const installed = await client.install(new Uint8Array([1, 2, 3]));
    assert.equal(installed.extensionId, "12fde776apk");
    assert.deepEqual(installed.sources.map((s) => s.id), [source.id]);

    const sent = runtime.seen[0];
    assert.equal(sent.url, "/dalvik");
    assert.equal(sent.body.method, "sourcesManga");
    assert.equal(sent.body.data, Buffer.from([1, 2, 3]).toString("base64"));
    assert.equal(sent.headers["content-type"], "application/json");
  } finally {
    await runtime.close();
  }
});

test("an APK the runtime accepts without an id is an error, not a silent success", async () => {
  const runtime = await stubRuntime({ sourcesManga: () => ({ json: [source] }) });
  try {
    const client = new DalvikClient({ baseUrl: runtime.baseUrl });
    await assert.rejects(client.install(new Uint8Array([1])), (error) => {
      return error instanceof DalvikError && error.message.includes("no extension id");
    });
  } finally {
    await runtime.close();
  }
});

test("the runtime's own error message survives, with its status and code", async () => {
  const runtime = await stubRuntime({
    getPageList: () => ({ status: 409, json: { error: "Extension handle gone; resend the APK", code: 409 } }),
  });
  try {
    const client = new DalvikClient({ baseUrl: runtime.baseUrl });
    await assert.rejects(client.call({ method: "getPageList", extensionId: "gone" }), (error) => {
      return (
        error instanceof DalvikError &&
        error.status === 409 &&
        error.runtimeCode === 409 &&
        error.message.includes("resend the APK")
      );
    });
  } finally {
    await runtime.close();
  }
});

test("a host that is not there, and a host that answers nonsense, are both errors", async () => {
  const client = new DalvikClient({ baseUrl: "http://127.0.0.1:9" });
  await assert.rejects(client.call({ method: "sourcesManga" }), (error) => {
    return error instanceof DalvikError && error.status === 0 && error.message.includes("not answering");
  });

  const runtime = await stubRuntime({ sourcesManga: () => ({ json: "<html>not json</html>" }) });
  try {
    const odd = new DalvikClient({ baseUrl: runtime.baseUrl });
    await assert.rejects(odd.call({ method: "sourcesManga" }), (error) => {
      return error instanceof DalvikError && error.message.includes("not JSON");
    });
  } finally {
    await runtime.close();
  }
});

test("the provider namespaces every id and never lets two hosts collide", async () => {
  const runtime = await stubRuntime(runtimeHandlers());
  try {
    const client = new DalvikClient({ baseUrl: runtime.baseUrl });
    const provider = createDalvikProvider({
      client,
      extensions: [{ extensionId: "12fde776apk", packageId: "eu.kanade.tachiyomi.extension.all.mangadex", sources: [source] }],
    });
    const sources = await provider.sources();
    assert.deepEqual(sources.map((s) => s.id), [`dalvik:src:${source.id}`]);
    assert.equal(provider.kind, "dalvik");
    assert.equal(provider.ownsProgress, true, "the runtime has no read-state API, so our database is the writer");
  } finally {
    await runtime.close();
  }
});

test("popular maps the runtime's manga into our Series, with a loadable cover", async () => {
  const runtime = await stubRuntime(runtimeHandlers());
  try {
    const client = new DalvikClient({ baseUrl: runtime.baseUrl });
    const provider = createDalvikProvider({
      client,
      extensions: [{ extensionId: "12fde776apk", packageId: "pkg", sources: [source] }],
    });
    const result = await provider.popular(source.id, 1);
    assert.equal(result.hasNext, true);
    const [series] = result.items;
    assert.equal(series.id, `dalvik:${source.id}:${manga.url}`);
    assert.equal(series.title, manga.title);
    assert.equal(series.cover, `${runtime.baseUrl}/image/191ea870-33a1-42ee-b7fc-652ff9ef94b5`);
    assert.equal(runtime.seen.at(-1).body.extensionId, "12fde776apk");
    assert.equal(runtime.seen.at(-1).body.page, 1);
  } finally {
    await runtime.close();
  }
});

test("a chapter with no parsable number becomes 0 rather than sorting to the top", async () => {
  const runtime = await stubRuntime(runtimeHandlers());
  try {
    const client = new DalvikClient({ baseUrl: runtime.baseUrl });
    const provider = createDalvikProvider({
      client,
      extensions: [{ extensionId: "12fde776apk", packageId: "pkg", sources: [source] }],
    });
    const seriesId = `dalvik:${source.id}:${manga.url}`;
    const [first] = await provider.chapters(seriesId);
    assert.equal(first.number, 0, "-1 means unparsed, not chapter minus one");
    assert.equal(first.name, "Ch.3");
    assert.equal(first.seriesId, seriesId);
    assert.equal(first.id, `dalvik:ch:${source.id}:${chapter.url}`);
    assert.equal(runtime.seen.at(-1).body.mangaData.url, manga.url);
  } finally {
    await runtime.close();
  }
});

test("pages use the runtime's image address, never the bridge memo", async () => {
  const runtime = await stubRuntime(runtimeHandlers());
  try {
    const client = new DalvikClient({ baseUrl: runtime.baseUrl });
    const provider = createDalvikProvider({
      client,
      extensions: [{ extensionId: "12fde776apk", packageId: "pkg", sources: [source] }],
    });
    const pages = await provider.pages(`dalvik:ch:${source.id}:${chapter.url}`);
    assert.deepEqual(pages, [{ index: 0, url: `${runtime.baseUrl}/image/1c82cffc-a130-423b-adb2-212d14df3a3e` }]);
    assert.equal(runtime.seen.at(-1).body.chapterData.url, chapter.url);
  } finally {
    await runtime.close();
  }
});

test("a page with no address at all fails loudly instead of rendering a blank", async () => {
  const runtime = await stubRuntime({ getPageList: () => ({ json: [{ index: 0 }] }) });
  try {
    const client = new DalvikClient({ baseUrl: runtime.baseUrl });
    const provider = createDalvikProvider({
      client,
      extensions: [{ extensionId: "12fde776apk", packageId: "pkg", sources: [source] }],
    });
    await assert.rejects(provider.pages(`dalvik:ch:${source.id}:/chapter/x`), /without an image address/);
  } finally {
    await runtime.close();
  }
});

test("the source id the UI has is the namespaced one, and the host still gets the bare id", async () => {
  const runtime = await stubRuntime(runtimeHandlers());
  try {
    const client = new DalvikClient({ baseUrl: runtime.baseUrl });
    const provider = createDalvikProvider({
      client,
      extensions: [{ extensionId: "12fde776apk", packageId: "pkg", sources: [source] }],
    });
    const [listed] = await provider.sources();
    // Browse hands back exactly what the chip carries.
    const result = await provider.popular(listed.id, 1);
    assert.equal(result.items[0].id, `dalvik:${source.id}:${manga.url}`, "ids stay keyed by the bare source id");
    assert.equal(runtime.seen.at(-1).body.sourceId, source.id, "the host is told the bare source id");
    assert.equal(runtime.seen.at(-1).body.extensionId, "12fde776apk");
  } finally {
    await runtime.close();
  }
});

test("a source no installed extension exposes is named, not answered with an empty page", async () => {
  const runtime = await stubRuntime(runtimeHandlers());
  try {
    const client = new DalvikClient({ baseUrl: runtime.baseUrl });
    const provider = createDalvikProvider({ client, extensions: [] });
    await assert.rejects(provider.popular(source.id, 1), /no installed extension exposes source/);
  } finally {
    await runtime.close();
  }
});

test("read state is refused by name, because the runtime cannot write it", async () => {
  const runtime = await stubRuntime(runtimeHandlers());
  try {
    const client = new DalvikClient({ baseUrl: runtime.baseUrl });
    const provider = createDalvikProvider({ client, extensions: [] });
    await assert.rejects(provider.setRead(`dalvik:ch:${source.id}:/chapter/x`, true), /read marks live in our database/);
  } finally {
    await runtime.close();
  }
});

test("asset() makes a runtime path loadable and leaves a full address alone", () => {
  const client = new DalvikClient({ baseUrl: "http://127.0.0.1:8792/" });
  assert.equal(client.asset("/image/abc"), "http://127.0.0.1:8792/image/abc");
  assert.equal(client.asset("image/abc"), "http://127.0.0.1:8792/image/abc");
  assert.equal(client.asset("https://cdn.example/x.jpg"), "https://cdn.example/x.jpg");
  // The runtime mints absolute proxy addresses; from the same origin they stay put.
  assert.equal(client.asset("http://127.0.0.1:8792/image/abc"), "http://127.0.0.1:8792/image/abc");
  assert.equal(client.asset(null), undefined);
  assert.equal(client.asset(""), undefined);
});

test("through the app's proxy, an absolute runtime image address is re-pointed at one origin", () => {
  // The browser build talks to `/api/dalvik` (server/proxy.mjs), so the page must never be
  // handed the runtime's loopback port.
  const client = new DalvikClient({ baseUrl: "/api/dalvik" });
  assert.equal(client.asset("http://127.0.0.1:8792/image/abc"), "/api/dalvik/image/abc");
  assert.equal(client.asset("http://127.0.0.1:8792/video/abc"), "/api/dalvik/video/abc");
  assert.equal(client.asset("/image/abc"), "/api/dalvik/image/abc");
  // A source's own CDN is not one of the runtime's routes: leave it loadable.
  assert.equal(client.asset("https://cmdxd98sb0x3yprd.mangadex.network/x/1.png"), "https://cmdxd98sb0x3yprd.mangadex.network/x/1.png");
});

test("capabilities() is the registration test, and a host that does not advertise the bridge is refused", async () => {
  const good = await stubRuntime(runtimeHandlers(), { mangayomiMihonBridge: 1, imageProxy: true });
  try {
    const capabilities = await new DalvikClient({ baseUrl: good.baseUrl }).capabilities();
    assert.equal(capabilities.mangayomiMihonBridge, 1);
    assert.equal(capabilities.imageProxy, true);
  } finally {
    await good.close();
  }

  const odd = await stubRuntime(runtimeHandlers(), { hello: "world" });
  try {
    await assert.rejects(new DalvikClient({ baseUrl: odd.baseUrl }).capabilities(), /does not advertise the \/dalvik bridge/);
  } finally {
    await odd.close();
  }

  const dead = new DalvikClient({ baseUrl: "http://127.0.0.1:9" });
  await assert.rejects(dead.capabilities(), /no extension host at/);
});

test("the package id comes from the file name, because the host cannot tell us", () => {
  assert.equal(packageIdFromApkName("eu.kanade.tachiyomi.extension.all.mangadex.apk"), "eu.kanade.tachiyomi.extension.all.mangadex");
  assert.equal(packageIdFromApkName("/home/me/Downloads/mangadex.APK"), "mangadex");
  assert.equal(packageIdFromApkName("no-extension"), "no-extension");
});

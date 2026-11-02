/**
 * The dalvik transport against a host that misbehaves on purpose.
 *
 * Every test here talks to `tests/fixtures/dalvik-mock.mjs` — a fake M-Extension-Server — through
 * the app's own code: `DalvikClient`, `createDalvikProvider`, `imageSrc`, `loadRepository`,
 * `parseIndex`, `updateState`. Nothing is stubbed at the app's edge, so what passes here is what
 * the reader runs.
 *
 * The cases are the ones that only show up against a real host: a source that wants a `Referer`,
 * a session cookie, a WebView login, an endpoint that is slow, one that answers 500, one that
 * answers HTML where JSON belongs, an empty list, a relative image path, `hasNextPage` paging, and
 * a repository whose index advertises an update.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  startDalvikMock,
  createCookieJar,
  PACKAGE_NAME,
  EXTENSION_NAME,
  VERSION_CODE,
  SOURCE_IDS,
  SESSION_COOKIE,
  APK_FILE,
} from "../fixtures/dalvik-mock.mjs";
import { DalvikClient, DalvikError, createDalvikProvider, packageIdFromApkName } from "../../src/api/dalvik.ts";
import { imageSrc } from "../../src/lib/pages.ts";
import { loadRepository, downloadApk, candidateIndexUrls } from "../../src/lib/extensions/repository.ts";
import { parseIndex, updateState } from "../../src/lib/extensions/index.ts";

/** Start a fixture, run `body`, and always close it — a held-open socket would stall the suite. */
async function withMock(options, body) {
  const mock = await startDalvikMock(options);
  try {
    return await body(mock);
  } finally {
    await mock.close();
  }
}

/** A client and a provider wired to one fixture, the way the app wires them to a real host. */
function wire(mock, options = {}) {
  const client = new DalvikClient({ baseUrl: options.baseUrl ?? mock.baseUrl, ...(options.client ?? {}) });
  const extensions =
    options.extensions ??
    [{ extensionId: mock.extensionId, packageId: PACKAGE_NAME, name: EXTENSION_NAME, sources: mock.sources() }];
  return { client, provider: createDalvikProvider({ client, extensions }), extensions };
}

/** `dalvik:src:<id>`, exactly what a source chip carries. */
function sourceId(key) {
  return `dalvik:src:${SOURCE_IDS[key]}`;
}

test("the fixture advertises the /dalvik bridge, and the client lists its sources namespaced", async () => {
  await withMock({}, async (mock) => {
    const { client, provider } = wire(mock);
    const capabilities = await client.capabilities();
    assert.equal(capabilities.mangayomiMihonBridge, 1);
    assert.equal(capabilities.imageProxy, true);

    const sources = await provider.sources();
    assert.deepEqual(
      sources.map((s) => s.id),
      [SOURCE_IDS.html, SOURCE_IDS.json, SOURCE_IDS.login, SOURCE_IDS.cookie].map((id) => `dalvik:src:${id}`),
    );
    assert.equal(sources[0].name, "Fixture HTML");
  });
});

test("a host that answers but does not advertise the bridge is refused", async () => {
  await withMock({}, async (mock) => {
    const client = new DalvikClient({ baseUrl: mock.scenarioUrl("no-bridge") });
    await assert.rejects(client.capabilities(), (error) => {
      assert.ok(error instanceof DalvikError);
      assert.match(error.message, /does not advertise the \/dalvik bridge/);
      return true;
    });
  });
});

test("install: the APK's sha256 is the extension id, and the same bytes always land on the same id", async () => {
  await withMock({}, async (mock) => {
    const { client } = wire(mock);
    const apk = new Uint8Array(await (await fetch(`${mock.baseUrl}/repo/${APK_FILE}`)).arrayBuffer());
    const expected = createHash("sha256").update(apk).digest("hex");

    const first = await client.install(apk);
    const second = await client.install(apk);
    assert.equal(first.extensionId, expected);
    assert.equal(second.extensionId, expected, "the id is a content hash, so re-installing is idempotent");
    assert.deepEqual(
      first.sources.map((s) => s.id),
      [SOURCE_IDS.html, SOURCE_IDS.json, SOURCE_IDS.login, SOURCE_IDS.cookie],
    );
    assert.equal(mock.state.installs.length, 2);
    assert.equal(mock.state.installs[0].bytes, apk.byteLength);
  });
});

test("the headers a page declares are sent to the image route, and the route 403s without them", async () => {
  await withMock({}, async (mock) => {
    const { provider } = wire(mock);
    const series = (await provider.popular(sourceId("html"), 1)).items[0];
    const chapters = await provider.chapters(series.id);
    const pages = await provider.pages(chapters[0].id);

    // Page 0 declares nothing; page 1 declares the source's Referer. That is the real shape:
    // a source whose images 403 on a bare request, and a reader that must send them.
    assert.equal(pages[0].headers, undefined);
    const guarded = pages[1];
    assert.deepEqual(guarded.headers, { referer: "https://fixture.example/", "user-agent": "HardlyTracking/fixture" });

    const bare = await fetch(guarded.url);
    assert.equal(bare.status, 403, "the fixture refuses an image request without the declared headers");

    const withHeaders = await fetch(guarded.url, { headers: guarded.headers });
    assert.equal(withHeaders.status, 200);
    assert.equal(withHeaders.headers.get("content-type"), "image/png");

    // What the reader actually loads: `imageSrc` turns a header-carrying page into our own
    // `/api/img?url=…&h=…` request, which is the only way a browser can send them.
    const src = imageSrc(guarded);
    assert.match(src, /^\/api\/img\?url=/);
    const decoded = JSON.parse(Buffer.from(new URL(src, "http://app.local").searchParams.get("h"), "base64url").toString("utf8"));
    assert.deepEqual(decoded, guarded.headers);
    const throughApp = await fetch(guarded.url, { headers: decoded });
    assert.equal(throughApp.status, 200, "the headers survive the round trip through /api/img's h=");
    assert.equal(imageSrc(pages[0]), pages[0].url, "a page without headers stays a plain <img> url");

    const seen = mock.state.site.filter((entry) => entry.path.endsWith("fixture-1-2.png")).at(-1);
    assert.equal(seen.headers.referer, "https://fixture.example/");
    assert.deepEqual(seen.missing, []);
  });
});

test("the host's own /image proxy takes the same headers in the query, and 403s without them", async () => {
  await withMock({}, async (mock) => {
    const { provider } = wire(mock);
    const series = (await provider.popular(sourceId("json"), 1)).items[0];
    const chapters = await provider.chapters(series.id);
    const pages = await provider.pages(chapters[0].id);

    const guarded = pages[1];
    assert.match(guarded.url, /\/image\/page-fixture-1-2$/);
    assert.equal((await fetch(guarded.url)).status, 403);

    const encoded = Buffer.from(JSON.stringify(guarded.headers)).toString("base64");
    const ok = await fetch(`${guarded.url}?headers=${encodeURIComponent(encoded)}`);
    assert.equal(ok.status, 200);
    const recorded = mock.state.images.at(-1);
    assert.equal(recorded.via, "query");
    assert.equal(recorded.headers.referer, "https://fixture.example/api/");
  });
});

test("a session cookie is handed out once and required back: a client without one gets a 403", async () => {
  await withMock({}, async (mock) => {
    const { provider } = wire(mock);
    const cookieSource = sourceId("cookie");

    // First call: the host sets the cookie and answers. Node's `fetch` keeps no jar, so the
    // second call is exactly the case the fixture exists for.
    assert.equal((await provider.popular(cookieSource, 1)).items.length, 4);
    await assert.rejects(provider.popular(cookieSource, 1), (error) => {
      assert.ok(error instanceof DalvikError);
      assert.equal(error.status, 403);
      assert.match(error.message, /missing session cookie/);
      return true;
    });
  });
});

test("a cookie jar through fetchImpl completes the round trip", async () => {
  await withMock({}, async (mock) => {
    const jar = createCookieJar();
    const { provider } = wire(mock, { client: { fetchImpl: jar.fetchImpl } });
    const cookieSource = sourceId("cookie");

    assert.equal((await provider.popular(cookieSource, 1)).items.length, 4);
    assert.equal(jar.jar.get(SESSION_COOKIE.name), SESSION_COOKIE.value, "the Set-Cookie was kept");
    assert.equal((await provider.popular(cookieSource, 1)).items.length, 4, "and sent back on the next call");
  });
});

test("a WebView-login source answers 401 with a login url until the login cookie is there", async () => {
  await withMock({}, async (mock) => {
    const jar = createCookieJar();
    const { client, provider } = wire(mock, { client: { fetchImpl: jar.fetchImpl } });
    const loginSource = sourceId("login");

    // The 401 carries the url the runtime would open in a WebView; read it from the wire.
    const raw = await fetch(`${mock.baseUrl}/dalvik`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "getPopularManga", extensionId: mock.extensionId, sourceId: SOURCE_IDS.login, page: 1 }),
    });
    assert.equal(raw.status, 401);
    const body = await raw.json();
    assert.equal(body.error, "login required");
    assert.match(body.loginUrl, /^\/login\?source=/);

    await assert.rejects(client.call({ method: "getPopularManga", extensionId: mock.extensionId, sourceId: SOURCE_IDS.login, page: 1 }), (error) => {
      assert.ok(error instanceof DalvikError);
      assert.equal(error.status, 401);
      assert.match(error.message, /login required/);
      return true;
    });

    // The login page is what the user completes; it sets the cookie the host then accepts.
    const login = await jar.fetchImpl(`${mock.baseUrl}${body.loginUrl}`);
    assert.equal(login.status, 200);
    assert.equal(mock.state.logins.at(-1).sourceId, SOURCE_IDS.login);

    assert.equal((await provider.popular(loginSource, 1)).items.length, 4, "the same source now answers");
  });
});

test("a slow endpoint ends in a client timeout instead of hanging, and answers when given time", async () => {
  await withMock({ delays: { getPageList: 400 } }, async (mock) => {
    const call = { method: "getPageList", extensionId: mock.extensionId, sourceId: SOURCE_IDS.html, chapterData: { url: "/chapter/fixture-1", name: "" } };

    const impatient = new DalvikClient({ baseUrl: mock.baseUrl, timeoutMs: 120 });
    const started = Date.now();
    await assert.rejects(impatient.call(call), (error) => {
      assert.ok(error instanceof DalvikError);
      assert.equal(error.status, 0);
      assert.match(error.message, /not answering/);
      return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 380, `the abort must beat the 400 ms response, took ${elapsed} ms`);

    const patient = new DalvikClient({ baseUrl: mock.baseUrl, timeoutMs: 5_000 });
    const pages = await patient.call(call);
    assert.equal(pages.body.length, 3, "the same endpoint answers when the timeout is not the limit");
  });
});

test("a 500 is an error carrying the host's own message, never an empty list", async () => {
  await withMock({ fail: { getPopularManga: "500" } }, async (mock) => {
    const { provider } = wire(mock);
    await assert.rejects(provider.popular(sourceId("html"), 1), (error) => {
      assert.ok(error instanceof DalvikError);
      assert.equal(error.status, 500);
      assert.equal(error.runtimeCode, 500);
      assert.match(error.message, /getPopularManga exploded/);
      return true;
    });
  });
});

test("malformed JSON is an error, not an empty page", async () => {
  await withMock({ fail: { getPopularManga: "malformed" } }, async (mock) => {
    const { provider } = wire(mock);
    await assert.rejects(provider.popular(sourceId("html"), 1), (error) => {
      assert.ok(error instanceof DalvikError);
      assert.equal(error.status, 200);
      assert.match(error.message, /not JSON/);
      return true;
    });
  });
});

test("an empty list is not an error: it is an empty page, and the two are told apart", async () => {
  await withMock({ fail: { getPopularManga: "empty", getPageList: "empty" } }, async (mock) => {
    const { provider } = wire(mock);
    const empty = await provider.popular(sourceId("html"), 1);
    assert.deepEqual(empty.items, []);
    assert.equal(empty.hasNext, false);

    assert.deepEqual(await provider.pages(`dalvik:ch:${SOURCE_IDS.html}:/chapter/fixture-1`), [], "and an empty page list");
  });
});

test("hasNextPage paging walks to the last page and stops there", async () => {
  await withMock({ maxPage: 3, perPage: 4 }, async (mock) => {
    const { provider } = wire(mock);
    const seen = [];
    for (const page of [1, 2, 3]) {
      const result = await provider.popular(sourceId("html"), page);
      seen.push({ page, count: result.items.length, hasNext: result.hasNext, first: result.items[0].title });
    }
    assert.deepEqual(seen, [
      { page: 1, count: 4, hasNext: true, first: "Fixture Title 1" },
      { page: 2, count: 4, hasNext: true, first: "Fixture Title 5" },
      { page: 3, count: 4, hasNext: false, first: "Fixture Title 9" },
    ]);
    assert.deepEqual(
      mock.state.calls.map((call) => call.body.page),
      [1, 2, 3],
      "the page number the client asked for is the page number the host saw",
    );

    const beyond = await provider.popular(sourceId("html"), 4);
    assert.deepEqual(beyond.items, []);
    assert.equal(beyond.hasNext, false, "past the last page the host says so, and the client believes it");
  });
});

test("search sends the query and latest is its own method", async () => {
  await withMock({}, async (mock) => {
    const { provider } = wire(mock);
    const found = await provider.search(sourceId("json"), "Fixture Title 6", 2);
    assert.deepEqual(found.items.map((s) => s.title), ["Fixture Title 6"]);
    assert.equal(mock.state.calls.at(-1).method, "getSearchManga");
    assert.equal(mock.state.calls.at(-1).body.search, "Fixture Title 6");

    await provider.latest(sourceId("json"), 1);
    assert.equal(mock.state.calls.at(-1).method, "getLatestManga");
    assert.equal(mock.state.calls.at(-1).body.extensionId, mock.extensionId);
  });
});

test("a bare relative image path resolves against the source's base url, not the host's", async () => {
  await withMock({}, async (mock) => {
    const { provider } = wire(mock);

    const html = (await provider.popular(sourceId("html"), 1)).items[0];
    assert.equal(html.cover, `${mock.baseUrl}/site/html/covers/1.png`, "the html source mints `covers/1.png`");
    const chapters = await provider.chapters(html.id);
    const pages = await provider.pages(chapters[0].id);
    assert.equal(pages[0].url, `${mock.baseUrl}/site/html/pages/fixture-1-1.png`);
    // The resolved address is loadable, which is the whole point of resolving it.
    assert.equal((await fetch(pages[0].url)).status, 200);

    const json = (await provider.popular(sourceId("json"), 1)).items[0];
    assert.equal(json.cover, `${mock.baseUrl}/image/cover-1`, "an absolute /image path stays the host's proxy");
  });
});

test("a source with no declared base url keeps the old behaviour: join the host, as before", async () => {
  await withMock({}, async (mock) => {
    const sources = mock.sources().map((source) => ({ ...source, baseUrl: undefined }));
    const { provider } = wire(mock, {
      extensions: [{ extensionId: mock.extensionId, packageId: PACKAGE_NAME, sources }],
    });
    const series = (await provider.popular(sourceId("html"), 1)).items[0];
    assert.equal(series.cover, `${mock.baseUrl}/covers/1.png`, "no base url means no guessing, just the host");
  });
});

test("a source's declared headers are readable through the protocol, not smuggled in the client", async () => {
  await withMock({}, async (mock) => {
    const { client } = wire(mock);
    const result = await client.call({
      method: "headersManga",
      extensionId: mock.extensionId,
      sourceId: SOURCE_IDS.html,
    });
    assert.deepEqual(result.body, { referer: "https://fixture.example/", "user-agent": "HardlyTracking/fixture" });
  });
});

test("the fixture repository reads as a v2 index, with the signing key the ecosystem publishes", async () => {
  await withMock({}, async (mock) => {
    const raw = await (await fetch(`${mock.baseUrl}/repo/index.json`)).json();
    assert.equal(raw.badgeLabel, "FIX");
    assert.match(raw.signingKey, /^[0-9a-f]{64}$/, "keiyoushi publishes a 64-hex fingerprint string");
    assert.equal(typeof raw.contact.website, "string");
    assert.equal(raw.extensionList.extensions[0].versionCode, "100", "v2 sends versionCode as a string");

    const repo = await loadRepository(`${mock.baseUrl}/repo`, { fetchImpl: (target) => fetch(target) });
    assert.equal(repo.indexUrl, `${mock.baseUrl}/repo/index.json`, "v2 is tried first");
    assert.equal(repo.name, "Fixture Repository");
    assert.equal(repo.extensions.length, 1);
    const [entry] = repo.extensions;
    assert.equal(entry.pkg, PACKAGE_NAME);
    assert.equal(entry.version, "1.0.0");
    assert.equal(entry.versionCode, 100, "a string versionCode is parsed, not compared as text");
    assert.equal(entry.lib, "1.6");
    assert.equal(entry.contentWarning, "SAFE", "CONTENT_WARNING_SAFE is normalised");
    assert.deepEqual(entry.sources.map((s) => s.id), [SOURCE_IDS.html, SOURCE_IDS.json, SOURCE_IDS.login, SOURCE_IDS.cookie]);
    assert.equal(entry.sources[0].lang, "en");
    assert.equal(entry.sources[0].homeUrl, "https://fixture.example/");
    assert.equal(entry.apkUrl, `${mock.baseUrl}/repo/${APK_FILE}`, "the fixture serves the APK from the same host");
  });
});

test("a legacy index.min.json is read when there is no index.json", async () => {
  await withMock({}, async (mock) => {
    // A legacy-only repository: index.json 404s, index.min.json is a bare array.
    const onlyLegacy = (target) =>
      target.endsWith("/index.json") ? Promise.resolve(new Response("", { status: 404 })) : fetch(target);
    const repo = await loadRepository(`${mock.baseUrl}/repo`, { fetchImpl: onlyLegacy });
    assert.equal(repo.indexUrl, `${mock.baseUrl}/repo/index.min.json`);
    assert.equal(repo.name, "Mihon repository", "the legacy format declares no repository name");
    const [entry] = repo.extensions;
    assert.equal(entry.pkg, PACKAGE_NAME);
    assert.equal(entry.versionCode, 100, "legacy `code` is a number");
    assert.equal(entry.contentWarning, "SAFE", "legacy `nsfw: 0`");
    assert.deepEqual(entry.sources.map((s) => s.lang), ["en", "en", "en", "en"]);
  });
});

test("an update is offered when the index's versionCode is ahead, and never as a downgrade", async () => {
  await withMock({}, async (mock) => {
    const current = await loadRepository(`${mock.baseUrl}/repo`, { fetchImpl: (target) => fetch(target) });
    const [entry] = current.extensions;
    assert.equal(updateState({ versionCode: VERSION_CODE }, entry), "up-to-date");
    assert.equal(updateState(undefined, entry), "new");
    assert.equal(updateState({ versionCode: VERSION_CODE + 50 }, entry), "downgrade");

    // The same repository one release later: `?update=1` bumps the version the way a real
    // publish would, so "an update is available" is a fact about the index, not a client guess.
    const later = await loadRepository(`${mock.scenarioUrl("update")}/repo`, { fetchImpl: (target) => fetch(target) });
    const [updated] = later.extensions;
    assert.equal(updated.versionCode, VERSION_CODE + 1);
    assert.equal(updated.version, "1.0.0-fixture-update");
    assert.equal(updateState({ versionCode: VERSION_CODE }, updated), "update");
  });
});

test("index → APK → host: the bytes install and expose the sources the index promised", async () => {
  await withMock({}, async (mock) => {
    const repo = await loadRepository(`${mock.baseUrl}/repo`, { fetchImpl: (target) => fetch(target) });
    const [entry] = repo.extensions;
    const apk = await downloadApk(entry, { fetchImpl: (target) => fetch(target) });
    assert.equal(apk.byteLength, 27, "the fixture APK is a few bytes, and that is the point");
    assert.equal(entry.pkg, PACKAGE_NAME, "the index's packageName is the extension's identity");
    assert.equal(packageIdFromApkName(`${PACKAGE_NAME}.apk`), PACKAGE_NAME);
    // A versioned file name is the ecosystem's convention and is *not* a package name; the
    // index's `packageName` is the authority, which is why the entry is keyed by it.
    assert.equal(packageIdFromApkName(entry.apkUrl.split("/").pop()), "fixture.demo-v1.0.0");

    const { client, provider } = wire(mock);
    const installed = await client.install(apk);
    assert.equal(installed.extensionId, mock.extensionId, "the id the host mints is the SHA-256 of these bytes");
    assert.deepEqual(installed.sources.map((s) => s.id), entry.sources.map((s) => s.id), "and the sources are the index's");

    const wired = createDalvikProvider({
      client,
      extensions: [{ extensionId: installed.extensionId, packageId: entry.pkg, sources: installed.sources }],
    });
    const result = await wired.popular(`dalvik:src:${installed.sources[0].id}`, 1);
    assert.equal(result.items.length, 4);
    assert.ok(provider.kind === "dalvik");
  });
});

test("a protobuf index is refused by name rather than answered with an empty repository", async () => {
  await withMock({}, async (mock) => {
    // A repository that publishes only a protobuf index: no JSON sibling to fall back to.
    const link = `${mock.baseUrl}/pb-only/index.pb`;
    const candidates = candidateIndexUrls(link);
    assert.equal(candidates.at(-1), link);
    await assert.rejects(loadRepository(link, { fetchImpl: (target) => fetch(target) }), (error) => {
      assert.match(error.message, /protobuf index \(index\.pb\)/);
      assert.ok(error.tried.some((line) => line.includes("404")), "and it says what it tried");
      return true;
    });
  });
});

test("/stop is answered, so a client can shut the host down", async () => {
  await withMock({}, async (mock) => {
    const response = await fetch(`${mock.baseUrl}/stop`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { stopped: true });
  });
});

test("the index parses to the same extension as the host it installs into", async () => {
  await withMock({}, async (mock) => {
    const raw = await (await fetch(`${mock.baseUrl}/repo/index.min.json`)).json();
    const index = parseIndex(raw);
    assert.equal(index.extensions.length, 1);
    const entry = index.extensions[0];
    assert.equal(entry.pkg, PACKAGE_NAME);
    assert.deepEqual(
      entry.sources.map((s) => s.id),
      [SOURCE_IDS.html, SOURCE_IDS.json, SOURCE_IDS.login, SOURCE_IDS.cookie],
      "the ids the index carries are the ids the host answers with",
    );
    assert.deepEqual(mock.sources().map((s) => s.id), entry.sources.map((s) => s.id));
  });
});

// ---- a source's own filters, over the wire --------------------------------

test("the host's own form arrives as the sheet's list; a source with none answers an empty one", async () => {
  await withMock({}, async (mock) => {
    const { provider } = wire(mock);

    const form = await provider.filters(sourceId("json"));
    assert.deepEqual(
      form.map((row) => `${row.kind}:${row.name}`),
      [
        "checkbox:Has available chapters",
        "header:Content rating",
        "checkbox:Safe",
        "checkbox:Suggestive",
        "checkbox:Pornographic",
        "sort:Sort",
        "select:Created within last",
        "header:Genre",
        "tristate:Action",
        "tristate:Horror",
      ],
      "a group is flattened into a header and its children, and each child keeps the group's name",
    );
    assert.deepEqual(
      form.filter((row) => row.group !== undefined).map((row) => row.group),
      ["Content rating", "Content rating", "Content rating", "Genre", "Genre"],
    );
    assert.equal(mock.state.calls.at(-1).method, "filtersManga");
    assert.equal(mock.state.calls.at(-1).body.extensionId, mock.extensionId);

    assert.deepEqual(await provider.filters(sourceId("cookie")), [], "no form is no button, not an error");

    const html = await provider.filters(sourceId("html"));
    assert.deepEqual(html.map((row) => row.kind), ["header", "text", "checkbox"], "two sources answer different forms");
  });
});

test("a searched choice travels as the host's own filterList, and changes the answer", async () => {
  await withMock({}, async (mock) => {
    const { provider } = wire(mock);

    const plain = await provider.search(sourceId("json"), "", 1);
    assert.deepEqual(plain.items.map((s) => s.title), ["Fixture Title 1", "Fixture Title 2", "Fixture Title 3", "Fixture Title 4"]);
    assert.equal(mock.state.calls.at(-1).body.filterList, undefined, "no choice means no filterList at all");

    // "Has available chapters" is a top-level checkbox: the host reads its state off its first child.
    const filtered = await provider.search(sourceId("json"), "", 1, { "0": { checkBoxState: true } });
    assert.deepEqual(filtered.items.map((s) => s.title), ["Fixture Title 1", "Fixture Title 3"]);
    assert.deepEqual(mock.state.calls.at(-1).body.filterList, [
      {
        name: "Has available chapters",
        type: "checkbox",
        stateList: [{ name: "Has available chapters", type: "checkbox", stateBoolean: true }],
      },
    ]);
  });
});

test("a sort and a group child change the result set, not only the payload", async () => {
  await withMock({}, async (mock) => {
    const { provider } = wire(mock);

    const sorted = await provider.search(sourceId("json"), "", 1, { "5": { sortState: { index: 0, ascending: false } } });
    assert.deepEqual(sorted.items.map((s) => s.title), ["Fixture Title 4", "Fixture Title 3", "Fixture Title 2", "Fixture Title 1"]);

    // One rating checkbox turned off is a group change carrying that child alone: the other two keep
    // the source's own defaults.
    const rated = await provider.search(sourceId("json"), "", 1, { "2": { checkBoxState: false }, "3": { checkBoxState: false } });
    // Safe off, Suggestive off, Pornographic left at its default (off): nothing on page 1 survives.
    assert.deepEqual(rated.items, []);
    assert.deepEqual(mock.state.calls.at(-1).body.filterList, [
      {
        name: "Content rating",
        type: "group",
        stateList: [
          { name: "Safe", type: "checkbox", stateBoolean: false },
          { name: "Suggestive", type: "checkbox", stateBoolean: false },
        ],
      },
    ]);

    // Naming the one rating the page does hold is a filter that keeps exactly it: Safe off leaves
    // Suggestive (the form's other default) and nothing else.
    const suggestive = await provider.search(sourceId("json"), "", 1, { "2": { checkBoxState: false } });
    assert.deepEqual(suggestive.items.map((s) => s.title), ["Fixture Title 3"], "only one title on the page is suggestive");
  });
});

test("a group tri-state includes and excludes; a text field narrows the html source", async () => {
  await withMock({}, async (mock) => {
    const { provider } = wire(mock);

    const action = await provider.search(sourceId("json"), "", 1, { "8": { triState: "INCLUDE" } });
    assert.deepEqual(action.items.map((s) => s.title), ["Fixture Title 1", "Fixture Title 2", "Fixture Title 4"], "title 3 is the horror one");

    const horror = await provider.search(sourceId("json"), "", 1, { "9": { triState: "INCLUDE" } });
    assert.deepEqual(horror.items.map((s) => s.title), ["Fixture Title 3"]);

    const authored = await provider.search(sourceId("html"), "", 1, { "1": { textState: "Other" } });
    assert.deepEqual(authored.items.map((s) => s.title), ["Fixture Title 1", "Fixture Title 3"], "odd titles are by Other Scribe");

    const finished = await provider.search(sourceId("html"), "", 1, { "2": { checkBoxState: true } });
    assert.deepEqual(finished.items.map((s) => s.title), ["Fixture Title 2", "Fixture Title 4"]);
  });
});

test("the form is read once and the search that carries choices reuses it", async () => {
  await withMock({}, async (mock) => {
    const { provider } = wire(mock);
    await provider.filters(sourceId("json"));
    await provider.search(sourceId("json"), "", 1, { "0": { checkBoxState: true } });
    assert.equal(mock.state.calls.filter((call) => call.method === "filtersManga").length, 1, "the sheet's answer is the one the search uses");

    // A search that carries a choice with no form read yet asks for it itself, rather than sending a
    // change against names it does not know.
    await mock.reset();
    const fresh = wire(mock);
    await fresh.provider.search(sourceId("json"), "", 1, { "0": { checkBoxState: true } });
    assert.equal(mock.state.calls.filter((call) => call.method === "filtersManga").length, 1);
    assert.equal(mock.state.calls.at(-1).body.filterList[0].name, "Has available chapters");
  });
});

/**
 * Cookies and the WebView seam, against a host that refuses until it sees a session.
 *
 * Two layers, deliberately:
 *
 * 1. **The rules** — `src/lib/webview/cookies.ts`. Parsing, domain scoping, expiry, merge. These
 *    are the parts that decide whether two sources can see each other's session (matrix row
 *    HTTP-08) and whether a logout actually logs out (WEB-05), so they are tested directly rather
 *    than only through a server.
 * 2. **The hand-off** — `loginSource` + the provider, against `tests/fixtures/dalvik-mock.mjs`,
 *    which refuses its login source with a 401 and its cookie source with a 403 until the right
 *    cookie comes back. The webview is faked the way the card asks: the fake "opens" the fixture's
 *    `/login` page and returns the `Set-Cookie` it set, exactly what a real webview reports.
 *
 * Nothing is stubbed at the app's edge: the provider, the client, the jar and the bridge are the
 * ones that ship. Only the webview itself is fake, because there is no window in a test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { startDalvikMock, LOGIN_COOKIE, SESSION_COOKIE, SOURCE_IDS, PACKAGE_NAME, EXTENSION_NAME } from "../fixtures/dalvik-mock.mjs";
import { DalvikClient, DalvikError, authHeaders, createDalvikProvider } from "../../src/api/dalvik.ts";
import { loginSource, loginUrlFor, needsLogin } from "../../src/api/mihon-bridge.ts";
import { cookieHeader, cookieKey, domainMatches, hostOf, mergeCookies, parseCookieHeader, parseSetCookie } from "../../src/lib/webview/cookies.ts";
import { memoryCookieJar } from "../../src/lib/webview/store.ts";
import { loginInWebview, webviewDriver } from "../../src/lib/webview/index.ts";
import { handleBridgeRequest, BRIDGE_WEBVIEW_PATH, BRIDGE_JAVASCRIPT_PATH } from "../../src/lib/webview/bridge.ts";

async function withMock(body, options = {}) {
  const mock = await startDalvikMock(options);
  try {
    return await body(mock);
  } finally {
    await mock.close();
  }
}

/** A client, a jar and a provider wired to one fixture, the way the app wires them to a real host. */
function wire(mock, jar = memoryCookieJar()) {
  const client = new DalvikClient({ baseUrl: mock.baseUrl });
  const extensions = [{ extensionId: mock.extensionId, packageId: PACKAGE_NAME, name: EXTENSION_NAME, sources: mock.sources() }];
  const provider = createDalvikProvider({ client, extensions, cookies: jar });
  return { client, extensions, jar, provider };
}

/**
 * A webview that opens the fixture's own login page.
 *
 * This is the fake the card asks for: `fetch` is the browser inside the webview, and the
 * `Set-Cookie` it comes back with is what a real one reports to the app when it closes.
 */
function fakeWebview({ cancel = false, userAgent = "HardlyTracking-Test/1.0" } = {}) {
  const opened = [];
  return {
    platform: "tauri",
    opened,
    async open(page) {
      opened.push(page);
      if (cancel) return null;
      const response = await fetch(page.url);
      await response.text();
      const setCookie = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      return { setCookie, url: page.url, userAgent };
    },
  };
}

// ---------------------------------------------------------------- the rules

test("a Set-Cookie becomes a stored cookie, with its attributes read", () => {
  const now = Date.UTC(2026, 9, 29);
  const cookie = parseSetCookie("session=abc123; Path=/reader; Domain=.Toonily.com; Max-Age=3600; HttpOnly; Secure", "toonily.com", now);
  assert.ok(cookie);
  assert.equal(cookie.name, "session");
  assert.equal(cookie.value, "abc123");
  assert.equal(cookie.domain, "toonily.com", "the leading dot is not part of a host");
  assert.equal(cookie.path, "/reader");
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.expires, now + 3_600_000);
});

test("a cookie with no Domain belongs to exactly the host that set it", () => {
  const hostOnly = parseSetCookie("sid=1", "reader.toonily.com");
  assert.equal(hostOnly?.domain, "reader.toonily.com");
  assert.equal(domainMatches(hostOnly.domain, "reader.toonily.com"), true);
  assert.equal(domainMatches(hostOnly.domain, "cdn.reader.toonily.com"), true, "a subdomain still matches");
  assert.equal(domainMatches(hostOnly.domain, "toonily.com"), false, "the parent does not");
  assert.equal(domainMatches(hostOnly.domain, "notreader.toonily.com"), false, "and neither does a lookalike");
});

test("two sources on two sites never see each other's session", () => {
  const cookies = [
    ...parseCookieHeader("sid=one", "toonily.com"),
    ...parseCookieHeader("sid=two", "coolmic.com"),
  ];
  assert.equal(cookieHeader(cookies, "toonily.com"), "sid=one");
  assert.equal(cookieHeader(cookies, "coolmic.com"), "sid=two");
  assert.equal(cookieHeader(cookies, "comix.to"), undefined);
});

test("an expired cookie is not sent, and Max-Age=0 deletes the row", () => {
  const now = 1_000_000;
  const live = parseSetCookie("keep=1; Max-Age=60", "a.test", now);
  const dying = parseSetCookie("gone=1; Max-Age=0", "a.test", now);
  assert.ok(live && dying);
  const after = mergeCookies([live, { ...live, name: "gone", value: "old" }], [dying], now);
  assert.deepEqual(
    after.map((cookie) => cookie.name),
    ["keep"],
    "the logout cookie removed the stored one instead of replacing it",
  );
  assert.equal(cookieHeader([{ ...live, expires: now - 1 }], "a.test", now), undefined);
});

test("the same cookie twice replaces, and the key is host+path+name", () => {
  const first = parseSetCookie("sid=old; Path=/", "a.test");
  const second = parseSetCookie("sid=new; Path=/", "a.test");
  const merged = mergeCookies([first], [second]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].value, "new");
  assert.equal(cookieKey(merged[0]), "a.test\t/\tsid");
});

test("a base url yields its host, and nonsense yields none", () => {
  assert.equal(hostOf("https://toonily.com/manga/x?y=1"), "toonily.com");
  assert.equal(hostOf("toonily.com"), "toonily.com");
  assert.equal(hostOf("http://127.0.0.1:8792/site/html/"), "127.0.0.1");
  assert.equal(hostOf(""), null);
});

// ---------------------------------------------------------------- the seam

test("the browser build reports that it cannot open a webview, and says why", async () => {
  const outcome = await loginInWebview({ url: "https://toonily.com/", hosts: ["toonily.com"] }, webviewDriver("browser"));
  assert.equal(outcome.status, "unsupported");
  assert.match(outcome.reason, /packaged app/);
  assert.equal(outcome.platform, "browser");
});

test("a cancelled page writes nothing and is not an error", async () => {
  const outcome = await loginInWebview(
    { url: "https://toonily.com/", hosts: ["toonily.com"] },
    fakeWebview({ cancel: true }),
  );
  assert.equal(outcome.status, "cancelled");
  assert.equal("cookies" in outcome, false);
});

test("cookies scoped outside the login's hosts are dropped", async () => {
  const driver = {
    platform: "tauri",
    async open() {
      return { setCookie: ["ours=1; Path=/", "theirs=1; Domain=elsewhere.test; Path=/"], url: "https://toonily.com/login" };
    },
  };
  const outcome = await loginInWebview({ url: "https://toonily.com/login", hosts: ["toonily.com"] }, driver);
  assert.equal(outcome.status, "ok");
  assert.deepEqual(
    outcome.cookies.map((cookie) => cookie.name),
    ["ours"],
    "a third-party cookie must not land in this source's jar",
  );
});

// ---------------------------------------------------------------- the hand-off

test("a WebView login source: 401, log in, and the same call answers", async () => {
  await withMock(async (mock) => {
    const { client, extensions, jar, provider } = wire(mock);
    const sourceId = `dalvik:src:${SOURCE_IDS.login}`;

    // 1. The source refuses, and names the page to open.
    await assert.rejects(provider.popular(sourceId, 1), (error) => {
      assert.ok(needsLogin(error), "a 401 must be recognisable as a login, not a string to match");
      assert.equal(error.loginUrl, `/login?source=${SOURCE_IDS.login}`);
      return true;
    });

    // 2. The webview opens that page; the fixture sets its login cookie.
    const driver = fakeWebview();
    const result = await loginSource(
      { sourceId: SOURCE_IDS.login, baseUrl: mock.sources().find((s) => s.id === SOURCE_IDS.login).baseUrl, loginUrl: `/login?source=${SOURCE_IDS.login}` },
      { client, extensions, jar, driver },
    );
    assert.equal(result.status, "ok", `expected a verified login, got ${JSON.stringify(result)}`);
    assert.equal(result.cookies, 1);
    assert.equal(driver.opened.length, 1);
    assert.equal(driver.opened[0].url, `${mock.baseUrl}/login?source=${SOURCE_IDS.login}`);

    // 3. The very call that was refused now answers, through the shipped provider.
    const page = await provider.popular(sourceId, 1);
    assert.ok(page.items.length > 0, "the authenticated listing came back");

    // 4. And the runtime saw the cookie as a request header, not in the body.
    const calls = mock.state.calls;
    const withCookie = calls.filter((call) => String(call.headers?.cookie ?? "").includes(`${LOGIN_COOKIE.name}=${LOGIN_COOKIE.value}`));
    assert.ok(withCookie.length > 0, "the Cookie header reached the host");
    assert.equal(withCookie.at(-1).headers["x-hardlytracking-cookies"], withCookie.at(-1).headers.cookie, "both spellings carry one value");
  });
});

test("a cookie source: the host's Set-Cookie is kept and replayed on the next call", async () => {
  await withMock(async (mock) => {
    const { jar, provider } = wire(mock);
    const sourceId = `dalvik:src:${SOURCE_IDS.cookie}`;

    // First call: the host sets its session cookie and answers normally.
    const first = await provider.popular(sourceId, 1);
    assert.ok(first.items.length > 0);
    const host = hostOf(mock.sources().find((s) => s.id === SOURCE_IDS.cookie).baseUrl);
    assert.equal(await jar.header(host), `${SESSION_COOKIE.name}=${SESSION_COOKIE.value}`, "Set-Cookie was stored");

    // Second call: without the cookie the fixture answers 403, so this passing is the replay.
    const second = await provider.popular(sourceId, 1);
    assert.ok(second.items.length > 0);
  });
});

test("a restart keeps the session: a new client and provider over the same jar still answer", async () => {
  await withMock(async (mock) => {
    const jar = memoryCookieJar();
    const before = wire(mock, jar);
    const sourceId = `dalvik:src:${SOURCE_IDS.cookie}`;
    await before.provider.popular(sourceId, 1);

    // A new process: new client, new provider, same stored cookies. The runtime's own jar is gone.
    const after = wire(mock, jar);
    const page = await after.provider.popular(sourceId, 1);
    assert.ok(page.items.length > 0, "the stored cookie is what made the second process work");
  });
});

test("a login that does not take is reported, not swallowed, and keeps its cookies", async () => {
  await withMock(async (mock) => {
    const { client, extensions, jar } = wire(mock);
    // A webview that sets a cookie for the right host but not the one the source wants.
    const driver = {
      platform: "tauri",
      async open(page) {
        return { setCookie: ["wrong=1; Path=/"], url: page.url };
      },
    };
    const result = await loginSource(
      { sourceId: SOURCE_IDS.login, baseUrl: mock.sources().find((s) => s.id === SOURCE_IDS.login).baseUrl },
      { client, extensions, jar, driver },
    );
    assert.equal(result.status, "rejected");
    assert.equal(result.cookies, 1, "the cookie is kept: the next attempt needs it");
    assert.match(result.reason, /login required/);
  });
});

test("the login page is the one the source named, resolved against its site", () => {
  const target = { sourceId: "1", baseUrl: "https://toonily.com/" };
  assert.equal(loginUrlFor({ ...target, loginUrl: "/login?source=1" }), "https://toonily.com/login?source=1");
  assert.equal(loginUrlFor({ ...target, loginUrl: "https://auth.toonily.com/" }), "https://auth.toonily.com/");
  assert.equal(loginUrlFor({ ...target, loginUrl: null }), "https://toonily.com/", "no guess at /login");
});

test("the runtime's own cookie contract: the headers it reads, and only those", () => {
  const headers = authHeaders({ cookie: "a=1; b=2", userAgent: " UA/1 ", sourceBaseUrl: "https://toonily.com/", webviewPort: 4567 });
  assert.equal(headers.cookie, "a=1; b=2");
  assert.equal(headers["x-hardlytracking-cookies"], "a=1; b=2");
  assert.equal(headers["user-agent"], "UA/1");
  assert.equal(headers["x-hardlytracking-user-agent"], "UA/1", "a tab cannot set User-Agent, so the UA rides this header too");
  assert.equal(headers["source-base-url"], "https://toonily.com/");
  assert.equal(headers["x-mangayomi-webview-port"], "4567");
  assert.deepEqual(authHeaders(undefined), {});
  assert.deepEqual(authHeaders({ cookie: "", userAgent: "  " }), {}, "empty values are absent headers, not empty ones");
});

test("the database jar keeps a cookie across a reopen, and clearing it logs out", async () => {
  const { memoryDatabase } = await import("../../src/lib/db/open.ts");
  const { dbCookieJar } = await import("../../src/lib/webview/store.ts");
  const database = memoryDatabase();
  const first = dbCookieJar(database);
  await first.remember("toonily.com", ["sid=abc; Path=/; Max-Age=3600"]);
  assert.equal(await first.header("toonily.com"), "sid=abc");

  // A new process over the same database: this is matrix row HTTP-07, without waiting for a restart.
  const second = dbCookieJar(database);
  assert.equal(await second.header("toonily.com"), "sid=abc", "the row is in the database, not in memory");
  assert.equal(await second.header("coolmic.com"), undefined, "and it does not leak to another source's site");

  // WEB-05: a logout is a clear, and the source is unauthenticated afterwards.
  await second.clear("toonily.com");
  assert.equal(await second.header("toonily.com"), undefined);
});

// ---------------------------------------------------------------- the other direction

test("the runtime's challenge route: it asks, we open the page, it gets cookies back", async () => {
  const driver = {
    platform: "capacitor",
    opened: [],
    async open(page) {
      driver.opened.push(page);
      return { setCookie: ["cf_clearance=ok; Path=/; Domain=comix.to"], url: page.url };
    },
  };
  const answer = await handleBridgeRequest(
    BRIDGE_WEBVIEW_PATH,
    JSON.stringify({ url: "https://comix.to/challenge", headers: { "user-agent": "X" }, time: 10 }),
    driver,
  );
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { cookies: ["cf_clearance=ok; Path=/; Domain=comix.to"] });
  assert.equal(driver.opened[0].url, "https://comix.to/challenge");
});

test("a cancelled challenge answers no cookies rather than an error", async () => {
  const answer = await handleBridgeRequest(BRIDGE_WEBVIEW_PATH, JSON.stringify({ url: "https://comix.to/" }), {
    platform: "capacitor",
    async open() {
      return null;
    },
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { cookies: [] });
});

test("the JS route answers a result, or says the shell cannot evaluate", async () => {
  const scriptable = {
    platform: "capacitor",
    async open() {
      return { setCookie: [] };
    },
    async evaluate(page, seconds) {
      return `${page.scripts.length} script(s) in ${seconds}s`;
    },
  };
  const ok = await handleBridgeRequest(BRIDGE_JAVASCRIPT_PATH, JSON.stringify({ url: "https://comix.to/", scripts: ["1+1"], time: 5 }), scriptable);
  assert.deepEqual(ok.body, { result: "1 script(s) in 5s" });

  const plain = { platform: "tauri", async open() { return null; } };
  const refused = await handleBridgeRequest(BRIDGE_JAVASCRIPT_PATH, JSON.stringify({ url: "https://comix.to/", scripts: ["1+1"] }), plain);
  assert.equal(refused.status, 501);
  assert.match(String(refused.body.error), /cannot evaluate scripts/);
});

test("the bridge refuses what it cannot act on", async () => {
  const driver = { platform: "capacitor", async open() { return { setCookie: [] }; } };
  assert.equal((await handleBridgeRequest("/nope", "{}", driver)).status, 404);
  assert.equal((await handleBridgeRequest(BRIDGE_WEBVIEW_PATH, "not json", driver)).status, 400);
  assert.equal((await handleBridgeRequest(BRIDGE_WEBVIEW_PATH, JSON.stringify({ url: "data:text/html,hi" }), driver)).status, 400);
});

// ---------------------------------------------------------------- errors stay errors

test("a 401 from the host is a DalvikError with the login page on it", async () => {
  await withMock(async (mock) => {
    const { provider } = wire(mock);
    await assert.rejects(provider.popular(`dalvik:src:${SOURCE_IDS.login}`, 1), (error) => {
      assert.ok(error instanceof DalvikError);
      assert.equal(error.status, 401);
      assert.equal(error.needsLogin, true);
      return true;
    });
  });
});

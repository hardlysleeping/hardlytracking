/**
 * A controlled M-Extension-Server, for tests.
 *
 * The app's dalvik transport has one real host (a Java runtime on a loopback port) and no way
 * to make it misbehave on demand: a source that wants a `Referer`, a source behind a WebView
 * login, a host that answers 500 or never answers at all. Those are exactly the cases that
 * break a reader, and none of them can be reproduced against the live runtime. This file is
 * that host, faked: same routes, same body shapes, same error codes, one process, no deps.
 *
 * It is deliberately *not* a Mihon implementation. It does not parse HTML, it does not run
 * extension bytecode, and it has no cookie store of its own beyond what a test hands back —
 * see `docs/fixtures.md` for what is out of scope and why.
 *
 * Behaviour is driven three ways, all at once:
 *
 *   1. **The config object** (`createDalvikMock({ delays, fail, maxPage, … })`).
 *   2. **The base-url scenario prefix** — `…/s/slow` makes `${base}/s/slow/dalvik` slow, so two
 *      tests can run against one server without a mutable global. `…/dalvik` uses the default.
 *   3. **Query parameters** on the routes a test calls directly: `?delay=`, `?fail=`, `?update=1`.
 *
 * The routes are the ones `src/api/dalvik.ts` actually uses:
 *
 *   GET  /capabilities            → { mangayomiMihonBridge, imageProxy, … }
 *   POST /dalvik                  → the one call surface (install included: APK bytes in `data`)
 *   GET  /image/<encoded>?headers=→ image bytes, with the headers the page declared
 *   POST /stop                    → { stopped: true }
 *
 * plus what the app needs around it: `/site/<source>/…` (a source's own site, so a *relative*
 * image URL has somewhere real to resolve to), `/login` (the WebView login the runtime would
 * show) and `/repo/…` (the static repository in `fixtures/repo/`).
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";

/** The static repository this file serves, and the dummy APK install-from-index is tested with. */
export const REPO_DIR = fileURLToPath(new URL("../../fixtures/repo/", import.meta.url));
export const APK_FILE = "fixture.demo-v1.0.0.apk";

/** What the index calls this extension. One extension, four sources — one APK per package. */
export const PACKAGE_NAME = "fixture.demo";
export const EXTENSION_NAME = "Fixture Demo";
export const VERSION_NAME = "1.0.0";
export const VERSION_CODE = 100;

/**
 * The four sources, and the one trait each of them exists to exercise.
 *
 * `html` is the source that behaves like a real scraped site: relative image paths that only
 * mean something against its own base url, and images that 403 without a `Referer`. `json` is
 * the well-behaved API source: absolute `/image/…` paths on the host's own proxy. `login` is
 * behind a WebView login (401 + a login url until a cookie is present) and `cookie` needs a
 * session cookie the host sets on the first call.
 */
export const SOURCE_IDS = {
  html: "1000000000000000001",
  json: "1000000000000000002",
  login: "1000000000000000003",
  cookie: "1000000000000000004",
};

const TRAITS = [
  {
    key: "html",
    id: SOURCE_IDS.html,
    name: "Fixture HTML",
    lang: "en",
    kind: "html",
    // Every image this source mints is a bare relative path, and these are the headers its
    // site demands back — a Referer, because that is what the real offenders check.
    pageHeaders: { referer: "https://fixture.example/", "user-agent": "HardlyTracking/fixture" },
    responseHeaders: { "x-fixture-source": "html" },
  },
  {
    key: "json",
    id: SOURCE_IDS.json,
    name: "Fixture JSON",
    lang: "en",
    kind: "json",
    // The API source still has one image that wants a Referer, through the host's own proxy.
    pageHeaders: { referer: "https://fixture.example/api/" },
    responseHeaders: { "x-fixture-source": "json" },
  },
  {
    key: "login",
    id: SOURCE_IDS.login,
    name: "Fixture Login",
    lang: "en",
    kind: "html",
    pageHeaders: null,
    requiresLogin: true,
    responseHeaders: { "x-fixture-source": "login" },
  },
  {
    key: "cookie",
    id: SOURCE_IDS.cookie,
    name: "Fixture Cookie",
    lang: "en",
    kind: "json",
    pageHeaders: null,
    requiresCookie: true,
    responseHeaders: { "x-fixture-source": "cookie" },
  },
];

/** The two cookies the fixture sets. Values are fixed so a test can assert the round trip. */
export const SESSION_COOKIE = { name: "fixture_session", value: "s3ss10n" };
export const LOGIN_COOKIE = { name: "fixture_login", value: "logged-in" };

/** A 1×1 PNG: enough to be an honest `image/png` with real bytes. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/**
 * Named scenarios. `slow`, `fail-*` and `update` exist so a test can say what it is testing in
 * the base url instead of reaching into the server; `no-bridge` is the host that is there but
 * cannot serve extensions, which the client must refuse to register.
 */
const SCENARIOS = {
  default: {},
  slow: { delays: { getPageList: 1500, getPopularManga: 1500 } },
  "fail-500": { fail: { getPopularManga: "500", getPageList: "500" } },
  "fail-malformed": { fail: { getPopularManga: "malformed" } },
  "fail-empty": { fail: { getPopularManga: "empty" } },
  "fail-timeout": { fail: { getPageList: "timeout" } },
  login: { requireLogin: true },
  cookie: { requireCookie: true },
  update: { repoUpdate: true },
  "no-bridge": { bridge: false },
};

const DEFAULTS = {
  /** Rows per page; three pages by default, so `hasNextPage` has somewhere to go. */
  perPage: 4,
  maxPage: 3,
  delays: {},
  fail: {},
  bridge: true,
  repoUpdate: false,
  requireLogin: false,
  requireCookie: false,
  /** The login url the host hands back on a 401. The runtime shows it in a WebView. */
  loginPath: "/login",
};

/** One handle, one server, one port. `listen()` is explicit so the port can be ephemeral. */
export function createDalvikMock(options = {}) {
  const state = {
    calls: [],
    images: [],
    site: [],
    logins: [],
    repo: [],
    installs: [],
    /** Image path → the headers its page declared; the image route enforces them. */
    requirements: new Map(),
    /** Source ids whose session cookie has been handed out once. */
    cookiesIssued: new Set(),
    scenario: options.scenario ?? "default",
    extensionId: null,
    apkBytes: null,
    closed: false,
  };
  const timers = new Set();
  const sockets = new Set();
  let baseUrl = "";
  let server;

  /** A source as `/dalvik` reports it, with the base url it only knows once the port exists. */
  function sourceOf(trait) {
    return { id: trait.id, name: trait.name, lang: trait.lang, baseUrl: `${baseUrl}/site/${trait.key}/` };
  }

  function traitFor(sourceId) {
    return TRAITS.find((trait) => trait.id === sourceId);
  }

  function settingsFor(scenarioName, url) {
    const scenario = SCENARIOS[scenarioName] ?? {};
    const settings = { ...DEFAULTS, ...options, ...scenario };
    // Query overrides, so a test can make one call slow or broken without another server.
    const delay = url.searchParams.get("delay");
    if (delay !== null) settings.delays = { ...settings.delays, "*": Number(delay) };
    const fail = url.searchParams.get("fail");
    if (fail !== null) settings.fail = { ...settings.fail, "*": fail };
    if (url.searchParams.get("update") === "1") settings.repoUpdate = true;
    return settings;
  }

  function delayFor(settings, method) {
    const specific = settings.delays[method];
    const any = settings.delays["*"];
    return Number(specific ?? any ?? 0);
  }

  function failureFor(settings, method) {
    return settings.fail[method] ?? settings.fail["*"] ?? null;
  }

  async function sleep(ms) {
    if (ms <= 0) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });
  }

  function sendJson(res, status, body, headers = {}) {
    if (state.closed || res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(body));
  }

  /** Not JSON at all — the case a client must reject rather than parse into an empty list. */
  function sendText(res, status, text, headers = {}) {
    if (state.closed || res.writableEnded) return;
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
    res.end(text);
  }

  function sendBytes(res, status, bytes, headers = {}) {
    if (state.closed || res.writableEnded) return;
    res.writeHead(status, { "content-length": String(bytes.length), ...headers });
    res.end(bytes);
  }

  /** A PNG that differs per path, so a test can tell two images apart by their bytes. */
  function imageBytes(path) {
    return Buffer.concat([PNG, Buffer.from(`fixture:${path}`)]);
  }

  /** Remember what a minted image needs, so the image route can refuse a bare request. */
  function requireHeaders(path, headers) {
    if (headers !== null && headers !== undefined && Object.keys(headers).length > 0) {
      state.requirements.set(path, headers);
    }
  }

  function cookiesOf(request) {
    const jar = new Map();
    for (const part of String(request.headers.cookie ?? "").split(";")) {
      const at = part.indexOf("=");
      if (at > 0) jar.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
    return jar;
  }

  // ---------------------------------------------------------------- the fake extension's data

  function mangaFor(trait, n, settings) {
    const url = trait.kind === "html" ? `/manga/fixture-${n}` : `/api/v1/manga/${n}`;
    // The html source mints bare relative covers (`covers/3.png`); the json source mints the
    // host's own proxy path (`/image/cover-3`). Both are real shapes; only one needs a base url.
    const cover = trait.kind === "html" ? `covers/${n}.png` : `/image/cover-${n}`;
    requireHeaders(coverPath(trait, cover), trait.pageHeaders);
    return {
      url,
      title: `Fixture Title ${n}`,
      artist: "Fixture Artist",
      author: "Fixture Author",
      description: `Fixture description for ${n}.`,
      genre: "Action, Slice of Life",
      status: 1,
      thumbnail_url: cover,
      initialized: true,
    };
  }

  /** The path the image route will actually see for a minted address. */
  function coverPath(trait, cover) {
    return cover.startsWith("/") ? cover : `/site/${trait.key}/${cover}`;
  }

  function pagePath(trait, chapterUrl, index) {
    return trait.kind === "html" ? `pages/${chapterUrl.split("/").pop()}-${index + 1}.png` : `/image/page-${chapterUrl.split("/").pop()}-${index + 1}`;
  }

  function pagesFor(trait, chapterUrl) {
    const count = 3;
    return Array.from({ length: count }, (_, index) => {
      const imageUrl = pagePath(trait, chapterUrl, index);
      const headers = index === 1 ? trait.pageHeaders : null;
      requireHeaders(imageUrl.startsWith("/") ? imageUrl : `/site/${trait.key}/${imageUrl}`, headers);
      return {
        index,
        // The bridge memo a real host mints: host, api url, timestamp. Never an image address.
        url: `${baseUrl},${baseUrl}/api/v1/page,1700000000${index}`,
        imageUrl,
        headers,
      };
    });
  }

  function chaptersFor() {
    return [
      { url: "/chapter/fixture-1", name: "Ch.1", date_upload: 1_700_000_000_000, chapter_number: 1, scanlator: null },
      { url: "/chapter/fixture-2", name: "Ch.2", date_upload: 1_700_100_000_000, chapter_number: 2, scanlator: "Fixture Scan" },
      // `-1` is the runtime's "could not parse a number", and it is the case that sorts wrongly
      // if it is taken literally.
      { url: "/chapter/fixture-special", name: "Special", date_upload: 0, chapter_number: -1, scanlator: null },
    ];
  }

  function listPage(trait, page, settings, search) {
    // Past the last page the host answers with nothing and says so — the shape a client must
    // read as "end of list" rather than as a broken source.
    if (page > settings.maxPage) return { mangas: [], hasNextPage: false };
    const start = (page - 1) * settings.perPage;
    const mangas = [];
    for (let i = 0; i < settings.perPage; i += 1) {
      const n = start + i + 1;
      const manga = mangaFor(trait, n, settings);
      if (search !== undefined && search !== "" && !manga.title.toLowerCase().includes(search.toLowerCase())) continue;
      mangas.push(manga);
    }
    return { mangas, hasNextPage: page < settings.maxPage };
  }

  // ------------------------------------------------------------------------------- the routes

  async function handleCapabilities(res, settings) {
    await sleep(delayFor(settings, "capabilities"));
    const failure = failureFor(settings, "capabilities");
    if (failure === "500") return sendJson(res, 500, { error: "fixture: capabilities exploded", code: 500 });
    if (failure === "malformed") return sendText(res, 200, "<html>not json</html>");
    if (settings.bridge === false) {
      // A host that answers, and is not one of ours: the client must refuse it.
      return sendJson(res, 200, { imageProxy: true, runtime: "fixture/other-host" });
    }
    return sendJson(res, 200, {
      mangayomiMihonBridge: 1,
      imageProxy: true,
      extensionHandles: true,
      runtime: "fixture-dalvik/1.0",
    });
  }

  async function handleDalvik(req, res, url, settings) {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw === "" ? "{}" : raw);
    } catch {
      return sendJson(res, 400, { error: "fixture: request body is not JSON", code: 400 });
    }
    state.calls.push({ method: body.method, body, headers: req.headers });

    const method = String(body.method ?? "");
    const trait = traitFor(body.sourceId);

    if (body.data !== undefined && method === "sourcesManga") {
      // Install is the same call: the APK arrives as base64 and the id is its SHA-256.
      const bytes = Buffer.from(String(body.data), "base64");
      const extensionId = createHash("sha256").update(bytes).digest("hex");
      state.extensionId = extensionId;
      state.installs.push({ bytes: bytes.length, extensionId });
      return sendJson(res, 200, TRAITS.map(sourceOf), { "x-mangayomi-extension-id": extensionId });
    }

    if (method !== "sourcesManga" && method !== "supportLatestManga" && method !== "filtersManga") {
      if (body.extensionId !== undefined && body.extensionId !== state.extensionId) {
        // What the real host answers when its handle is gone: the client must resend the APK.
        return sendJson(res, 409, { error: "Extension handle gone; resend the APK", code: 409 });
      }
    }

    const sourceMethods = new Set([
      "getPopularManga",
      "getLatestManga",
      "getSearchManga",
      "getDetailsManga",
      "getChapterList",
      "getPageList",
      "headersManga",
      "preferencesManga",
    ]);
    if (sourceMethods.has(method) && trait === undefined) {
      return sendJson(res, 500, { error: `Unknown source: ${String(body.sourceId)}`, code: 500 });
    }

    const headers = trait?.responseHeaders ?? {};
    const extraHeaders = {};

    if (trait !== undefined) {
      // A WebView-login source answers 401 and a login url until the login cookie is there.
      if ((trait.requiresLogin === true || settings.requireLogin === true) && cookiesOf(req).get(LOGIN_COOKIE.name) !== LOGIN_COOKIE.value) {
        return sendJson(
          res,
          401,
          { error: "login required", code: 401, loginUrl: `${settings.loginPath}?source=${trait.id}` },
          headers,
        );
      }
      // A session cookie: handed out once, then required back on every call.
      if (trait.requiresCookie === true || settings.requireCookie === true) {
        const has = cookiesOf(req).get(SESSION_COOKIE.name) === SESSION_COOKIE.value;
        if (has) {
          // Round trip complete: nothing special, the call proceeds like any other.
        } else if (state.cookiesIssued.has(trait.id)) {
          return sendJson(res, 403, { error: "missing session cookie", code: 403 }, headers);
        } else {
          // First call: the host sets the session cookie and answers normally. Every later call
          // without it is a 403, which is what a client with no cookie store hits.
          state.cookiesIssued.add(trait.id);
          extraHeaders["set-cookie"] = `${SESSION_COOKIE.name}=${SESSION_COOKIE.value}; Path=/; HttpOnly`;
        }
      }
    }

    const failure = failureFor(settings, method);
    if (failure === "timeout") {
      // Hold the request open, forever. A client without a timeout hangs here; that is the point.
      return;
    }
    await sleep(delayFor(settings, method));

    if (failure === "500") return sendJson(res, 500, { error: `fixture: ${method} exploded`, code: 500 }, headers);
    if (failure === "malformed") return sendText(res, 200, "<html>not json</html>", headers);
    if (failure === "empty") {
      const empty = method === "getChapterList" || method === "getPageList" ? [] : { mangas: [], hasNextPage: false };
      return sendJson(res, 200, empty, { ...headers, ...extraHeaders });
    }

    if (!KNOWN_METHODS.has(method)) {
      return sendJson(res, 500, { error: `Unknown method: ${method}`, code: 500 }, headers);
    }

    return sendJson(res, 200, respondTo(method, body, trait, settings), { ...headers, ...extraHeaders });
  }

  /** The body for a method the fixture implements. `trait` is present for source methods. */
  function respondTo(method, body, trait, settings) {
    const page = Number(body.page ?? 1);
    switch (method) {
      case "sourcesManga":
        return TRAITS.map(sourceOf);
      case "supportLatestManga":
        return true;
      case "filtersManga":
        return [];
      case "preferencesManga":
        return [];
      case "headersManga":
        return trait.pageHeaders ?? {};
      case "getPopularManga":
      case "getLatestManga":
        return listPage(trait, page, settings);
      case "getSearchManga":
        return listPage(trait, page, settings, String(body.search ?? ""));
      case "getDetailsManga": {
        const url = String(body.mangaData?.url ?? "");
        const n = Number(url.split("-").pop() ?? 1) || 1;
        return { ...mangaFor(trait, n, settings), initialized: true };
      }
      case "getChapterList":
        return chaptersFor();
      case "getPageList":
        return pagesFor(trait, String(body.chapterData?.url ?? "/chapter/fixture-1"));
      default:
        return null;
    }
  }

  /**
   * The host's own image proxy: `GET /image/<encoded url>?headers=<base64 json>`.
   *
   * A page's headers arrive either in the query (what the app's `/api/img?h=` proxy does) or as
   * real request headers (what a client that can set them does). Both are accepted; a page whose
   * image declared headers gets a 403 without them, which is the case worth testing.
   */
  async function handleImage(req, res, routePath, search, settings) {
    const path = decodeURIComponent(routePath.replace(/^\/image\//, ""));
    const queryHeaders = decodeHeaders(search.get("headers") ?? search.get("h"));
    const headers = { ...req.headers, ...queryHeaders };
    const required = state.requirements.get(`/image/${path}`) ?? state.requirements.get(path) ?? null;
    const missing = required === null ? [] : Object.keys(required).filter((name) => headers[name.toLowerCase()] === undefined);
    state.images.push({ path, headers: { ...headers }, missing, via: queryHeaders === null ? "request" : "query" });
    await sleep(delayFor(settings, "image"));
    if (missing.length > 0) {
      return sendJson(res, 403, { error: `image needs ${missing.join(", ")}`, code: 403 });
    }
    return sendBytes(res, 200, imageBytes(path), { "content-type": "image/png", "cache-control": "public, max-age=86400" });
  }

  /** A source's own site: where a bare relative image path resolves to, and nothing else. */
  async function handleSite(req, res, routePath, settings) {
    const path = routePath;
    const required = state.requirements.get(path) ?? null;
    const headers = req.headers;
    const missing = required === null ? [] : Object.keys(required).filter((name) => headers[name.toLowerCase()] === undefined);
    state.site.push({ path, headers: { ...headers }, missing });
    await sleep(delayFor(settings, "image"));
    if (missing.length > 0) {
      return sendJson(res, 403, { error: `image needs ${missing.join(", ")}`, code: 403 });
    }
    return sendBytes(res, 200, imageBytes(path), { "content-type": "image/png" });
  }

  /** The WebView login the runtime would open: it sets the cookie and answers with a page. */
  function handleLogin(req, res, search) {
    const sourceId = search.get("source") ?? SOURCE_IDS.login;
    state.logins.push({ sourceId, at: Date.now() });
    if (state.closed) return;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": `${LOGIN_COOKIE.name}=${LOGIN_COOKIE.value}; Path=/; HttpOnly`,
    });
    res.end(`<html><body>fixture login ok for ${sourceId}</body></html>`);
  }

  /**
   * The static repository in `fixtures/repo/`.
   *
   * The index is served as it sits on disk except for one thing: a relative `apkUrl`/`apk` is
   * rewritten to this server's own `/repo/` path, because the real indexes name the APK
   * relatively and a test cannot guess the port. `?update=1` (or the `update` scenario) bumps the
   * version, which is the "an update is available" case.
   */
  async function handleRepo(res, routePath, settings) {
    const name = basename(routePath.replace(/^\/repo\//, ""));
    state.repo.push({ name, update: settings.repoUpdate === true });
    if (name.endsWith(".apk")) {
      try {
        const bytes = await readFile(`${REPO_DIR}${name}`);
        return sendBytes(res, 200, bytes, { "content-type": "application/vnd.android.package-archive" });
      } catch {
        return sendJson(res, 404, { error: `no such fixture apk: ${name}`, code: 404 });
      }
    }
    if (name !== "index.json" && name !== "index.min.json") {
      // No protobuf index here, on purpose: the app's `.pb` fallback must be seen to fail.
      return sendJson(res, 404, { error: `no such fixture file: ${name}`, code: 404 });
    }
    let text;
    try {
      text = await readFile(`${REPO_DIR}${name}`, "utf8");
    } catch {
      return sendJson(res, 404, { error: `no such fixture file: ${name}`, code: 404 });
    }
    const parsed = JSON.parse(text);
    const absolute = (apk) => (/^https?:/i.test(apk) ? apk : `${baseUrl}/repo/${basename(apk)}`);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        entry.apk = absolute(String(entry.apk));
        if (settings.repoUpdate === true) {
          entry.code = Number(entry.code) + 1;
          entry.version = `${String(entry.version).replace(/-fixture.*$/, "")}-fixture-update`;
        }
      }
    } else {
      const extensions = parsed?.extensionList?.extensions;
      if (Array.isArray(extensions)) {
        for (const entry of extensions) {
          if (typeof entry?.resources?.apkUrl === "string") entry.resources.apkUrl = absolute(entry.resources.apkUrl);
          if (settings.repoUpdate === true) {
            entry.versionCode = String(Number(entry.versionCode) + 1);
            entry.versionName = `${String(entry.versionName)}-fixture-update`;
          }
        }
      }
    }
    return sendJson(res, 200, parsed);
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://fixture");
    const match = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const scenario = match === null ? state.scenario : match[1];
    const path = match === null ? url.pathname : match[2] ?? "/";
    const settings = settingsFor(scenario, url);

    if (req.method === "GET" && path === "/capabilities") return handleCapabilities(res, settings);
    if (req.method === "POST" && path === "/dalvik") return handleDalvik(req, res, url, settings);
    if (req.method === "GET" && path.startsWith("/image/")) return handleImage(req, res, path, url.searchParams, settings);
    if (req.method === "GET" && path.startsWith("/site/")) return handleSite(req, res, path, settings);
    if (req.method === "GET" && path === "/login") return handleLogin(req, res, url.searchParams);
    if (req.method === "POST" && path === "/stop") return sendJson(res, 200, { stopped: true });
    if (req.method === "GET" && path.startsWith("/repo/")) return handleRepo(res, path, settings);
    if (req.method === "GET" && path === "/__state") {
      return sendJson(res, 200, {
        scenario,
        extensionId: state.extensionId,
        calls: state.calls.map((call) => ({ method: call.method, body: call.body })),
        images: state.images,
        site: state.site,
        logins: state.logins,
        repo: state.repo,
        installs: state.installs,
        requirements: [...state.requirements.entries()],
      });
    }
    if (req.method === "POST" && path === "/__reset") {
      state.calls.length = 0;
      state.images.length = 0;
      state.site.length = 0;
      state.logins.length = 0;
      state.repo.length = 0;
      state.installs.length = 0;
      state.cookiesIssued.clear();
      state.scenario = "default";
      return sendJson(res, 200, { reset: true });
    }
    if (req.method === "POST" && path === "/__scenario") {
      state.scenario = url.searchParams.get("name") ?? "default";
      return sendJson(res, 200, { scenario: state.scenario });
    }
    return sendJson(res, 404, { error: `fixture: no route for ${req.method} ${path}`, code: 404 });
  }

  server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { error: `fixture: ${String(error?.message ?? error)}`, code: 500 });
      else res.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const mock = {
    server,
    state,
    get baseUrl() {
      return baseUrl;
    },
    /** The id a client would get from installing the fixture APK: its SHA-256. */
    get extensionId() {
      return state.extensionId;
    },
    /** The sources `/dalvik` reports, with this server's own base urls. */
    sources() {
      return TRAITS.map(sourceOf);
    },
    /** A base url that carries a scenario: `…/s/slow` makes every call under it slow. */
    scenarioUrl(name) {
      return `${baseUrl}/s/${name}`;
    },
    /** Switch the default scenario (for the unprefixed routes). */
    use(name) {
      state.scenario = name;
      return mock;
    },
    async reset() {
      await fetch(`${baseUrl}/__reset`, { method: "POST" });
      return mock;
    },
    async listen() {
      const apk = await readFile(`${REPO_DIR}${APK_FILE}`).catch(() => Buffer.from(""));
      state.apkBytes = apk;
      state.extensionId = createHash("sha256").update(apk).digest("hex");
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      return mock;
    },
    async close() {
      state.closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      // A held-open "timeout" response would otherwise keep the process alive.
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return mock;
}

const KNOWN_METHODS = new Set([
  "sourcesManga",
  "headersManga",
  "filtersManga",
  "supportLatestManga",
  "getPopularManga",
  "getLatestManga",
  "getSearchManga",
  "getDetailsManga",
  "getChapterList",
  "getPageList",
  "preferencesManga",
  "setPreferenceManga",
]);

/** `listen()` in one call: the shape every test wants. */
export async function startDalvikMock(options = {}) {
  const mock = createDalvikMock(options);
  await mock.listen();
  return mock;
}

/**
 * A cookie jar, because `fetch` has none and this fixture is the one host that checks.
 *
 * In the real system the *runtime* holds the session (it is a Java process with its own cookie
 * store) and the app never sees a cookie at all. Here the test plays that part: `DalvikClient`
 * takes a `fetchImpl`, so a jar wrapped around `fetch` is the whole of what the runtime does,
 * and it is the only way to prove the fixture's 403/401 paths are reachable.
 */
export function createCookieJar() {
  const jar = new Map();
  async function fetchWithJar(input, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    if (jar.size > 0) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await fetch(input, { ...init, headers });
    const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const pair = raw.split(";")[0];
      const at = pair.indexOf("=");
      if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
    return response;
  }
  return { fetchImpl: fetchWithJar, jar };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** `?headers=` is base64 (or base64url) of a JSON object; anything else is no headers at all. */
function decodeHeaders(raw) {
  if (raw === null || raw === "") return null;
  try {
    const json = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[name.toLowerCase()] = value;
    }
    return out;
  } catch {
    return null;
  }
}

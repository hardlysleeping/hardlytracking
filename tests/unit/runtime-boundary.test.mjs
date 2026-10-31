/**
 * The compliance test from `docs/app-store-release-checklist.md`:
 *
 *   a downloaded extension reaches no native API
 *
 * The boundary it pins is the one written down in `docs/runtime-boundary.md`: a loaded extension is
 * reachable only through the twelve `/dalvik` methods, its answer crosses as JSON, and the app's
 * native surface (Capacitor plugins, its database, the OS privacy APIs) is not on that path at all.
 *
 * Everything here is either a behaviour (a full provider session against a stub runtime, recording
 * every request it makes) or a source assertion on the files that would have to change for the
 * boundary to break. It reads files, so it fails the day someone adds a sixteenth method or imports
 * a plugin into the provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DalvikClient, createDalvikProvider } from "../../src/api/dalvik.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));

function read(path) {
  return readFileSync(join(repo, path), "utf8");
}

/** The runtime's own method list — `MihonInvoker.kt`'s closed `when`, and the type in `dalvik.ts`. */
const DALVIK_METHODS = [
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
];

/** A stand-in runtime: records every request, answers from a table. */
async function stubRuntime(handlers) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body = null;
      try {
        body = raw === "" ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      seen.push({ method: req.method, url: req.url, host: req.headers.host, body, headers: req.headers });
      const handler = body === null ? undefined : handlers[body.method];
      if (handler === undefined) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `Unknown method: ${body === null ? "?" : body.method}`, code: 500 }));
        return;
      }
      const answer = handler(body);
      res.writeHead(answer.status ?? 200, { "content-type": "application/json", ...(answer.headers ?? {}) });
      res.end(typeof answer.json === "string" ? answer.json : JSON.stringify(answer.json));
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
const manga = { url: "/manga/x", title: "A title", thumbnail_url: "/image/abc", initialized: false };
const chapter = { url: "/chapter/x", name: "Ch.1", chapter_number: 1, date_upload: 1791631124000 };
const page = { index: 0, url: "memo", imageUrl: "/image/p0", headers: null };

const handlers = () => ({
  sourcesManga: () => ({ json: [source], headers: { "x-mangayomi-extension-id": "apk-hash" } }),
  getPopularManga: () => ({ json: { mangas: [manga], hasNextPage: false } }),
  getDetailsManga: () => ({ json: manga }),
  getChapterList: () => ({ json: [chapter] }),
  getPageList: () => ({ json: [page] }),
  preferencesManga: () => ({ json: [] }),
});

// ---------------------------------------------------------------------------------------------------
// The headline case. A whole reading session, every request it makes recorded.
// ---------------------------------------------------------------------------------------------------

test("a downloaded extension reaches no native API", async () => {
  const runtime = await stubRuntime(handlers());
  try {
    const client = new DalvikClient({ baseUrl: runtime.baseUrl });
    const provider = createDalvikProvider({
      client,
      extensions: [{ extensionId: "apk-hash", packageId: "pkg", sources: [source] }],
    });

    // A full pass through the provider: the same calls a browse → series → chapter → reader does.
    const sources = await provider.sources();
    assert.deepEqual(sources.map((s) => s.id), [`dalvik:src:${source.id}`]);
    const popular = await provider.popular(source.id, 1);
    const seriesId = popular.items[0].id;
    await provider.details(seriesId);
    const chapters = await provider.chapters(seriesId);
    await provider.pages(chapters[0].id);

    assert.ok(runtime.seen.length >= 4, "the session really made calls");

    for (const request of runtime.seen) {
      // One address, one verb, one shape: the whole outbound surface of a loaded extension.
      assert.equal(request.method, "POST", `unexpected ${request.method} ${request.url}`);
      assert.equal(request.url, "/dalvik", `the provider reached ${request.url}, which is not the bridge`);
      assert.equal(request.host, new URL(runtime.baseUrl).host, "no third-party host is contacted by the provider");
      assert.ok(request.body !== null && typeof request.body === "object", "the body is JSON, never a stream");
      assert.ok(
        DALVIK_METHODS.includes(request.body.method),
        `${request.body.method} is not one of the twelve /dalvik methods`,
      );
    }

    // The session headers are the four the protocol defines, plus the app's own API token and type.
    // The rest are the HTTP transport's own (undici fills them in), not something the app chooses —
    // listed explicitly so a *new* app header still fails this test.
    const transport = new Set([
      "host",
      "connection",
      "content-type",
      "content-length",
      "accept",
      "accept-encoding",
      "accept-language",
      "sec-fetch-mode",
      "user-agent",
    ]);
    const allowed = new Set([
      ...transport,
      "cookie",
      "source-base-url",
      "x-mangayomi-webview-port",
      "x-hardlytracking-token",
    ]);
    for (const request of runtime.seen) {
      for (const header of Object.keys(request.headers)) {
        assert.ok(allowed.has(header), `${header} is not part of the /dalvik boundary`);
      }
    }
  } finally {
    await runtime.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// The surface itself: twelve methods, a closed union, two fetch sites.
// ---------------------------------------------------------------------------------------------------

test("the method surface is the twelve the runtime dispatches, and cannot be a free string", () => {
  const dalvik = read("src/api/dalvik.ts");

  const start = dalvik.indexOf("export type DalvikMethod =");
  assert.ok(start > 0, "DalvikMethod is gone — the boundary has no name any more");
  const union = dalvik.slice(start, dalvik.indexOf(";", start));
  const declared = [...union.matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(declared, [...DALVIK_METHODS].sort(), "a method was added or removed");

  assert.match(dalvik, /method: DalvikMethod;/, "DalvikCall.method must be the union, not a string");
  assert.doesNotMatch(dalvik, /method\?: string/, "an untyped method is how an unknown verb gets through");

  // The client can only ever talk to the host it was constructed with, on the two routes it knows.
  const fetchSites = [...dalvik.matchAll(/this\.fetchImpl\(/g)].length;
  assert.equal(fetchSites, 2, `expected /capabilities and /dalvik only, found ${fetchSites} fetch sites`);
  assert.match(dalvik, /fetchImpl\(`\$\{this\.baseUrl\}\/capabilities`/);
  assert.match(dalvik, /fetchImpl\(`\$\{this\.baseUrl\}\/dalvik`/);
});

test("the dalvik path imports no native module and no database module", () => {
  // The provider chain: what a call actually touches. A plugin import anywhere here is the bug.
  // `import type` is erased at build and hands the runtime nothing, so it is not a reach.
  const chain = [
    "src/api/dalvik.ts",
    "src/api/registry.ts",
    "src/api/source.ts",
    "src/lib/host.ts",
    "src/lib/webview/cookies.ts",
  ];
  for (const path of chain) {
    for (const specifier of runtimeImports(read(path))) {
      for (const forbidden of ["@capacitor/", "@tauri-apps/", "db/store", "db/open", "db/sqlite"]) {
        assert.ok(!specifier.includes(forbidden), `${path} reaches ${forbidden} at runtime`);
      }
    }
  }

  // A native module is allowed only in the two app-side seams that start the host and open a login
  // webview — never in the code that maps a /dalvik answer.
  const native = ["src/lib/mihon-runtime.ts", "src/lib/webview/index.ts"];
  for (const path of walk("src")) {
    const reaches = runtimeImports(read(path)).some(
      (specifier) => specifier.includes("@capacitor/") || specifier.includes("@tauri-apps/"),
    );
    if (!reaches) continue;
    assert.ok(native.includes(path), `${path} imports a native module outside the two sanctioned seams`);
  }
});

/** Module specifiers a file imports at runtime — `import type` is erased and is not one. */
function runtimeImports(text) {
  const out = [];
  for (const match of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gms)) {
    if (match[1] === undefined) out.push(match[2]);
  }
  return out;
}

test("the one native plugin is four control calls, and the C header exports four functions", () => {
  const plugin = read("plugins/mihon-runtime/ios/Classes/MihonRuntimePlugin.swift");
  const methods = [...plugin.matchAll(/CAPPluginMethod\(name: "([A-Za-z]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(methods, ["pause", "start", "status", "stop"]);

  const header = read("plugins/mihon-runtime/ios/Classes/MihonRuntime.h");
  const exports = [...header.matchAll(/FOUNDATION_EXPORT void (MihonRuntime[A-Za-z]+)\(/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(exports, ["MihonRuntimeIsRunning", "MihonRuntimePause", "MihonRuntimeStart", "MihonRuntimeStop"]);

  // Nothing in the JVM side registers a JNI entry point into the plugin.
  const host = read("plugins/mihon-runtime/ios/Classes/MihonRuntime.mm");
  assert.doesNotMatch(host, /RegisterNatives/, "a registered native method would be a surface the extension can name");
});

test("no privacy plugin or usage description is linked into the shell", () => {
  const pkg = JSON.parse(read("package.json"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const forbidden of ["camera", "photos", "contacts", "geolocation", "push-notifications", "local-notifications"]) {
    assert.ok(!deps.some((name) => name.includes(forbidden)), `a ${forbidden} plugin is a native API in reach`);
  }

  const podfile = read("ios/App/Podfile");
  const pods = [...podfile.matchAll(/^\s*pod '([^']+)'/gm)].map((match) => match[1]).sort();
  // `MihonRuntime` is written into this file by `cap sync` from the local package; the checked-in
  // copy may not carry it yet, so it is an allowed value rather than a required one.
  assert.deepEqual(
    pods.filter((pod) => !["Capacitor", "CapacitorCordova", "MihonRuntime"].includes(pod)),
    [],
    "a pod outside the three this app ships",
  );

  const plist = read("ios/App/App/Info.plist");
  for (const key of ["NSPhotoLibraryUsageDescription", "NSContactsUsageDescription", "NSLocationWhenInUseUsageDescription"]) {
    assert.ok(!plist.includes(key), `${key} means the app declares a privacy API this boundary says is out of reach`);
  }
});

test("extension-supplied text is never evaluated as script", () => {
  for (const path of walk("src")) {
    const text = read(path);
    assert.doesNotMatch(text, /(^|[^.\w])eval\(/, `${path} evaluates a string`);
    assert.doesNotMatch(text, /new Function\(/, `${path} builds a function from a string`);
  }
});

/** Every .ts/.svelte/.mjs file under a directory, repo-relative. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(join(repo, dir))) {
    const relative = `${dir}/${entry}`;
    const stats = statSync(join(repo, relative));
    if (stats.isDirectory()) out.push(...walk(relative));
    else if (/\.(ts|svelte|mjs)$/.test(entry)) out.push(relative);
  }
  return out;
}

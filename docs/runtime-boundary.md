# The runtime boundary — what `/dalvik` is, and what it is not

Checklist item 6 of `docs/app-store-release-checklist.md`, verified rather than rebuilt. Every claim
below names the file and the call that proves it; the compliance test
`tests/unit/runtime-boundary.test.mjs` ("a downloaded extension reaches no native API") pins the ones
that can be pinned statically, and the live probe at the bottom was run against the real host.

The chain, unchanged and not to be rebuilt:

```
APK bytes ──base64──▶ POST /dalvik ──▶ M-Extension-Server (JVM)
                                        ├─ dex2jar + URLClassLoader → the Mihon source instance
                                        └─ MihonInvoker.invokeMethod → one JSON answer
                        ◀── JSON + X-Mangayomi-Extension-Id ──┘
DalvikClient → SourceProvider → views
```

| | Reachable from a loaded extension | Not reachable |
|---|---|---|
| 1 | HTTP, from inside the runtime process, through its own `NetworkHelper` | Capacitor plugins |
| 2 | Its own source's cookies, handed over per call | The app's SQLite / IndexedDB |
| 3 | Its own preference screen and values; in-memory instance state | Photos, Contacts, Location, Notifications |
| 4 | A page rendered by the app's WebView, answered with that page's cookies | The app's DOM, JS objects, downloads, or files |
| 5 | Manga, chapter and page calls — twelve methods, no read state | Installing anything by itself |

---

## What it can reach

### 1. HTTP

**Answer.** Its own HTTP, from inside the runtime process, using its own network stack. The app never
proxies those requests and never sees them; the extension's traffic leaves from the runtime, with the
UA and cookies the runtime was given.

**Proof.** `MihonInvoker.invokeGetPopularManga` / `invokeGetPageList` call the source's own methods
(`server/src/main/kotlin/mextensionserver/impl/MihonInvoker.kt`), and a Mihon `HttpSource` owns its
`NetworkHelper`. `DalvikHandler.serve` reaches into that same object to apply the session:
`network?.setUA(ua)` and `network?.cookieJar?.addAll(httpUrl, cookies)`
(`controller/DalvikHandler.kt:70-115`). The only HTTP the app is asked for is the runtime's *image*
route: `MihonImageProxy` mints `http://127.0.0.1:<port>/image/<token>`, which is why a page's `url` is
a bridge memo and `imageUrl` is the thing to load (`src/api/dalvik.ts:16-25`, `asset()` at `:371`).

Live: `getPopularManga` against the real MangaDex APK answered 200 with a page of titles.

### 2. Its cookies — and only its source's

**Answer.** One direction each way, scoped to the source's own host, on every call:

- app → runtime: a `Cookie:` request header for `hostOf(sourceBaseUrl)`, read from the app's jar;
- runtime → app: whatever `Set-Cookie` the runtime answers with, stored back into the same host's jar.

The runtime's own jar is **memory-only per source instance** and has no read-back route, which is why
the header is re-sent on every call and why the app is the store.

**Proof.** `authHeaders()` (`src/api/dalvik.ts:210-220`) emits exactly four session headers —
`Cookie`, `User-Agent`, `source-base-url`, `x-mangayomi-webview-port`. `authFor()` (`:633`) builds the
cookie from `options.cookies.header(host)`; `cookiesFor()`/`domainMatches()` (`src/lib/webview/cookies.ts:185`)
keep it to live cookies whose domain matches that host. `DalvikHandler.kt:75-115` splits the header on
`;`, builds `okhttp3.Cookie`s on `cleanDomain` and adds them to **that source's** jar. `invoke()`
(`src/api/dalvik.ts:652-690`) remembers `result.setCookie` for that host. `src/lib/webview/store.ts:1-20`
states the no-read-back fact the design rests on.

### 3. Its preferences and its own state

**Answer.** The source's preference screen and values, through two of the twelve methods; plus whatever
the source keeps in its own instance in memory (pagination iterators, caches). Nothing the runtime holds
survives its process — the app is the store and sends the values on every call.

**Proof.** `preferencesManga` / `setPreferenceManga` in the `DalvikMethod` union
(`src/api/dalvik.ts:32-44`) ↔ `invokePreferencesManga` / `invokeSetPreferenceManga`
(`MihonInvoker.kt:1205,1231`). The three wire shapes are one module (`src/lib/extensions/prefs.ts`,
`wirePreferences` at `:154`), stored per source in the app (`store.setSourcePrefs`,
`src/lib/db/store.ts:615`) and merged into the call body by `invoke()`. `ExtensionInstanceCache`
(`impl/ExtensionInstanceCache.kt`) keeps one instance per APK SHA-256 for the server's lifetime and is
the reason the app keeps the APK bytes at all.

### 4. WebView login — the app's WebView, not the extension's

**Answer.** In a packaged build the extension cannot open a browser or a webview of its own. It asks
the app that made the last `/dalvik` call to render a page, and receives that page's cookies (and, for a
challenge wall, the result of a script in it). The login UI, the WKWebView and the cookie store are all
the app's.

**Proof.** The port travels as a header (`src/api/dalvik.ts:220`) and the runtime adopts it:
`KcefWebViewProvider.bridgePort = bridgePort` (`DalvikHandler.kt:38-41`). The runtime then POSTs
`http://127.0.0.1:<port>/bridge_webview` or `/evaluateJavascriptViaWebview`
(`AndroidCompat/.../KcefWebViewProvider.kt:1081`), and the app answers through
`handleBridgeRequest` (`src/lib/webview/bridge.ts:60`), which knows those two routes only and scopes
the cookies to `hostOf(request.url)`. With no listener the header is never sent and the runtime falls
back to its own embedded CEF. The app's own login seam is `webviewDriver()`
(`src/lib/webview/index.ts:134`), whose Capacitor driver opens a `WKWebView` in the app's process and
returns `Set-Cookie` strings.

### 5. Manga, chapter and page calls

**Answer.** Twelve methods, all mapped onto the Mihon source interface. Read state is **not** one of
them: the runtime has no API for it, so the app's database is the writer.

**Proof.** The union (`src/api/dalvik.ts:32-44`) matches `MihonInvoker.kt`'s `when (data.method)`
one-for-one and its `else -> throw IllegalArgumentException("Unknown method: …")`. The provider's
calls are `popular` / `latest` / `search` / `details` / `chapters` / `pages`
(`src/api/dalvik.ts:750-830`); `setRead` refuses by name and `ownsProgress: true` (`:733`, `:844`).

---

## What it cannot reach

### 1. A Capacitor plugin

**Answer.** Nothing. The plugin surface is JavaScript in the webview. The only plugin in this project
with a native half is `MihonRuntimePlugin`, and it exposes **four control methods** — start, status,
pause, stop — over four C entry points. No JNI method registered for the JVM reaches any of them, and
the runtime's answer crosses the boundary as a string (`objectMapper.writeValueAsString(invocation.result)`
in `DalvikHandler.kt`), not as an object graph the app then hands to native code.

**Proof.** `plugins/mihon-runtime/ios/Classes/MihonRuntimePlugin.swift` `pluginMethods` (start / status /
pause / stop); `MihonRuntime.h` exports `MihonRuntimeStart`, `MihonRuntimePause`, `MihonRuntimeStop`,
`MihonRuntimeIsRunning` and nothing else; `src/lib/mihon-runtime.ts:93-113` is the whole JS side of it.
`src/api/dalvik.ts` imports no `@capacitor/*` and no `@tauri-apps/*` — the provider is plain HTTP.

### 2. The app's SQLite / IndexedDB

**Answer.** No handle and no method that names one. The database is opened in the app's JS
(`src/lib/db/open.ts`, 27 stores) and lives in the webview's storage; the runtime process has no path to
it. Two things do cross, both chosen by the app, not queried by the extension: that source's preference
values, and a `Cookie:` header for that source's host — the app reading its own rows.

**Proof.** `STORES` in `src/lib/db/open.ts:12-40`; `preferencesFor()` (`src/api/registry.ts:114`) reads
one source's rows and passes them as a callback; `authFor()` reads one host's cookies. Live: the
protocol refuses every storage-shaped verb — `{"method":"sqlite"}` → `500 Unknown method: sqlite`.

### 3. Photos, Contacts, Location, Notifications

**Answer.** None of them, at two levels: no plugin for any is linked into the shell, and no AndroidCompat
shim reaches the host OS's own services. An extension that calls Android's `NotificationManager` gets the
shim inside the JVM, which is not the app's notification centre.

**Proof.** `package.json` dependencies carry `@capacitor/core`, `@capacitor/ios`, `@capacitor/cli` only —
no camera, photos, contacts, geolocation or notifications plugin. `ios/App/Podfile` lists `Capacitor`,
`CapacitorCordova` and `MihonRuntime` and nothing else. `ios/App/App/Info.plist` has no
`NSPhotoLibraryUsageDescription`, `NSContactsUsageDescription` or location key at all — only
`NSLocalNetworkUsageDescription`.

### 4. The app's DOM, its JavaScript, its downloads

**Answer.** The only inbound direction from the runtime is HTTP: the two WebView-bridge routes above and
`/image/<uuid>` fetches. There is no message channel into the page, no object handed to the runtime, and
extension-supplied bytes are never evaluated as script by the app.

**Proof.** `src/lib/webview/bridge.ts:45-46` is the complete inbound route list;
`server/proxy.mjs:9-10` is the complete proxied route list; a scan of `src/` finds no `eval(` and no
`new Function(` (pinned by the test).

---

## What the boundary is not — the honest limits

1. **There is no per-extension sandbox inside the JVM.** An APK is bytecode, and the loader converts it
   to a JAR and hands it to a `URLClassLoader` (`impl/MExtensionServerLoader.kt:120-190`) — the
   extension runs with the runtime process's own file and socket access. Only dex and assets are taken
   out of the APK; no `.so` is extracted or loaded. The boundary asserted here is **app ↔ extension**,
   not extension ↔ filesystem.
2. **On iOS the JVM is in the app's address space** (OpenJDK Zero, in-process — see
   `docs/ios-embedded-runtime.md`). The isolation is that no native symbol an extension could name
   reaches Capacitor or a privacy API, plus the iOS app sandbox. It is not a VM jail, and the doc should
   not claim one.
3. **AndroidCompat is a shim, not Android.** No UID, no SELinux domain, no permission prompt: a Mihon
   extension that would be blocked on a phone by a runtime permission is blocked here only because the
   service it wants does not exist in the shim.
4. **A WebView request is a request.** An extension can ask the app to render an arbitrary URL and to
   evaluate scripts in that page, and gets that page's cookies back. That is web content in a WKWebView
   with the user's session for that host — not a native API, and not a route to app data.
5. **The same rule binds the next engines.** Aidoku (wasm), Suwatte and Paperback (JS) get their own
   `ProviderKind` and their own limited host, never a native surface and never a shared kind with
   `dalvik`.

## How this was verified

`tests/unit/runtime-boundary.test.mjs`:

```
node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
  tests/unit/runtime-boundary.test.mjs
```

It pins: the twelve-method union and that `DalvikCall.method` cannot be a free string; that a full
session (sources → popular → details → chapters → pages) sends **only** `POST {base}/dalvik` bodies whose
method is on that list, with no header beyond the four session ones; that the dalvik path imports no
native module and no database module; that the one native plugin is four control calls and the Obj-C
header exports four functions; that no privacy plugin or usage description exists; and that no
extension-supplied string is ever `eval`ed.

Live probe, host `ht-dalvik` (M-Extension-Server v1.0.9, Linux x64), real MangaDex APK
sha256 `12fde776…0915fb`:

| call | answer |
|---|---|
| `GET /capabilities` | 200, advertises `mangayomiMihonBridge` … `webviewBridge` |
| `GET /extensions`, `/install`, `/sqlite`, `/photos`, `/contacts`, `/notifications` | 404 (no such routes) |
| `{"method":"sourcesManga","data":"<apk>"}` | 200, 61 sources, `X-Mangayomi-Extension-Id: 12fde776…` |
| `{"method":"getPopularManga",…}` | 200, a page of titles |
| `{"method":"install"}`, `"readFile"`, `"sqlite"`, `"evalJavascript"`, `"contacts"`, `"openUrl"` | `500 {"error":"Unknown method: …"}` |

The runtime's own dispatch (`MihonInvoker.kt:114-132`) is a closed `when` with an `else` that throws, so
the last row is the mechanism, not a missing feature.

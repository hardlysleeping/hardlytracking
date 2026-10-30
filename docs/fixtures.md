# The dalvik fixture: a host that misbehaves on demand

`tests/fixtures/dalvik-mock.mjs` is a fake **M-Extension-Server**, and
`tests/unit/dalvik-fixture.test.mjs` is the contract the dalvik transport has to keep against it.
The live runtime only ever behaves; every case that actually breaks a reader — a source that wants
a `Referer`, a WebView login, an endpoint that answers 500 or never answers — is unreachable
against it. This is that host, in one file, with no dependencies.

```
tests/fixtures/dalvik-mock.mjs      the host (node:http only)
tests/unit/dalvik-fixture.test.mjs  24 contract tests, run by `npm test`
fixtures/repo/                      a static repository: index.json, index.min.json, one dummy APK
```

## What it is

One process, one port (`listen(0)`, so tests never collide), speaking the routes the app uses:

| Route | What it answers |
| --- | --- |
| `GET /capabilities` | `{ mangayomiMihonBridge: 1, imageProxy: true, extensionHandles: true }` |
| `POST /dalvik` | install (`data` = base64 APK → `x-mangayomi-extension-id` = its SHA-256), and every read method |
| `GET /image/<encoded>?headers=` | image bytes, with the headers the page declared |
| `GET /site/<source>/…` | the source's own site, so a *relative* image path has somewhere real to resolve to |
| `GET /login?source=…` | the WebView login: sets the cookie and answers with a page |
| `GET /repo/…` | the static repository in `fixtures/repo/` |
| `POST /stop` | `{ stopped: true }` |

One extension, `fixture.demo`, with four sources — one per trait worth testing:

- **Fixture HTML** (`1000000000000000001`) — mints *bare relative* image paths (`covers/3.png`,
  `pages/fixture-1-2.png`) and refuses an image request without its `Referer` and `User-Agent`
  (403). This is the MangaFire shape.
- **Fixture JSON** (`1000000000000000002`) — mints the host's own `/image/…` proxy paths, one page
  of which still wants a `Referer` through that proxy.
- **Fixture Login** (`1000000000000000003`) — 401 with `{ error: "login required", loginUrl }` until
  the login cookie is present, then normal.
- **Fixture Cookie** (`1000000000000000004`) — sets a session cookie on the first call and answers
  403 without it afterwards.

### Driving it

Three ways, and they compose:

```js
import { startDalvikMock, createCookieJar, SOURCE_IDS } from "../fixtures/dalvik-mock.mjs";

const mock = await startDalvikMock({ delays: { getPageList: 400 } });  // config object
new DalvikClient({ baseUrl: mock.scenarioUrl("fail-500") });           // base-url scenario
await fetch(`${mock.baseUrl}/repo/index.json?update=1`);               // query parameter
await mock.close();
```

Scenarios: `slow`, `fail-500`, `fail-malformed`, `fail-empty`, `fail-timeout`, `login`, `cookie`,
`update`, `no-bridge` (a host that answers and is not one of ours). A scenario prefix
(`…/s/slow/dalvik`) applies to that client only, so tests share nothing; `mock.use(name)` switches
the default for the unprefixed routes. `mock.state` records every call, image request, login and
install, and `GET /__state` / `POST /__reset` expose the same thing over HTTP.

`createCookieJar()` is the test's stand-in for the runtime's own cookie store: in the real system
the Java process holds the session and the app never sees a cookie. `DalvikClient` takes a
`fetchImpl`, so a jar wrapped around `fetch` is the whole of that behaviour — and the only way to
prove the 403/401 paths are reachable.

## What it deliberately does not cover

- **A real APK extension.** The fixture APK is 27 bytes (`PK\x03\x04fixture-not-a-real-apk`). It is
  enough to exercise the install *transport* — the id is the SHA-256 of whatever bytes you send —
  and nothing else. A real extension needs the Mihon/Keiyoushi `extension-lib` jar, Gradle, and a
  build of the extension source; the host would then parse real dex bytecode.
- **Java/Android toolchain, as of this writing.** `which java gradle sdkmanager adb` on this machine:

  | Tool | Present | Where |
  | --- | --- | --- |
  | `java` | yes | `~/.local/java/jdk-17.0.20.1+1/bin/java` (Temurin 17.0.20.1) |
  | `gradle` | **no** (not on `PATH`) | a wrapper distribution is cached at `~/.gradle/wrapper/dists/gradle-9.6.1-bin` |
  | `sdkmanager` | yes | `~/Android/sdk/cmdline-tools/latest/bin` |
  | `adb` | yes | `~/Android/sdk/platform-tools` |
  | Android SDK | yes | platforms `android-34/35/36/37.0`, build-tools `28.0.3`, `35–37` (`aapt2`, `d8`, `apksigner`) |

  So a real APK *could* be built here with the cached Gradle wrapper and an `extension-lib` jar —
  but that jar is not on this machine, and the fixture does not need it.
- **HTML scraping.** The "HTML" source does not parse anything; it mints the *shape* an HTML source
  produces. The extension's own parsing is the extension's business, not the transport's.
- **`server/proxy.mjs`.** The fixture talks to `DalvikClient` directly because the client takes a
  `baseUrl` — no refactor was needed. The proxy is a prefix swap on top of that (`/api/dalvik/*` →
  the host), and the fixture cannot prove anything about it that the swap does not already say. Note
  that `/api/repo` refuses private addresses, which is why the repository tests call `loadRepository`
  with a plain `fetchImpl`.
- **A cookie store in the app.** The app has none, and needs none: the runtime holds sessions. The
  jar in the tests exists to drive the fixture, not to suggest the client should keep cookies.
- **TLS, HTTP/2, gzip.** The real host once gzipped `/capabilities` and broke the proxy; the fixture
  answers plain, because that bug lives in `server/proxy.mjs`, not in the transport.

## What the fixture found

One real gap, fixed in `src/api/dalvik.ts` (and pinned by
"a bare relative image path resolves against the source's base url"): a source that mints
`covers/3.png` had that path joined to the *host's* base url, which 404s. A bare relative path now
resolves against the source's declared `baseUrl`; an absolute `/image/…` path is still the host's
own proxy, and a source with no declared base url behaves exactly as before.

## Running it

```sh
npm test                                                  # everything, including these 24
node --experimental-strip-types --import ./tests/unit/register-ts.mjs \
     --test tests/unit/dalvik-fixture.test.mjs            # just the fixture
```

To poke at it by hand:

```sh
node --experimental-strip-types --import ./tests/unit/register-ts.mjs -e '
  const { startDalvikMock } = await import("./tests/fixtures/dalvik-mock.mjs");
  const mock = await startDalvikMock({ delays: { getPopularManga: 50 } });
  console.log(mock.baseUrl, mock.sources());
' --input-type=module
```

# T17 — WebView login + cookie sharing into the runtime

Date: 2026-10-29 · Card `t_338636c0` · Runtime: M-Extension-Server **v1.0.9**, `127.0.0.1:8792`
(`docker ht-dalvik`, jar built from source in this session's predecessor).

This is the record for the matrix rows this card owns. It says what was **observed**, and it says
plainly which rows still need a device.

## What the runtime actually accepts (the contract, from the shipped jar)

Read out of the running runtime's own bytecode (`docker cp ht-dalvik:/app/runner.jar`), not from
documentation:

```
mextensionserver.controller.DalvikHandler.serve   — reads these request headers on POST /dalvik
  cookie / Cookie              → split on ";", okhttp3.Cookie{path="/", domain=<source baseUrl host>}
                                 deduped by name, NetworkHelper.getCookieJar().addAll(https://<host>, …)
  user-agent / User-Agent      → NetworkHelper.setUA  (ignored when empty or starting with "Dart/")
  source-base-url              → the source's own site for this call
  cf-proxy-url                 → NetworkHelper.setCloudflareProxyUrl
  x-mangayomi-webview-port     → KcefWebViewProvider.Companion.setBridgePort(port)

xyz.nulldev.androidcompat.webkit.KcefWebViewProvider — the app-side bridge, when a port was given
  POST http://127.0.0.1:<port>/bridge_webview
       {url, headers?, postData?, scripts?, time?}   →  {cookies: [Set-Cookie strings]}
  POST http://127.0.0.1:<port>/evaluateJavascriptViaWebview
       {url, scripts: [js], time}                    →  {result: string}
```

Consequences this card implements: cookies are **not** a one-off hand-off at login — they are a
request header on **every** call, because the runtime's jar is a `MemoryCookieJar` inside the
extension instance and there is no route that reads it back. That is also why the app has to own the
persistence (`cookies` store, DB v12).

## 1. The rules and the seam — `npm test`

```
$ node --experimental-strip-types --import ./tests/unit/register-ts.mjs --test tests/unit/cookies.test.mjs
# tests 21
# pass 21
# fail 0
```

Covers: `Set-Cookie` parsing (Path/Domain/Max-Age/Expires/HttpOnly/Secure), host-only vs `Domain=`
scoping, two sources on two sites never sharing a session (HTTP-08), expiry, `Max-Age=0` deleting a
row instead of replacing it (WEB-05), the same cookie twice replacing, the database jar surviving a
reopen (HTTP-07), a cancelled webview writing nothing (WEB-07), a third-party cookie being refused,
and the runtime's two bridge routes answering in the shapes above.

Full suite: **408/408**, `tsc --noEmit` clean, `svelte-check` 0 errors, `npm run build` 280 kB JS.

## 2. The hand-off against a host that refuses — the fixture

`tests/fixtures/dalvik-mock.mjs` (T19) refuses its login source with `401 login required` and its
cookie source with `403` until the right cookie comes back. The webview is faked the way the card
asks: the fake "opens" the fixture's `/login` page, and the `Set-Cookie` it returns is what a real
one reports.

Observed, in `cookies.test.mjs`:

- the login source answers 401 with `loginUrl=/login?source=…`; `loginSource()` opens exactly that
  URL, stores the cookie, and the **same call** then answers with rows;
- the host sees `cookie: fixture_login=logged-in` and `x-hardlytracking-cookies` carrying the same
  value on that call — the session travelled as a header, not in the body;
- the cookie source's `Set-Cookie` is stored on the first call and replayed on the second, which is
  the only reason the second answers;
- a new client and provider over the same jar still answer (a restart, without the runtime's jar);
- a login that does not take is reported as `rejected` **with its cookies kept** (a challenge site
  sets its anti-bot cookie before the one you need).

## 3. The browser/PWA path through the real proxy

A browser cannot set `Cookie` on `fetch` (forbidden header, dropped silently), so the client also
sends `x-hardlytracking-cookies` and `server/proxy.mjs` promotes it. Proven live: fixture host on
`:46501`, the real proxy on `:8477`.

```
$ curl -s -o /tmp/c1.json -w "%{http_code}" -X POST http://127.0.0.1:8477/api/dalvik/dalvik \
    -H 'content-type: application/json' \
    -d '{"method":"getPopularManga","sourceId":"1000000000000000003","page":1}'
401
{"error":"login required","code":401,"loginUrl":"/login?source=1000000000000000003"}

$ curl -s -o /tmp/c2.json -w "%{http_code}" -X POST http://127.0.0.1:8477/api/dalvik/dalvik \
    -H 'content-type: application/json' \
    -H 'x-hardlytracking-cookies: fixture_login=logged-in' \
    -H 'user-agent: HardlyTracking-Test/1.0' \
    -d '{"method":"getPopularManga","sourceId":"1000000000000000003","page":1}'
200
{"mangas":[{"url":"/manga/fixture-1","title":"Fixture Title 1",…}], …}
```

## 4. The real runtime takes the session headers

Installed the real MangaDex APK through the shipped client against `127.0.0.1:8792`
(`extensionId 12fde776…`, 61 sources) and made the same search call twice, three sources each: bare,
and with `cookie` + a webview `user-agent` + `source-base-url` + `x-mangayomi-webview-port`.

```
bare         20 items      session 20 items     (MangaDex 4638673959522768501)
bare         20 items      session 20 items     (MangaDex 987803387023224960)
bare         20 items      session 20 items     (MangaDex 3339599426223341161)
```

`docker logs ht-dalvik` after these calls: no `DalvikHandler` error (the only error in the log is an
older `Unknown method: install` from 22:59). So the headers are parsed and applied without changing
the answer for a source that needs no session.

## 5. The UI, in a browser tab (the honest case)

Real build (`npm run build`), real proxy on `:8477` against the fixture host, fixture APK installed
through the app's own repository flow (3 installed, `Fixture Demo 1.0.0 — 4 sources`), then Browse →
Fixture Login:

```
login required
Log in to this source
This source returned nothing.

[click "Log in to this source"]

this build runs in a browser tab, which cannot open an in-app webview — open the packaged app to log in
```

So a 401 raises the button, and a build with no webview says exactly that instead of reporting a
login (matrix row WEB-07's requirement, in the one build that can be checked today).

## Not proven here — and why

| Matrix rows | State | Why |
|---|---|---|
| HTTP-05/06/07 (cookie create/reuse/restart) | mechanism proven against the fixture + a database reopen; **not** against a real cookie-gated site | Toonily/Coolmic need an account and the device run |
| WEB-01/02/03/04/05/06 (open/login/bridge/challenge) | code + contract + fake-webview proof | there is **no in-app webview in this build**: the Tauri desktop shell (T6) and the iOS shell (T12) have to implement `webview_login` / the `WebviewLogin` plugin and mount `/bridge_webview`. In a browser tab the app reports `unsupported` and says so |
| WEB-08/09/10 | isolation and expiry proven in unit tests; UA parity wired (`user-agent` per call) | needs two logged-in sources on a device |
| Scythe Scans / Comix (challenge) | the runtime's challenge route is answered by `src/lib/webview/bridge.ts`; the runtime falls back to its own CEF when no port is sent | the phone has no CEF, so this needs the shell's loopback listener |

The matrix hard gate ("no Safari, no desktop browser, no manual cookie copying") is respected by
design: cookies are collected by an in-app webview and handed over as headers. Whether a person can
complete a real login is a device observation — T13's run, not this card's.

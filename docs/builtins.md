# What may ship inside the app, and what may not

HardlyTracking is a reader. It does not distribute manga, and it does not bundle anyone's catalogue.

## Never built in

**Content sources.** No manga, comic or webtoon source ships with this app. Not as a provider, not as
a bundled extension, not as a pre-filled repository. The user adds extension repositories (Keiyoushi
and the rest) or installs APKs themselves, exactly as they would in Mihon. This is a licensing rule,
not a preference: those sources are third-party code that carries its own terms, and an app that
ships them becomes a distributor of them.

The same applies to the indexes: the app may *read* a repository the user added, and it must never
pre-populate one.

## Allowed built-ins

Three kinds, and each is allowed for a stated reason:

| built-in | why it is allowed |
| --- | --- |
| **Locally hosted services** — Komga, Suwayomi | The user runs the server on their own machine. There is no third-party catalogue to distribute: the content is already theirs. |
| **Internet Archive** | Open, publicly documented API and public-domain / openly licensed material. Nothing is redistributed — the app reads archive.org's own endpoints. |
| **HT-Server** | Our own code, hosted by the user on their own machine. It is an optional *source* — one more host to browse from, like Komga or Suwayomi — never the app's origin: pairing it must not re-point this device's own runtime, repositories or images. |

## How that shows up in the app

- Built-ins appear as extension cards with a **Built in** badge and a switch, and cannot be
  uninstalled — there is no APK to remove.
- `src/api/builtin.ts` holds that list. Adding a fourth entry is a legal decision before it is a code
  change: if it is a third-party content source, it does not belong there.
- The Mihon extension runtime (M-Extension-Server) is **infrastructure, not an extension**. It is a
  service the app talks to on `127.0.0.1:8792`; it has no card, no switch and nothing to uninstall,
  because it ships no content either — it executes APKs the user installed.

### Checking the hop without a Komga login

`node tests/manual/stub-komga.mjs` answers the five routes the provider uses on `:25611` with the
login `tester` / `secret`, a 1×1 PNG behind every cover and page, and a log at `GET /__log` that
records the authorization header each request arrived with. Point the Komga card at that address and
the whole path — library list, shelves, cover, chapter, page 2 on scroll, a `PATCH` back — can be
read end to end without touching a real server or a real password.

Two things it caught, both worth keeping in mind:

- A cover that needs a header must never go into an `<img src>`. The browser asks anonymously, takes
  a 401, and the tile falls back to the title for good even though the image cache has the picture.
  `Cover.svelte` only ever shows such a cover once it resolves to a blob.
- A page URL handed to `/api/img` must be absolute. That route takes a URL and rejects a path, so a
  root-relative `/api/komga/…` arrives as `url=%2Fapi%2Fkomga…` and draws nothing.

## The `/api/komga` route

The browser build cannot reach Komga: Komga sends no `Access-Control-Allow-Origin`, so a page served
from another origin is refused before credentials matter. The packaged builds do not have that
problem (Capacitor's HTTP and the desktop shell bypass CORS), so the route exists for the page only.

The address travels in the path — `/api/komga/<base64url of the origin>/api/v1/…` — because covers and
page images are fetched as URLs and an `<img>` cannot send a header. `server/komga-target.mjs` parses
it, `serveKomga` in `server/proxy.mjs` forwards it.

Two rules keep it from being an open proxy, and both are unit-tested:

- **Only a server on the user's own network** — loopback, RFC1918, link-local, CGNAT (tailnet) or
  `.local`. A public Komga is refused; it never needed the proxy.
- **`www-authenticate` is not forwarded.** It is Komga's challenge to Komga; passing it on makes the
  browser raise a credential challenge against *this* app's origin, and the request hangs instead of
  answering 401.

The login is the same one the card asks for, forwarded as `authorization` and never stored on this
server.

### A source's own filters, and how they were proved

`node tests/manual/stub-mihon-graphql.mjs` is a stand-in Mihon host on `:25777` with two sources: one
that declares a filter form (select, checkbox, text, sort) and one with none. It **applies** what it is
sent, so a result set that shrinks is the proof, and `GET /__log` keeps every `fetchSourceManga` payload.

    node tests/manual/stub-mihon-graphql.mjs
    RUNTIME_URL=http://127.0.0.1:25777 PORT=8461 node server/proxy.mjs

Measured 2026-11-02 through `/api/mihon/graphql` on the second command's port:

- six titles with no filters; `checkBoxState: true` at position 3 returned the three finished ones;
  adding `selectState: 2` at position 2 returned two — and the payload carried exactly two changes,
  in the source's order.
- POPULAR and LATEST sent `filters: null`: a Mihon extension ignores filters outside a search, so
  sending them would present an unfiltered list under a filtered heading.
- The source with no filters drew no Filters button at all, which is the "absent is a real answer"
  rule in `SourceProvider.filters?`.

## The dalvik hop invents no headers

`/api/dalvik/*` is passed to the runtime with `node:http`, not `fetch`, and two of the tab's own
headers are dropped on the way:

- **`user-agent`** — the runtime applies whatever UA it receives to the *extension's* HTTP client
  (`NetworkHelper.setUA`), so a forwarded browser UA makes the extension browse as Chrome. MangaDex
  answers a browser or unknown UA with an HTML challenge page, which the extension then tries to read
  as JSON: `Unexpected JSON token at offset 0 … <!doctype html>`, a 500, and a source that "returned
  nothing". Measured 2026-11-02: the real MangaDex APK through this proxy answered 20 titles with no
  UA and the same 500 with a Chrome UA. `fetch` cannot express "no user-agent" — it sends `node`, or
  the literal string `undefined` — which is why this hop uses a raw request. A UA the app *means* to
  send travels as `x-hardlytracking-user-agent` (a tab cannot set `User-Agent` itself) and is the
  only value that reaches the runtime.
- **`host`** — `fetch` used to set it from the target; a raw request forwards it verbatim, and the
  browser's `host` names the proxy's port, not the runtime's. Forwarding it makes the runtime answer
  its own HTML error page.

`tests/unit/dalvik-user-agent.test.mjs` starts a real proxy against a recording stand-in for the
runtime, so both rules are asserted on the wire rather than in the source text.

### The app's own side of the same rule

The proxy only covers the browser build; the desktop and iOS builds call the runtime directly, past
it. So the stored webview UA is also gated at the source (`authFor` in `src/api/dalvik.ts`): it is
sent **only for a host the app holds a session cookie for**, because that UA is the identity of that
session and nothing else. An anonymous source gets no UA at all and keeps the extension's own.
Before that, one webview login anywhere made every extension — MangaDex included — browse as a
browser, which is the same challenge page the proxy was fixed for.

`tests/unit/cookies.test.mjs` ("the webview UA goes only where the session goes") pins both halves
against the fixture host.

### What the bundled runtime actually does with a UA

Measured 2026-11-03 against `plugins/mihon-runtime/linux/runner.jar` (MExtensionServer v1.0.9, the jar
the desktop build spawns and the IPA embeds), MangaDex 1.5.0, `getPopularManga`:

| `user-agent` sent | result |
| --- | --- |
| absent | 20 titles |
| desktop Chrome | `500 Unexpected JSON token … <!doctype html>` |
| Android Chrome (what a webview login stores) | same 500 |
| `Tachiyomi Mozilla/5.0 …` | 20 titles |
| `HardlyTracking/1.0 CFNetwork/… Darwin/…` | 20 titles |
| empty string | 20 titles |

So the runtime really does hand the UA to the extension's HTTP client, and the only values that break
are *browser-shaped* ones — which is exactly what a stored webview UA is. Gating it on a session fixes
anonymous sources everywhere; a source the person logged into through a webview still presents that
browser UA, and a site that refuses browser UAs (MangaDex's API does) will refuse it. That trade is
deliberate: the UA exists to satisfy sites that *require* the browser identity.

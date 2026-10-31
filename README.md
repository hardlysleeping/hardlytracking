# HardlyTracking

A cross-platform manga reader with a Mihon/Komikku source layer, built on the
architecture of HardlyReader: one Svelte 5 app, one `SourceProvider` seam, and the
same UI on web/PWA and (later) packaged apps.

**Status: iPhone-first web MVP, and it reads.** Add a Mihon extension repository by URL, install an extension
from it, browse a source, open a series, read a chapter — all through a real extension host. The
library remembers where you were and offers it back.

**Next milestone is the standalone iPhone build** (priority 1, owner's order): the same app with an
embedded OpenJDK Zero runtime behind a Tauri plugin, so Mihon APK extensions run on-device with no
server, no Suwayomi and no LAN. The stack is real, not speculative — see `BACKLOG.md` and the native
MVP boundary in the plan.

## What runs today

```
Svelte 5 UI  →  SourceProvider  →  MihonProvider  →  /api/mihon  →  Mihon runtime (Suwayomi :4567)
                               →  LocalProvider  →  app database (IndexedDB)
```

- **`SourceProvider`** (`src/api/source.ts`) is the seam. Ids are namespaced (`mihon:12`,
  `mihon:ch:1`), so a row from the runtime and a row from the device database can never collide.
- **`MihonProvider`** (`src/api/mihon.ts`) talks to a Mihon extension host over GraphQL. The
  extensions are real, unmodified Mihon APKs; only *where the JVM runs* changes between platforms.
- **`LocalProvider`** (`src/api/local.ts`) is the library on this device. `ownsProgress` decides the
  writer per provider — the server keeps its own state, our database keeps ours, and never both. Two
  providers own it here: `local` and `dalvik` (a `/dalvik` host has no read-state API at all).
- **Five destinations, phone-first** — Library, Updates, Browse, History, More, with a bottom bar.
  Series pages and the reader push on top of a destination; the reader takes the whole screen and
  hides its chrome until you tap. The same shell grows into a rail and a sidebar on a wide window,
  but the phone layout is the one being built first.
- **Reader modes** — vertical, webtoon, paged, left-to-right and right-to-left, with fit width /
  height / whole page, page spacing, edge tap zones that follow the reading direction, and
  keyboard: arrows, space, J/K for chapters, F, R, Esc.
- **Downloads** — pages kept as blobs in the device database, read with no network at all; the
  reader says `· offline` when it is reading them.
- **History and Updates** — history grouped Today / Yesterday / This week, each row with Continue;
  updates are the library's own chapter lists read again, newest first.
- **Backup & restore** — one JSON file out and in, free, using the same document format as sync.
- **Extension repositories** — one URL in, the index out: paste a repository (Keiyoushi publishes
  1 438 extensions), search it, install or update by version code. Indexes and APKs are fetched
  through `/api/repo` so the page stays on one origin; the host itself has no repository support.
- **Continue reading** — the reader writes position, history and progress in one call, so the
  library's continue strip always resumes at the page you stopped on.
- **Hidden and pinned categories** (`src/lib/categories.ts`, `CategoryRail.svelte`) in HardlyReader's
  look: one eye cycling Hidden → Revealed → Only, one pin cycling Active → Only → Hidden, pinned rows
  carrying the pin's ring and underlight, a per-row eye and pin, and a rail selection that narrows the
  library without touching either mark. Both marks are ours — nothing is written to the runtime.
- **`src/api/dalvik.ts`** is the packaged-app path: the same `SourceProvider` over
  M-Extension-Server's `/dalvik` bridge, where the APK travels as base64 and comes back as an
  extension id (its SHA-256). Proven on Linux against the real runtime and a real MangaDex APK;
  `npm run dalvik:smoke` reproduces it.
- **`server/proxy.mjs`** serves the built app and proxies `/api/mihon/*` to the runtime, so the
  browser sees one origin and there is no CORS to configure.

## What ships inside HardlyTracking, and what never can

No content source ships with this app. The user adds extension repositories or installs APKs
themselves, exactly as in Mihon — an app that bundles them becomes a distributor of third-party
code. The built-ins that *are* allowed are the ones with no third-party catalogue behind them:
locally hosted services (Komga, Suwayomi), Internet Archive (open data, public API), and this
project's own HT-Server (a PC you point it at, as a source — never as the app's origin). The rule
and its reasons: `docs/builtins.md`.

## Free, and what is paid

The reader is free and stays free: standalone iPhone reading, Mihon/Komikku extensions, the local
library, downloads, history, progress, manual backup export/import and Komga/Suwayomi all work with no
account and no subscription.

**Sync and billing are post-launch**, not part of the road to a release — nothing here delays the reader.
When it ships, the only paid capability is **automatic cross-device sync** — $0.99/month or $9.99/year, one
`cloudSync` entitlement covering every supported provider on every device under one account. An account
is asked for only when sync is enabled. Supabase holds identity, the entitlement, the device list and the
Stripe customer mapping; it never holds the library, history, downloads, extensions or sync documents —
those stay on the device and in the user's own cloud storage. If a subscription lapses, sync stops and
nothing else changes. Plan section: "Sync & monetization — post-launch". The sync document, merge engine and folder/WebDAV
transports already exist in `src/lib/sync/` and are tested; they are deliberately not wired into the app.

## Run it

```bash
npm install
npm run dev            # http://localhost:5199, /api/mihon proxied to 127.0.0.1:4567
```

Production, one origin:

```bash
npm run build
npm run serve          # http://127.0.0.1:8460 (PORT / RUNTIME_URL override)
```

Or the whole stack: `docker compose up -d` (app on :8460, runtime behind it).

### Docker

The app alone, as one container — the built Svelte bundle plus the proxy that gives it a single
origin:

```sh
docker run -d --name hardlytracking -p 8460:8460 \
  -e RUNTIME_URL=http://127.0.0.1:4567 \
  -v hardlytracking-data:/data \
  ghcr.io/hardlysleeping/hardlytracking:latest
```

`RUNTIME_URL` points at a Mihon extension host (Suwayomi is the one this was built against);
`DALVIK_URL` does the same for an M-Extension-Server, and both are optional — without either the app
still runs, it just has no sources to browse. `/data` holds the extension registry this host
installed for a paired phone, so keep the volume if you use that.

What the image deliberately does **not** contain is an extension host. Suwayomi and
M-Extension-Server are third-party images, and the app treats either as an execution engine rather
than its source of truth — `docker-compose.yml` wires all three together:

```sh
docker compose up -d          # web + Suwayomi + M-Extension-Server
```

The library, read state, downloads and settings live in the browser's IndexedDB, so the container is
otherwise stateless. Images are published on every `v*` tag as `latest`, the minor line and the exact
version (`0.1.0`); `--build-arg PUBLIC_SUPABASE_URL=… --build-arg PUBLIC_SUPABASE_ANON_KEY=…` bakes
HardlySyncing's sign-in into a local build (both values are public — the anon key ships in every
bundle by design).

The runtime must be a Mihon extension host on `:4567`. Suwayomi is the one this was built
against: `ghcr.io/suwayomi/suwayomi-server:v2.4.2366`.

## Gates

```bash
npm test         # node --test, no network (24 tests)
npx tsc --noEmit
npm run build
npm run smoke        # live, needs the runtime on :4567
npm run matrix:check # live: validates the iPhone test matrix against the extension index
```

The iPhone MVP is gated by `docs/ios-mvp-test-matrix.md` — 25 pinned extensions across ten required
classes, then his EXT / SRC / HTTP / WEB / LIB / OFF / BAK / UPD / LIFE matrices, six release gates and one
final acceptance scenario. Nothing is "done" for the native build until those rows are recorded from a
physical iPhone, and no Komga/Suwayomi/PWA work starts while a hard gate fails.

## Not built yet

Tauri desktop and packaged apps, the embedded runtime, the iOS embedded-JVM plugin, the
Komga provider (needs credentials), Mihon/Komikku backup import, downloads and sync.
See `BACKLOG.md` and `KANBAN.md`.

## Install links and repositories

The Add repository field accepts what the extension lists actually publish — a repository root, an
index URL, or the **Install link** itself:

```
mihon://extension-store?url=https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb
```

A `mihon://` / `tachiyomi://` / `komikku://` link is unwrapped to its `url=` payload, a GitHub blob
URL is rewritten to raw, and an `index.pb` link falls back to the JSON index published beside it
(Keiyoushi, Cursed Yūzōnō and FelipeGFA all ship `index.json` next to the protobuf). Every repository
listed on [wotaku.wiki/ext/mihon](https://wotaku.wiki/ext/mihon) loads through this path.

`?repo=…` on the app's own URL opens Extensions and adds that repository, which is what the
`web+mihon` protocol handler points at. A bare `mihon://` link belongs to the packaged app (OS
scheme registration); in a browser tab, paste the link into the field.

## Serving the desktop to a phone

The same server can be the runtime for a phone on the same network or tailnet:

```
HOST=0.0.0.0 HARDLYTRACKING_TOKEN=… npm run serve     # or: npm run serve:lan
```

It serves the app and proxies `/api/dalvik`, `/api/repo`, `/api/img` and `/api/mihon`, so the phone
runs no extensions itself. Static files stay open (a browser navigation cannot send a header) and
every `/api/*` call needs the token, as `x-hardlytracking-token` or `?token=`. Settings → Phone
access shows the exact link to open on the phone, and a pairing link (`?host=…&token=…`) points a
device at another desktop instead of itself.

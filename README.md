# HardlyTracking

A cross-platform manga reader with a Mihon/Komikku source layer, built on the
architecture of HardlyReader: one Svelte 5 app, one `SourceProvider` seam, and the
same UI on web/PWA and (later) packaged apps.

**Status: web MVP.** Browse → series → chapters → pages works against a real Mihon extension host.

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
- **`LocalProvider`** (`src/api/local.ts`) is the library on this device, and the only provider that
  owns reading progress. `ownsProgress` decides the writer per provider — the server keeps its own
  state, our database keeps ours, and never both.
- **`server/proxy.mjs`** serves the built app and proxies `/api/mihon/*` to the runtime, so the
  browser sees one origin and there is no CORS to configure.

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

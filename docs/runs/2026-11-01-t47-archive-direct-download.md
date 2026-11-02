# T47 — an Archive volume downloads with no `/api/file` (packaged desktop run)

Card: `t_1ed02cdd`. The question was whether the direct `https://archive.org/download/...` path
works where there is no server of our own — the packaged iPhone app and the Tauri desktop build.
The browser build already read a volume through `/api/file`; that path proves nothing here.

Tree: `master` @ `53217d0`, plus uncommitted work on `src/components/AddFiles.svelte`,
`src/lib/files/import.ts` and its test (an "Add folder" import, by another hand). None of those
files is on the fetch path — `bookUrl`, `hasLocalServer`, `shellFetch` and `createArchiveProvider`
are master's.

Build: `npm run desktop` in an Ubuntu 22.04 container with `webkit2gtk-4.1` 2.50.4. The app binary
and `.deb`/`.rpm` bundled; the AppImage stage failed at `linuxdeploy`, which is that container's
FUSE/tooling gap and not the app (the `.deb` payload and the binary are the same artefact). Run
was the bundled binary — `dist` embedded at compile time, no dev server, no Vite — with isolated
XDG dirs so nothing touched the real library.

## What was observed

| Observation | Value |
|---|---|
| origin the webview loaded | `tauri://localhost` (the WebKit local-storage file is `tauri_localhost_0.localstorage`), so `location.protocol === "tauri:"` and `hasLocalServer()` is **false** |
| `bookUrl()` therefore returned | the direct `https://archive.org/download/<id>/<book>` — no proxy, no token |
| item read | `pokemon-la-revista-no-23-peru`, volume `Pokémon, La Revista Nº 23 (Perú).pdf` (plain 2.9 MB copy; the `_text` derivative was deduped away) |
| bytes stored by the app | `books` row: `bytes = 2 946 636`, `pageCount = 16` |
| md5 of the stored blob | `5ed7aaf3162d8ad4955d21b0c32dc2be` |
| md5 of the same URL fetched with `curl -L` | `5ed7aaf3162d8ad4955d21b0c32dc2be` — **identical**, `HTTP 200`, `content-length 2946636`, served from `dn721807.ca.archive.org` |
| what the reader drew | page 1 as a full-page image, counter `1 / 16`, title in the header |
| the storage node's CORS | `302` → `200`, `content-type: application/pdf`, **no `Access-Control-Allow-Origin`** even with `Origin:` sent |

Screenshots: page only, and the same page with the reader chrome, are attached to the card.

## Why this proves the direct path and not something else

There is no HTTP server in the process: `ss -ltnp` lists no listener for it, so `/api/file` cannot
answer — a request to it would be the SPA's own `index.html` or nothing. The bytes in the database
are byte-for-byte the file `archive.org` serves, so they arrived over the network. And a plain
webview `fetch` could not have fetched them: the storage node sends no `Access-Control-Allow-Origin`,
which is the reason `/api/file` exists. The only fetch in this build that can reach it is the one
`shellFetch()` returns — `@tauri-apps/plugin-http`, wired at `library.svelte.ts` into
`openLibraryProfile`, which hands the same `fetchImpl` to `createArchiveProvider` where it becomes
`bookFetch` for the volume download. So the desktop shell needs no change: the volume already goes
through Rust's HTTP client.

Rendering note: the run set `WEBKIT_DISABLE_COMPOSITING_MODE=1` so an X11 capture of the window is
real pixels and not a black rectangle. It changes how WebKit paints and nothing about which URL a
`fetch` goes to; the stored bytes are the same file either way.

## The iPhone half is still open

Not run — there is no device here, and an IPA cannot be built or installed from this machine. What
the code does there is known: `capacitor://localhost` also fails `hasLocalServer()`, so the same
direct URL is used, and with `plugins.CapacitorHttp.enabled = true` the native bridge patches
`window.fetch`. Reading the bridge (`@capacitor/ios`, `assets/native-bridge.js`) shows the mechanism
is not "a native request that ignores CORS" but a **proxy**: a `GET` to an external URL is rewritten
to `capacitor://localhost/_capacitor_http_interceptor_?u=<url>`, which `WebViewAssetHandler`
(`handleCapacitorHttpRequest`) answers with a `URLSession.dataTask` — so redirects are followed,
the body stays binary, and `response.url` is the storage node. That is consistent with the desktop
result, but a mechanism read off the source is not a device observation: it still needs one volume
opened on a physical iPhone before this half can be called verified.

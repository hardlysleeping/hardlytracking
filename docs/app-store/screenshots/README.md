# App Store screenshots

Captured from the running web build at `http://127.0.0.1:8460` in an emulated iPhone 16 Pro Max
(`440×956`, `deviceScaleFactor=3`, `mobile=true`), so every file is **1320×2868** — the 6.9″ size
App Store Connect asks for. The library is seeded with twelve Internet Archive public-domain
titles only: Golden Age books whose copyright was not renewed. Nothing in these images comes from
a real person's library, server, folder or account.

## Captured

| File | Screen | What it is meant to show |
|---|---|---|
| `00-welcome.png` | First run | Three doors — files you own, your own server, the Internet Archive — and the sentence "HardlyTracking has no comics of its own." No repository door. |
| `01-library.png` | Library, compact density | A shelf of real public-domain covers, a complete last row, no loading state. |
| `02-series.png` | Series page | Cover, description, source, chapter list, one primary action. |

## Blocked, and why

The set is incomplete on purpose. Three defects found while shooting were recorded on the board
rather than worked around in the images:

- **No reader screenshot** (`t_ba9b8509`). A CBZ imported through *Add files* reaches the reader,
  which then sits on "Fetching pages…" and renders nothing — in the browser build, for a file that
  `lib/files` opens in 11 ms under node. The reader is the product; a screenshot of it is the first
  thing a reviewer should see.
- **No Internet Archive page reading** (`t_42ef8f04`). `pages()` enumerates an item's pages by
  fetching the `/download/<id>/<book>/` HTML listing, which archive.org answers from a redirect
  host without a CORS header. Packaged builds bypass it; the web build shows "Failed to fetch".
- **No Browser or Search screenshot** (no card — a shared-runtime artefact). In this profile the
  extension runtime reports "3 adult packages hidden — raise Content to Adult in Settings", and the
  runtime's own source row renders the raw string `LOCALSOURCELANG` where a language belongs.
  Neither belongs on a store listing, and neither can be removed without deleting packages from the
  owner's live runtime. The `LOCALSOURCELANG` placeholder is a genuine copy bug worth fixing on its
  own terms.

## Still to capture once the reader works

- Reader, single page, at 6.9″ and 6.5″ (`1242×2688`).
- Continue-reading row on the library once history exists.
- Settings → Storage, which shows the app measuring what it uses.
- iPad set, **only if** the app is offered on iPad (leave the iPad screenshots out of App Store
  Connect rather than claim a layout nobody has run).

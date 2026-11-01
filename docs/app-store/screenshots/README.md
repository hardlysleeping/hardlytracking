# App Store screenshots

Captured from the running web build at `http://127.0.0.1:8460` in an emulated iPhone, so each file
is exactly a size App Store Connect accepts:

| Folder | Emulated device | CSS viewport | Pixels | App Store slot |
|---|---|---|---|---|
| `iphone-6.9/` | iPhone 16 Pro Max | 440 × 956 @3× | 1320 × 2868 | 6.9″ display |
| `iphone-6.5/` | iPhone 11 Pro Max | 414 × 896 @3× | 1242 × 2688 | 6.5″ display |

Every image is seeded with **public-domain titles only** — Golden Age books whose copyright was not
renewed — plus one public-domain scan imported through *Add files*. Nothing in these images comes
from a real person's library, server, folder or account.

## Captured

| File | Screen | What it is meant to show |
|---|---|---|
| `00-welcome.png` | First run | Three doors — files you own, your own server, the Internet Archive — and the sentence "HardlyTracking has no comics of its own." No repository door. |
| `01-library.png` | Library, compact density | A shelf of real public-domain covers, filled tiles, no loading state. |
| `02-series.png` | Series page | Cover, title, source, chapter list, one primary action. |
| `05-reader.png` | Reader, chrome shown | A page filling the screen, the page counter, prev/next chapter — reading a file on this device, which is the app's headline claim. |

The reader shot is a **local file** — a public-domain Plastic Man scan, imported through Add files —
because that is the path a reviewer can repeat with no account and no network.

## Known weaknesses in these images

- The Internet Archive series page lists the archive's own file names as chapter names
  (`Quality__Blackhawk_009_text`), not "Chapter 1". It reads as unpolished in a store image, and it
  is a wording problem in the archive provider, not a screenshot problem.
- Browse and Search are absent. With the extension runtime present the profile reports "3 adult
  packages hidden — raise Content to Adult in Settings", and the runtime's own source row renders the
  raw string `LOCALSOURCELANG` where a language belongs. Neither belongs on a store listing, and
  neither can be removed without deleting packages from the owner's live runtime.

## Still to capture

- **App Preview video** — Apple requires it recorded from a device or simulator at the device's own
  resolution; it cannot be produced from a browser capture. Blocked on the device run (T13), like the
  release matrix.
- Continue-reading row on the library once history exists.
- Settings → Storage, which shows the app measuring what it uses.
- iPad set, **only if** the app is offered on iPad — leave the iPad screenshots out of App Store
  Connect rather than claim a layout nobody has run.

## How these were taken

Chrome over CDP at the emulated geometry, `Page.captureScreenshot` with `fromSurface: true` — a
`fromSurface: false` capture comes back at CSS size (414 × 896), not 3×. Three gotchas, all hit:

- **A capture can hang** for a minute when the page has just been heavily scrolled or holds many 3×
  images decoded. Reloading the view and capturing straight after worked every time.
- **Image decode must be waited for.** Covers resolve lazily; a capture taken too early gives blank
  tiles. Count `naturalWidth > 0` on the tiles you care about first.
- **Sessions share nothing but the server.** Browser automation profiles are separate stores: seeding
  a library in one and capturing in another gives an empty shelf. Seed and shoot in the same session.

# iPhone MVP test matrix

This is the gate for the standalone iPhone build. A row is not "pass" until the observation is
recorded in a run file (see **Recording**). Machine-readable rows: `docs/test-matrix.json`,
validated against the live repository index by `npm run matrix:check`.

**The claim this gate defends:** a sideloaded iPhone app can use normal Mihon/Komikku extension
repositories and APK extensions directly on-device, with no Suwayomi, no Komga, no PC and no
self-hosted server — and everything already acquired keeps working in airplane mode.

## Environments

| Run | Setup | Proves |
|---|---|---|
| **A — Standalone** | iPhone on Wi-Fi; no Suwayomi/Komga reachable, no desktop running the app, no LAN shares | extensions run on-device |
| **B — Offline** | Airplane mode on, nothing else changed | acquired material is usable without a network |
| **C — Restart** | Force-quit and relaunch after A and after B | state is persisted, not in-memory |

Every row below is executed in A unless marked **[B]** or **[C]**.

## 1. Extension compatibility — 20 real extensions

Chosen from the live Keiyoushi index (1 438 extensions) to cover the capability classes, not to be
easy. Names, package ids, versions, APK URLs and the real source ids are pinned in
`docs/test-matrix.json`; `npm run matrix:check` fails if a package disappears or an APK stops
resolving.

| # | Extension | Package | Sources | Exercises | Pass looks like |
|---|---|---|---|---|---|
| 1 | MangaDex | `…all.mangadex` | 61 | multi-source APK, JSON API, real source ids | all 61 sources listed; two different languages open independently; the 19-digit source id is unchanged after restart |
| 2 | Manga Million | `…all.mangamillion` | 108 | multi-source at scale | source list completes without truncation or a watchdog kill; timing recorded |
| 3 | XCOMIC | `…all.xcomic` | 77 | relative URLs in page lists | page images load (no 404s from unjoined paths) |
| 4 | MangaFire | `…all.mangafire` | 7 | captcha solver, challenge, JSON | a challenge is solved or cleanly reported; no blank catalogue |
| 5 | MangaPill | `…en.mangapill` | 1 | baseline HTML | popular, latest, search, details, chapters, pages all work |
| 6 | Asura Scans | `…en.asurascans` | 1 | HTML + frequent releases | upgrade path: install v1.6.70, then a newer build installs over it with preferences intact |
| 7 | Toonily | `…en.toonily` | 1 | cookies | cookie set on one request is present on the next (chapter images load) |
| 8 | Komix | `…en.komix` | 1 | filters | filter sheet renders, a filter changes results, the choice survives restart |
| 9 | Qi Scans | `…en.qiscans` | 1 | filters + custom headers | filters work; requests carry the source's headers (verified in a logged request) |
| 10 | Coolmic | `…en.coolmic` | 1 | cookies + preferences | preference screen opens, a value is saved and read back after restart |
| 11 | J-Novel | `…en.jnovel` | 1 | preferences | same, with a preference that changes requests |
| 12 | Mangabz | `…zh.mangabz` | 1 | filters + preferences + cookies, non-Latin | all three work; Chinese titles render |
| 13 | Dynasty Scans | `…en.dynasty` | 1 | custom headers | a source that 403s without headers loads |
| 14 | Voyce.Me | `…en.voyceme` | 1 | headers + preferences | both work together |
| 15 | InfinityScans | `…en.infinityscans` | 1 | WebView login/interceptor | the WebView opens, the cookie it sets reaches the runtime, and the next call is authenticated |
| 16 | Scythe Scans | `…en.erosscans` | 1 | Cloudflare | the challenge path completes; on failure the error is shown, not an empty list |
| 17 | Comix | `…en.comix` | 1 | captcha | captcha solved or reported; no silent empty catalogue |
| 18 | emaqi | `…en.emaqi` | 1 | authentication | login flow completes and authenticated calls succeed |
| 19 | vomic | `…zh.vomic` | 1 | authentication + preferences + headers | login + preference + header path all work |
| 20 | Manhua Plus | `…en.manhuaplus` | 1 | custom image headers | chapter images load with the source's image headers |

Traits in the "Exercises" column come from the extensions' own code (`keiyoushi/extensions-source`:
`PreferenceScreen`, `addCookie`, `override fun headers`, `getFilterList`, `toAbsoluteUrl`,
`imageRequest`, `WebviewInterceptor`, Cloudflare/captcha references) and from the index's `sources`
array. The *result* is what this matrix decides.

Two rows may be blocked by the source itself (Cloudflare/captcha sites are hostile to data-centre
IPs). A blocked row must say **blocked: source-side**, with the HTTP status — never a quiet skip.
If more than three rows block source-side in one run, the run is inconclusive, not passing.

## 2. Capability checks (each one, once, independent of the 20)

| Check | Pass |
|---|---|
| Repository add | a Mihon-compatible index URL is accepted; **both** live formats parse: keiyoushi `index.json` (v2, `extensionList.extensions`) and legacy `index.min.json` (bare array) |
| Repository listing | all extensions shown with name, version, language, content warning; counts match `npm run matrix:check` |
| Install | the APK downloads, installs, and appears under sources immediately |
| Install persists **[C]** | after force-quit, the extension is still installed and still has its preferences |
| Update | a newer `versionCode` installs over the old one; preferences survive; no duplicate entry |
| Downgrade refused | an older `versionCode` is not installed over a newer one |
| Enable / disable | disabling removes its sources from browse without uninstalling; re-enabling restores them |
| Uninstall | removes the APK and its sources; library rows for its series remain and are marked "source missing" |
| Multi-source APK | sources from one APK are independent (separate browse, separate filters) and share one install |
| Real source ids | a source's id in the app equals `sources[].id` in the index — no re-hashing, no prefixing |
| Preferences | read and write, per source; values persist across restart |
| Popular / latest / search | each returns results for a source that supports it; unsupported `latest` is hidden, not empty |
| Filters | the filter sheet renders all filter types, applies, and persists |
| Details / chapters / pages | each call returns data; page images render in the reader |
| Headers / cookies / UA | a source requiring them works; the values are the source's, not ours |
| WebView login | login page opens in-app; cookies it sets are shared with the runtime; authenticated calls then succeed |
| Reader modes | vertical scroll and paged left/right both work; page position is remembered per chapter |
| Library | add/remove a series; it survives restart |
| Categories | create, rename, assign a series to one, filter the library by it |
| Read state | mark read/unread; reflected in the chapter list and the library badge |
| Position | last-read chapter + page restored on reopen |
| History | ordered by recency; opening a chapter moves the series to the top |
| Download | a chapter downloads; progress is visible; it opens with the network off **[B]** |
| Download management | list, delete one, delete all; deleting frees the space and the row updates |
| Backup import | a Mihon/Komikku backup restores library, categories, history, read state, progress **and source mappings** |
| Source identity after import | imported series reconnect to the installed extension (same `pkg` + source id), no "source missing" for installed sources |
| Backup export | produces a file the app can re-import losslessly (round-trip), and a Mihon/Komikku-compatible export is the next target |

## 3. Offline matrix **[B]** — airplane mode, nothing else changed

Run in this order, because each step depends on the one above it.

| # | Step | Pass |
|---|---|---|
| 1 | Launch the app | opens without a spinner stuck on a network call; no error dialog |
| 2 | Installed extensions | still listed, still enabled, still configured; none marked broken |
| 3 | Library | loads, complete — the same series count as before airplane mode |
| 4 | Categories + history + progress | all present; ordering unchanged |
| 5 | Downloaded chapters | visible and distinguishable from not-downloaded |
| 6 | Open a downloaded chapter | pages render from local files |
| 7 | Reader | vertical and paged both work; page turn has no network delay |
| 8 | Read state + position | updates locally and shows immediately |
| 9 | Close and reopen **[C]** | every change from steps 6–8 is still there |
| 10 | Extension preferences | already-stored values are readable and editable |
| 11 | Backup | can be created to a local file, and restored from a local file |

**Must not happen offline** (any of these fails the run):

- the library appears empty, or shrinks;
- metadata (title, cover, chapter list already fetched) is deleted or blanked;
- an extension is marked broken, disabled or uninstalled;
- a downloaded chapter fails to open, or opens only after a network timeout;
- progress or read state is rolled back to an earlier value;
- the app crashes, hangs on launch, or blocks the UI behind a retry loop.

**Expected offline failures** (these must fail *cleanly*, with a message and no data loss): source
search, popular/latest, new metadata, uncached chapter lists, new downloads, extension update check,
new installs, WebView login against a live site.

## 4. Data ownership

The iPhone database is the authority; the Mihon runtime is an execution engine. Prove it:

| Check | Pass |
|---|---|
| Runtime stopped | with the embedded runtime not running, the library, categories, history, progress and downloads still list and open |
| Runtime data cleared | clearing the runtime's own storage does not remove library rows, categories, history or progress |
| Library writes | adding/removing a series, category or read mark never requires the runtime to answer |
| Source mapping | each library row stores `pkg` + real source id; a series with a missing extension is shown as such and keeps its data |

## 5. Recording

One file per run: `docs/runs/YYYY-MM-DD-ios-<device>.json`, plus a short markdown summary in the
same folder. Row statuses: `pass` | `fail` | `blocked: source-side` | `blocked: app` | `skipped`.
Every `pass` carries the observation (what was seen), and every extension row carries timings:

```json
{
  "date": "2026-11-02",
  "device": "iPhone 13, iOS 18.3, sideloaded IPA <build>",
  "runtime": "MExtensionServer-ios.jar ios-runtime-v9 (sha256 …)",
  "environment": "A",
  "rows": [
    { "name": "MangaDex", "pkg": "eu.kanade.tachiyomi.extension.all.mangadex",
      "status": "pass", "sources": 61, "ms": { "sources": 840, "popular": 3100, "search": 2900, "chapters": 1200, "pages": 900 },
      "observed": "61 sources listed; two langs browsed; source id 4638673959522768501 unchanged after restart" }
  ],
  "offline": [ { "step": "open downloaded chapter", "status": "pass", "observed": "12 pages from local files, 0 network requests" } ],
  "notes": "…"
}
```

Timings are part of the gate: the runtime is an **interpreter with no JIT**, so a source that takes
2 s per call on Android may take 20 s here. Any call over 10 s, or any watchdog kill, is recorded as
a finding even when the row passes.

## 6. Matrix maintenance

```bash
npm run matrix:check   # live index: package present, versionCode, APK reachable, source ids stable
```

- Version drift is expected (extensions release often). Drift is a note, not a failure; a **missing
  package** or an **APK that no longer resolves** is a failure and must be replaced with another
  extension covering the same class.
- Source-id loss is a failure: it means the identity our library and backups are keyed by changed.
- When a row is replaced, update `docs/test-matrix.json` and the table above in the same commit, and
  say which class the replacement covers.

## 7. Not in this gate

Komga, Suwayomi, the web/PWA build, a self-hosted server, MAL/AniList, cross-device or iCloud sync,
Android and desktop. They sit on top of this foundation and cannot be used to excuse a failing row.

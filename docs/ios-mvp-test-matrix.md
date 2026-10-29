# Standalone iPhone MVP Test Matrix

**This file is the release gate for the standalone iPhone build.** Every **hard gate** below is
non-negotiable: nothing moves on to Komga, Suwayomi, the PWA or any other milestone until the hard gates
pass on a physical iPhone. See `AGENTS.md` for the rule and `docs/test-matrix.json` for the pinned
extensions (validated by `npm run matrix:check`).

## Release definition

The iPhone MVP passes only when a sideloaded iPhone can:

**install normal Mihon/Komikku extensions, use them entirely on-device, download manga, go into airplane
mode, continue reading, preserve all state across restarts, and restore that state from backup without
requiring Suwayomi, Komga, a PC, or another server.**

## Test environments

| Environment | Purpose |
|---|---|
| Physical iPhone, current iOS | Primary target |
| Physical iPhone, oldest supported iOS | Compatibility |
| Wi-Fi online | Normal extension operation |
| Cellular online | Non-Wi-Fi networking |
| Airplane mode | True offline validation |
| App force-quit/relaunch | Persistence |
| Device reboot | Persistence/runtime startup |
| Low-storage condition | Download/error handling |

Simulator results do **not** count for the embedded Mihon runtime release gate.

---

## A. Extension repository + installation

| ID | Test | Procedure | Pass criteria |
|---|---|---|---|
| EXT-01 | Add repository | Paste a valid Mihon/Komikku extension repo URL | Repository loads and persists |
| EXT-02 | Invalid repository | Add malformed/unreachable URL | Clear error; existing repos unaffected |
| EXT-03 | Repository formats | Test modern + legacy supported repo indexes | Correct extension metadata appears |
| EXT-04 | APK install | Install normal Mihon APK | APK downloads, verifies, installs locally |
| EXT-05 | Restart persistence | Force quit after installation | Extension remains installed |
| EXT-06 | Device reboot | Reboot phone | Extension still loads and runs |
| EXT-07 | Disable extension | Disable installed extension | Hidden from active sources; APK retained |
| EXT-08 | Re-enable extension | Re-enable | Source works without reinstall |
| EXT-09 | Uninstall | Remove extension | APK/runtime data removed correctly |
| EXT-10 | Multi-source APK | Install APK containing several sources | Every source appears separately with correct real source ID |
| EXT-11 | Preferences | Change extension preference | Preference affects source and survives restart |
| EXT-12 | Broken APK | Attempt corrupt/incompatible APK | Installation rejected without damaging runtime |

**Hard gate:** no proprietary conversion of the APK or source code may be required.

## B. Basic Mihon source execution

| ID | Test | Procedure | Pass criteria |
|---|---|---|---|
| SRC-01 | Popular | Open Popular | Results load correctly |
| SRC-02 | Latest | Open Latest | Results load correctly |
| SRC-03 | Search | Search known title | Correct results |
| SRC-04 | Pagination | Continue past first page | Next page works without duplicates/corruption |
| SRC-05 | Filters | Use extension-specific filters | Results reflect selected filters |
| SRC-06 | Details | Open title | Metadata loads |
| SRC-07 | Chapters | Open chapter list | Chapters and ordering correct |
| SRC-08 | Pages | Open chapter | All page URLs resolve |
| SRC-09 | Image headers | Use source requiring Referer/custom headers | Images display correctly |
| SRC-10 | Multi-language | APK exposes multiple languages | Correct language/source mappings remain separate |
| SRC-11 | Decimal/special chapters | Test 10.5, extras, specials | No chapter loss or incorrect sorting |
| SRC-12 | Runtime isolation | One extension crashes/errors | Other installed extensions continue working |

## C. Headers, cookies and HTTP behavior

| ID | Test | Procedure | Pass criteria |
|---|---|---|---|
| HTTP-01 | User-Agent | Extension requests custom/default UA | Correct UA reaches remote site |
| HTTP-02 | Referer | Source requires Referer | Request succeeds |
| HTTP-03 | Custom headers | Extension supplies arbitrary headers | Headers survive bridge unchanged |
| HTTP-04 | Page-specific headers | Image pages use different headers | Reader sends page headers correctly |
| HTTP-05 | Cookie creation | Source response sets cookie | Cookie stored |
| HTTP-06 | Cookie reuse | Make subsequent request | Stored cookie is sent |
| HTTP-07 | Cookie restart | Force quit/relaunch | Required persistent cookies remain |
| HTTP-08 | Cookie domain isolation | Two sources use different domains | Cookies do not leak across domains |
| HTTP-09 | Redirects | Source uses HTTP redirects | Correct final response |
| HTTP-10 | Compressed responses | gzip/brotli/etc. where supported | Response parses normally |
| HTTP-11 | Timeout | Deliberately unreachable endpoint | Request fails cleanly and can be retried |
| HTTP-12 | Network loss mid-request | Disable connection during fetch | No database/runtime corruption |

## D. WebView login / challenge flow

| ID | Test | Procedure | Pass criteria |
|---|---|---|---|
| WEB-01 | Open login | Source requests browser authentication | In-app WKWebView opens |
| WEB-02 | Normal login | Enter credentials | Login succeeds |
| WEB-03 | Cookie bridge | Close WebView after login | Mihon runtime immediately receives authentication cookies |
| WEB-04 | Restart auth | Restart app | Persistent login remains where site cookies permit |
| WEB-05 | Logout | Clear/login-out cookies | Source becomes unauthenticated |
| WEB-06 | Challenge page | Trigger supported challenge flow | WKWebView can complete it and transfer resulting cookies |
| WEB-07 | Cancel login | Close WebView without finishing | App returns safely; no bogus authenticated state |
| WEB-08 | Multiple sources | Login to two sites | Sessions remain isolated |
| WEB-09 | Expired cookie | Force expired auth cookie | App/source asks for login again rather than silently failing forever |
| WEB-10 | WebView/runtime UA parity | Login challenge depends on UA | WebView and extension requests use compatible identity |

**Hard gate:** authentication cannot require Safari, a desktop browser, Suwayomi, or manual cookie copying.

## E. Library + downloads

| ID | Test | Procedure | Pass criteria |
|---|---|---|---|
| LIB-01 | Add title | Add extension manga to library | Appears immediately |
| LIB-02 | Categories | Add title to several categories | Membership persists |
| LIB-03 | Read state | Mark chapter read/unread | State persists |
| LIB-04 | Reader progress | Stop midway through chapter | Exact/acceptable page resumes |
| LIB-05 | History | Read chapters | History records correctly |
| LIB-06 | Download chapter | Download complete chapter | All pages stored locally |
| LIB-07 | Download several | Queue multiple chapters | Queue completes reliably |
| LIB-08 | Partial failure | One page fails | Download marked incomplete; no false "complete" |
| LIB-09 | Retry | Retry failed chapter | Missing pages complete |
| LIB-10 | Delete download | Delete downloaded chapter | Files removed; chapter/library entry retained |
| LIB-11 | Extension unavailable | Disable/uninstall source after download | Already downloaded chapter remains readable |
| LIB-12 | Metadata persistence | Extension/site offline | Existing title/chapter metadata remains visible |

## F. True offline operation

For every test below, enable **airplane mode and verify Wi-Fi is also disabled**.

| ID | Test | Procedure | Pass criteria |
|---|---|---|---|
| OFF-01 | Cold launch offline | Kill app → airplane mode → launch | App opens normally |
| OFF-02 | Library offline | Browse library | All stored titles visible |
| OFF-03 | Categories offline | Browse categories | Correct membership/order |
| OFF-04 | History offline | Open history | Existing history visible |
| OFF-05 | Downloaded chapter | Open downloaded chapter | Reader works without network |
| OFF-06 | Page navigation | Read entire downloaded chapter | Every page loads locally |
| OFF-07 | Progress write | Stop midway while offline | Position stored |
| OFF-08 | Read-state write | Finish chapter offline | Read state changes locally |
| OFF-09 | Restart offline | Force quit/relaunch while still offline | New progress/read state remains |
| OFF-10 | Reboot offline | Reboot phone, remain offline | Downloads/library/runtime metadata survive |
| OFF-11 | Extension inventory | View installed extensions offline | Installed extensions/preferences shown |
| OFF-12 | Offline source search | Try remote search | Clear offline failure; library remains intact |
| OFF-13 | Offline update check | Check extension updates | Graceful offline result |
| OFF-14 | Offline backup | Create backup | Backup succeeds locally |
| OFF-15 | Offline restore | Restore backup from Files | Restore succeeds without internet |

**Hard gate:** going offline must never turn the library into an empty library or make downloaded chapters
depend on the extension website.

## G. Backups

MVP must support our portable backup and **Mihon/Komikku import compatibility**.

| ID | Test | Procedure | Pass criteria |
|---|---|---|---|
| BAK-01 | Create backup | Backup full library | File created locally |
| BAK-02 | Import Mihon | Import known Mihon backup | Library/categories/read state/source mappings restored |
| BAK-03 | Import Komikku | Import known Komikku backup | Supported data restored correctly |
| BAK-04 | Source identity | Restore title whose extension is installed | Title reconnects to correct real source ID |
| BAK-05 | Missing extension | Restore title without its extension | Title retained and marked missing source; not deleted |
| BAK-06 | Install missing source later | Install extension after restore | Existing title reconnects where IDs match |
| BAK-07 | Categories | Backup → delete app data → restore | Category names/membership identical |
| BAK-08 | Progress | Restore partially-read chapter | Chapter/page progress restored |
| BAK-09 | History | Restore | History survives |
| BAK-10 | Preferences | Backup extension prefs where supported | Restored preferences behave correctly |
| BAK-11 | Corrupt backup | Import truncated file | Rejected without destroying current data |
| BAK-12 | Interrupted restore | Kill app during restore | Current DB remains recoverable/transaction-safe |
| BAK-13 | Offline restore | Airplane mode restore | Works without server access |
| BAK-14 | Version migration | Restore backup from older app build | Schema migrates or produces explicit compatibility error |

A restore should be transactional: either it succeeds or the previous usable library remains.

## H. Extension updates

| ID | Test | Procedure | Pass criteria |
|---|---|---|---|
| UPD-01 | Detect update | Repository contains newer APK | Update shown |
| UPD-02 | Install update | Upgrade extension | New version replaces old version |
| UPD-03 | Preferences survive | Configure preference before update | Preference remains afterward |
| UPD-04 | Source IDs survive | Update multi-source extension | Library mappings remain intact |
| UPD-05 | Library survives | Update extension used by library | Manga/read/history/download records remain |
| UPD-06 | Failed download | Interrupt APK update | Existing working extension remains |
| UPD-07 | Invalid signature/package | Repo serves unexpected APK | Update rejected |
| UPD-08 | Breaking source change | New version removes/changes source | App reports unavailable/migration condition instead of silently remapping |
| UPD-09 | Update while offline | Airplane mode | Existing version continues functioning for local content |
| UPD-10 | App restart after update | Kill/relaunch | Updated extension loads correctly |

## I. Persistence / lifecycle

| ID | Test | Procedure | Pass criteria |
|---|---|---|---|
| LIFE-01 | Background runtime | Background app during source request | No permanent runtime failure |
| LIFE-02 | Resume JVM | Return to app | Mihon runtime resumes/restarts automatically |
| LIFE-03 | Force quit | Kill app | No corruption |
| LIFE-04 | Device reboot | Reboot | Runtime initializes automatically when needed |
| LIFE-05 | Memory pressure | Open large chapter/many pages | App recovers without losing persistent state |
| LIFE-06 | Runtime crash | Force JVM bridge failure | UI surfaces failure and runtime can restart |
| LIFE-07 | Low storage | Download until storage is constrained | Graceful error; existing downloads safe |

## J. Real-extension compatibility gate

A controlled test extension should exist for deterministic headers/cookies/WebView/update testing, but
**MVP cannot be certified only against our fixture** (card T19 builds it).

Before release, run at least **20 real current Mihon/Komikku extensions**.

Required coverage:

| Extension class | Minimum | Pinned in `docs/test-matrix.json` |
|---|---:|---|
| Basic HTML/Jsoup source | 3 | 11 |
| JSON/API source | 3 | 3 |
| Complex filters | 2 | 3 |
| Extension preferences | 2 | 5 |
| Authentication/cookies | 2 | 5 |
| WebView login/challenge | 2 | 3 |
| Custom image headers | 2 | 3 |
| Multi-source APK | 2 | 5 |
| Different languages | 2 | 5 |
| Historically troublesome/complex source | 2 | 6 |

An extension may satisfy multiple categories; the pinned set is **25 distinct APKs** (all ≥19 source ids
carried verbatim). `npm run matrix:check` prints this coverage and fails if any class falls under its
minimum, or if a pinned package/APK/source id disappears.

Record for each:

```text
Extension/package
Version
Source ID
Install ✓/✗
Popular ✓/✗
Search ✓/✗
Details ✓/✗
Chapters ✓/✗
Pages ✓/✗
Headers ✓/✗
Cookies ✓/✗
WebView if applicable ✓/✗
Download ✓/✗
Offline read ✓/✗
Update ✓/✗
Notes
```

### Pinned set (25)

| # | Extension | Package | Sources | Classes |
|---|---|---|---|---|
| 1 | MangaDex | `…all.mangadex` | 61 | json, multi-source, complex, languages |
| 2 | Manga Million | `…all.mangamillion` | 108 | multi-source, complex |
| 3 | XCOMIC | `…all.xcomic` | 77 | multi-source, html |
| 4 | MangaFire | `…all.mangafire` | 7 | multi-source, webview, complex |
| 5 | GlobalComix | `…all.globalcomix` | 37 | json, multi-source |
| 6 | Atsumaru | `…en.atsumaru` | 1 | json, html |
| 7 | MangaPill | `…en.mangapill` | 1 | html |
| 8 | Asura Scans | `…en.asurascans` | 1 | html |
| 9 | Weeb Central | `…en.weebcentral` | 1 | html |
| 10 | Toonily | `…en.toonily` | 1 | html, auth |
| 11 | Komix | `…en.komix` | 1 | filters, html |
| 12 | Qi Scans | `…en.qiscans` | 1 | filters, html |
| 13 | Mangabz | `…zh.mangabz` | 1 | filters, preferences, auth, languages |
| 14 | Coolmic | `…en.coolmic` | 1 | preferences, auth |
| 15 | J-Novel | `…en.jnovel` | 1 | preferences |
| 16 | Voyce.Me | `…en.voyceme` | 1 | preferences |
| 17 | Dynasty Scans | `…es.dynasty` | 1 | html, languages |
| 18 | InfinityScans | `…en.infinityscans` | 1 | webview, complex |
| 19 | Scythe Scans | `…en.erosscans` | 1 | complex |
| 20 | Comix | `…en.comix` | 1 | webview, complex |
| 21 | emaqi | `…en.emaqi` | 1 | auth |
| 22 | vomic | `…zh.vomic` | 1 | auth, preferences, languages |
| 23 | Manhua Plus | `…en.manhuaplus` | 1 | image-headers, html |
| 24 | Zinmanga.net | `…en.zinmanganet` | 1 | image-headers, html |
| 25 | CuuTruyen | `…vi.cuutruyen` | 1 | image-headers, languages |

Traits come from the extensions' own code (`keiyoushi/extensions-source`: DTO/JSON deserialisers,
`PreferenceScreen`, `addCookie`, `override fun headers`, `getFilterList`, `imageRequest`,
`WebviewInterceptor`, Cloudflare/captcha references) and from the index's `sources` array.

---

## MVP release gates

The standalone iPhone build is **not MVP-ready** unless all of these are true:

1. **EXT, HTTP, WEB, OFF, BAK and UPD hard-gate tests pass on a physical iPhone.**
2. At least **20 real Mihon/Komikku extensions** complete the compatibility matrix with no systemic failures.
3. A user can install the IPA onto an empty iPhone and reach:

```text
Repo
→ APK install
→ search
→ manga
→ chapters
→ pages
→ download
→ airplane mode
→ read
→ restart
→ continue reading
```

4. No self-hosted server, Suwayomi, Komga, desktop helper or LAN connection is involved.
5. Backup restore can reconstruct the usable library after deleting/resetting local app data.
6. A failed extension/update/network operation cannot destroy the local library.

## Single final acceptance scenario

Use this as the last release test:

```text
Fresh install on physical iPhone
        ↓
Add Mihon repository
        ↓
Install three different APK extensions
        ↓
Change one extension preference
        ↓
Use WebView login on one authenticated source
        ↓
Search and add three manga
        ↓
Put them in two categories
        ↓
Download several chapters
        ↓
Read one chapter halfway
        ↓
Create backup
        ↓
Force quit + reboot phone
        ↓
Enable airplane mode
        ↓
Launch app
        ↓
Library/categories/history intact
        ↓
Open downloaded chapter
        ↓
Resume at saved page
        ↓
Finish chapter
        ↓
Force quit/relaunch still offline
        ↓
Read state remains
        ↓
Disable airplane mode
        ↓
Extension cookies/login still valid
        ↓
Update one extension
        ↓
Library/preferences remain intact
        ↓
Reset app data
        ↓
Restore backup
        ↓
Reinstall/connect any missing extension
        ↓
Library/categories/progress/source mappings restored
```

If that entire chain succeeds on a physical iPhone, the standalone MVP has met the core goal.

---

## Recording a run

One file per run: `docs/runs/YYYY-MM-DD-ios-<device>.json` plus a short markdown summary beside it.
Statuses: `pass` | `fail` | `blocked: source-side` | `blocked: app` | `skipped`. A `pass` carries the
observation, not the intention. Every extension row carries per-call timings — the runtime is an
interpreter with no JIT, so a 2 s call on Android can be 20 s here; any call over 10 s or any watchdog
kill is a finding even when the row passes.

## Maintenance

```bash
npm run matrix:check   # packages present, APKs reachable, source ids stable, class coverage ≥ minimum
```

Version drift is a note. A **missing package**, an **unreachable APK** or a **lost source id** is a
failure and the row must be replaced with another extension covering the same class, in the same commit
that updates the table above. Update `docs/test-matrix.json` and this file together.

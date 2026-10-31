# HardlyTracking — App Store release checklist

The target is the smallest change set that satisfies the current 4.7 plug-in rules, not a
permission framework. Paperback (16+, "Unrestricted Web Access", TypeScript extension API, on the
store today) is the precedent for the architecture; what it does not prove is OpenJDK executing
Mihon APK bytecode rather than JavaScript — see **Risk** at the bottom.

**Not building** (dropped deliberately, do not re-add without a review reason): a `softwareGrants`
or `softwareBlocks` table, per-cookie permission prompts, an APK `.so` scanner, a capability-policy
framework, a signing-key trust UI, a Supabase report backend, a marketplace/software database, or a
reading-history consent prompt.

## Where it stands

| # | Item | State today |
|---|---|---|
| 1 | Repo add needs a confirmation step | **Done** — `?repo=…` and the URL field both open a confirmation panel (name, host, ecosystem, package count, the third-party line) and the repo store is written only by Add Repository (`src/lib/extensions/proposal.ts`, `tests/unit/repo-confirm.test.mjs`) |
| 2 | Restricted / Mature / Adult content levels | **Partly** — ratings are parsed (`contentWarningOf`: SAFE/MIXED/NSFW/UNKNOWN) and shown, but no setting, no filtering, no age step |
| 3 | Per-source cookie consent | **Not done** — login is user-initiated and the jar is per-domain, but nothing is asked or remembered |
| 4 | Software detail route + universal link | **Done in the tree** — `#/software/<pkg>` and `#/software/<repo>/<pkg>`, canonical `https://hardlytracking.app/source?repo=…&id=…`, the entitlement and the association file. See §4. The device half (a tap on the link opening the app) needs the iPhone and the host that serves `hardlytracking.app` |
| 5 | Report Source | **Not done** |
| 6 | Runtime boundary | **Done** — recorded in `docs/runtime-boundary.md`; the test `tests/unit/runtime-boundary.test.mjs` ("a downloaded extension reaches no native API") passes |
| 7 | iOS networking | **Done in the tree** — `NSAllowsArbitraryLoads` is gone; `NSAllowsLocalNetworking` plus loopback and private-range `NSExceptionDomains`, pinned by `tests/unit/ios-ats.test.mjs`. The device half needs the iPhone |
| 8 | iOS project hygiene | **Done in the tree** — `UIBackgroundModes` and `armv7` gone, `IPHONEOS_DEPLOYMENT_TARGET = 15.0` everywhere, `PrivacyInfo.xcprivacy` in the app target, all pinned by `tests/unit/ios-hygiene.test.mjs`; the archive and the device half need his hand (§8) |
| 9 | Billing on iOS | **Done** — decided not sold in v1: a store build has no shop at all (`shopOf` → `none`, `checkout()` refuses), so nothing on iOS reaches the Stripe Checkout that web and desktop keep |

---

## 1. Repository add is a decision, never a side effect — done

- [x] `Extensions.svelte`: remove the automatic `addRepository()` on a passed-in `pendingRepo`; keep the prefill
- [x] Load the index into a **confirmation panel**: repo name, host, ecosystem (Mihon/Aidoku/Paperback), package count, and the line "Third-party sources from this repository are not maintained by HardlyTracking."
- [x] Two actions only: **Cancel** / **Add Repository**
- [x] Manual URL entry ends at the same panel — typing a URL and pressing the button inspects, it does not add
- [x] Nothing installs from a repo without a separate tap on that package
- [x] Fresh install ships with **zero third-party repositories**

*Done when:* `?repo=…` opens the panel and the repo store is unchanged until "Add Repository"; a test
pins it (`repo deep link cannot silently add`, `tests/unit/repo-confirm.test.mjs`). The link reads the
index into a `RepoProposal` and stores nothing; the panel's own button is the only call to
`addRepository()`, and it hands over the index it already read. Verified at 440×956 against the live
Keiyoushi index: panel open with 0 repos stored, Cancel keeps 0, Add Repository writes 1 and opens
Available with 1 443 extensions.

## 2. Content levels — blocker

- [ ] `settings.svelte.ts`: `contentLevel: "restricted" | "mature" | "adult"`, default `restricted`
- [ ] Map the parsed rating onto the level: `SAFE`→restricted, `MIXED`→mature, `NSFW`→adult, `UNKNOWN`→restricted until declared
- [ ] Filter repo entries, installed extensions, Browse sources, and global search by the level
- [ ] Adult requires one declaration: "Enable adult sources? [Cancel] [I am 18 or older]" — remembered, revocable in Settings
- [ ] Keep the visible `18+` / `Mature` label on rows and source chips

*Done when:* with the default setting an adult package is not listed and cannot be installed, even
from a direct detail link; enabling adult is the only way in.

## 3. One consent per source and domain — blocker

- [ ] Before the first cookie hand-off for a source, ask once: "Allow <source> to use your login for <domain>?" — **Cancel** / **Allow**
- [ ] Remember the grant by `sourceId + domain` (one small pref map; not a grants database)
- [ ] Never ask again for an approved pair; never prompt merely because a cookie is used
- [ ] Cookies stay per source/domain in the existing jar (`src/lib/webview/store.ts`); one source's cookies never ride another source's call
- [ ] Drop the grant when the source is uninstalled or disabled

*Done when:* a fresh source's first login asks; the second login does not; uninstalling clears it.

## 4. A detail page for every package, reachable by link — blocker

- [ ] Route `#/software/<pkg>` (or `#/software/<repo>/<pkg>` when two repos publish the same id)
- [ ] Show name, ecosystem, version, repository, languages, content rating, its sources, and installed/enabled state
- [ ] Actions: Install / Update / Disable / Uninstall — nothing automatic on open
- [ ] Extensions rows link into it; the Extensions list stays the index
- [ ] Canonical web link `https://hardlytracking.app/source?repo=…&id=…` that opens the same page
- [ ] iOS: Associated Domains entitlement + `apple-app-site-association` on that host
- [ ] Test the four cases: app installed, app not installed (web fallback), malformed repo, package removed upstream

*Done when:* the link opens the detail page on a device with the app and on one without, and never
installs anything by itself.

## 5. Report Source — blocker (light)

- [ ] "Report Source" in the extension/source overflow menu
- [ ] Opens `https://hardlytracking.app/report?repo=…&id=…&version=…&reason=…` (or a contact form) with the repo URL, package/source id, version, reason, optional note
- [ ] Send nothing else: no library, history, cookies, or account data
- [ ] Immediate removal stays where it already is: Disable / Uninstall

*Done when:* the menu item opens a prefilled report and the payload is exactly those fields.

## 6. The runtime boundary — verify and record, do not rebuild

- [x] Confirm what a loaded extension can reach through `/dalvik`: HTTP, source cookies, source preferences/state, WebView login, manga/chapter/page calls — and nothing else
- [x] Confirm no path from extension code to a Capacitor plugin, the app's SQLite, Photos, Contacts, Location or Notifications
- [x] Keep the chain as it is: APK → OpenJDK Zero → M-Extension-Server → `/dalvik` methods → app
- [x] Same rule for any future Aidoku/Paperback/Suwatte execution: limited host, no native surface

*Done when:* a written answer per bullet in `docs/` with the file or call that proves it, and the
compliance test below passes.

**Recorded in `docs/runtime-boundary.md`** — one answer per bullet with the file and call that proves
it, the honest limits (no per-extension sandbox in the JVM; in-process on iOS), and a live probe
against the real host. The compliance test is `tests/unit/runtime-boundary.test.mjs`; it pins the
twelve-method surface, that a full provider session sends only `POST {base}/dalvik`, that the provider
chain imports no native or database module, that the one native plugin is four control calls, that no
privacy plugin or usage description exists, and that no extension-supplied string is ever evaluated.

## 7. iOS networking — blocker

- [x] Replace `NSAllowsArbitraryLoads = true` with the narrow exceptions actually needed
- [x] Keep plain HTTP working for the loopback runtime, Komga and HT-Server (`NSAllowsLocalNetworking` / scoped `NSExceptionDomains`)
- [x] Confirm remote HTTP sources still work through the runtime/proxy path rather than through ATS
- [x] Keep `NSLocalNetworkUsageDescription` accurate

*Done when:* the plist has no blanket allow, and a device can still reach the desktop host, Komga, and
a plain-HTTP source. The plist half is done and pinned by a test; the device half needs the iPhone
from the smoke test below and has not been observed.

### What the plist now says

`ios/App/App/Info.plist` carries `NSAllowsLocalNetworking = true` and an `NSExceptionDomains` of
loopback and private ranges only: `localhost`, `127.0.0.1`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`,
`192.168.0.0/16`, `100.64.0.0/10` (tailnet IPv4) and `fd7a:115c:a1e0::/48` (tailnet IPv6). No
`NSAllowsArbitraryLoads`, no media or web-content variant, and no public host name.

Those ranges and not a domain list because Komga's and the HT-Server's addresses are the user's own,
typed onto a card — they are IP literals, not names. Apple's documentation for
`NSAllowsLocalNetworking` is explicit that from iOS 17 ATS no longer allows connections to IP
addresses by default and that the fix is an individual address or CIDR range in `NSExceptionDomains`;
on iOS 15–16 those connections are already allowed, so the ranges are inert there and one plist covers
both. A PC paired by name (`mypc.local`, `mypc`) is what `NSAllowsLocalNetworking` is for.

`tests/unit/ios-ats.test.mjs` (6 tests) reads the real plist and fails if a blanket allow comes back,
if an exception names anything that is not loopback or a private range, if an exception grants more
than insecure HTTP, or if the prompt string stops naming Komga and the PC.

### Why a plain-HTTP source still works — the path, not ATS

ATS governs the URL Loading System (`URLSession` and what sits on it). It does not govern a JVM's own
sockets, and the extension is the thing that talks to a source.

| what | who makes the request | ATS |
|---|---|---|
| `/dalvik` calls to the on-device runtime | `CapacitorHttp` → URLSession → `http://127.0.0.1:8747` | yes — loopback entry (`src/lib/mihon-runtime.ts`: `NATIVE_RUNTIME_PORT`, `nativeRuntimeBase()`) |
| a source's own HTTP, cookies, redirects | the extension, inside the JVM (`MExtensionServer` → Java HTTP) | **no** — `docs/ios-embedded-runtime.md` |
| page images from a dalvik source | the runtime mints `/image/<uuid>`, loaded over loopback | yes — loopback entry (`src/api/dalvik.ts`) |
| Komga REST and page images | the `komga` provider's `fetch` at the user's `baseUrl` | yes — private-range entry (`src/api/komga.ts`) |
| HT-Server REST | `htServerRoot()` on the paired PC | yes — private-range entry (`src/api/htserver.ts`) |
| repository indexes and APKs | `raw.githubusercontent.com` / `objects.githubusercontent.com`, https | no exception needed |
| Internet Archive | `archive.org`, https | no exception needed |

Two shapes this plist deliberately does not cover, both of which must be answered with a narrower
mechanism than a wider allow:

- **A page image on a public plain-HTTP host that also needs headers.** `pageSrc()` fetches those
  bytes itself through `imageCache.resolve` when there is no local proxy (`src/lib/pages.ts`), and that
  fetch is URLSession's. The answer for such a source is the runtime's own image proxy, not an ATS
  entry for a public host.
- **A login page served over plain HTTP in the extension webview.** The iOS `WebviewLogin` plugin is
  not built yet; when it is, a webview-only exemption (`NSAllowsArbitraryLoadsInWebContent`) with its
  own review justification is the tool. Do not add it before a source needs it.

`NSLocalNetworkUsageDescription` now names both reasons for the prompt: "HardlyTracking connects to
your Komga server and to the PC running HardlyTracking on your local network." There is no
`NSBonjourServices` entry because nothing browses for services — the user types an address.

## 8. iOS project hygiene — blocker

- [x] Remove `UIBackgroundModes → fetch` unless a feature uses it — nothing fetches in the
      background. The download queue only runs while the app does; there is no `BackgroundFetch`,
      `BGTaskScheduler` or `backgroundFetch` call anywhere in the tree.
- [x] Remove the stale `armv7` device capability — the whole `UIRequiredDeviceCapabilities` key is
      gone, not just the entry. No armv7 device can run iOS 15, so the deployment target is the
      capability.
- [x] Raise `IPHONEOS_DEPLOYMENT_TARGET` from 14.0 to **15.0** — all four build configurations in
      `project.pbxproj`, `ios/App/Podfile` (`platform :ios, '15.0'`) and
      `plugins/mihon-runtime/MihonRuntime.podspec`. The podspec matters: one of the three left at
      14.0 is a pod whose target is older than the app's.
- [ ] Archive on the current required Xcode/iOS SDK — **the workflow does it, the run is unobserved.**
      `.github/workflows/ios-ipa.yml` now selects the newest non-beta Xcode on the runner, refuses an
      `iphoneos` SDK below 18.0, and checks the archive rather than the source tree. It is
      `workflow_dispatch` only and this workstation has no `gh` and no GitHub token, so the run needs
      his hand: `gh workflow run ios-ipa.yml --ref master`.
- [x] Add `ios/App/App/PrivacyInfo.xcprivacy` to the app target and declare the required-reason APIs
      actually used — see below for what each one is and the call that proves it.
- [ ] Xcode privacy report shows no unexplained entries — needs the archive above; the manifest is
      the input to that report, not the report.
- [ ] Physical-device run after the target change: embedded JVM starts, `/capabilities` answers, a
      chapter reads — needs the iPhone on the desk (T13 runs the matrix). Nothing in this change can
      be proven by a simulator: the framework is device-arch only.

*Done when:* the archive validates and the device smoke test below passes on the new target.

### What the manifest declares, and the call that proves it

`ios/App/App/PrivacyInfo.xcprivacy` is a member of the app target's Resources phase (a file in the
group but not in the target builds into nothing and still fails upload), `NSPrivacyTracking` is
false, and no collected data is declared — the optional paid sync's collection is an App Store
Connect answer, which is the authoritative place for an app's collected data.

| category | reason | the call |
|---|---|---|
| `NSPrivacyAccessedAPICategoryUserDefaults` | `CA92.1` | Capacitor's `KeyValueStore.standard` — `AppUUID` keeps `CapacitorAppUUID` there, `CapacitorStorage` is the webview's localStorage bridge |
| `NSPrivacyAccessedAPICategoryFileTimestamp` | `C617.1`, `3B52.1` | `C617.1`: the runtime's own state in `Library/Application Support/MihonExtensions` (`MihonRuntime.mm`) and the JVM/WebKit caches in the container. `3B52.1`: a CBZ tapped in Files or iCloud Drive, opened in place and read once (`src/lib/files/opened.ts`) |
| `NSPrivacyAccessedAPICategoryDiskSpace` | `85F4.1` | Settings → Storage draws "X used of Y this app may use" from `navigator.storage.estimate()` (`src/views/Settings.svelte`). Nothing checks free space before a write, so `E174.1` is deliberately **not** claimed |

`tests/unit/ios-hygiene.test.mjs` (7 tests) pins all of it: the four deployment-target lines plus
the Podfile and podspec, the absence of `UIBackgroundModes` and `armv7`, the manifest's membership
in the Resources phase, and the exact category → reason-code set against the codes Apple publishes
per category. The plist reader it shares with the ATS test lives in `tests/unit/plist.mjs`.

## 9. Billing — decided: the app-store build sells nothing

**Decision (A9).** Paid sync is post-launch — `README.md` says so, and KANBAN lists S4/S5/S7 (account,
billing service, entitlement gate) as unstarted. There is therefore no StoreKit product to offer in v1,
and no reason to build one to hide it. So the second branch is taken: **an app-store build has no shop.**

- [x] Web and desktop keep the Stripe Checkout in `SyncAccount.svelte`, unchanged
- [x] `shopOf("ios" | "android") === "none"`: no price is drawn and `SyncAccount.checkout()` throws
      `purchase_unavailable` **before** it reads a session or makes a request — the request cannot be made,
      which is stronger than a hidden button
- [x] On a store build the panel is absent until this device is signed in, so nothing invites a sale;
      a signed-in account still sees its row, because a web purchase is the same `cloudSync` row
- [x] The one host name the shop knows (`billing.hardlysleep.ing`) lives in `src/api/sync-account.ts`
      alone — no view names it
- [ ] **When paid sync ships in-app:** StoreKit for the iOS purchase, `Restore Purchases`, and both paths
      writing the same `cloudSync` entitlement. This unchecked box is the reminder, not a v1 blocker

*Done when:* no iOS surface links to Stripe checkout, and an Apple purchase and a web purchase unlock
the same row. The first half is done and pinned by `tests/unit/ios-billing.test.mjs` (9 assertions: the
policy, the refusal with zero `fetch` calls, the web path still selling, and the template guard). The
second half cannot be done before there is an Apple purchase, and by this decision there is none in v1.

One consequence to keep in mind for that later card: a signed-out iOS reader has no door to the panel,
because the panel exists to sell. When sync itself ships, its sign-in belongs to the sync feature, not to
this shop screen — the reader will already have that seam (`createSyncAccount`, same SDK, same
`signInWithOtp`).

## Compliance tests to add

```
fresh install contains no third-party repository
repo deep link opens the panel and cannot add on its own
a package cannot install without its own tap
an adult package is invisible until the age step is passed
a source's cookies are not handed over before the consent tap
a downloaded extension reaches no native API
a software detail link opens and installs nothing
Report Source opens with only repo, id, version, reason
ATS is not globally disabled                    # tests/unit/ios-ats.test.mjs
a store build cannot reach Checkout             # tests/unit/ios-billing.test.mjs
PrivacyInfo.xcprivacy exists in the built app
UIBackgroundModes does not declare an unused mode
```

`ATS is not globally disabled` is six assertions in `tests/unit/ios-ats.test.mjs`, run by `npm test`.
`a store build cannot reach Checkout` is nine in `tests/unit/ios-billing.test.mjs` — the same run.

## Physical iPhone smoke test

```
add repo (panel) → install source → login/WebView (consent asked once) → browse → search
→ read → download → kill app → relaunch → offline read → update source → uninstall source
→ restore a .tachibk backup → check the library, history and shelves survived
```

## Gate

Do not submit until **1–8** are done. 9 is decided and closed for v1: paid sync is post-launch, so the
app-store build ships with no shop at all (§9). Backup/restore polish can
continue after submission, but the current backup system must keep working.

Order: **repo confirmation → content levels → cookie consent → detail route and links → Report Source
→ iOS networking and project hygiene → billing if needed.**

## Risk

Apple allows plug-ins under 4.7 and is currently distributing Paperback, whose public description
advertises downloadable scripting. The part with no direct precedent is **embedded OpenJDK executing
Mihon APK bytecode**. No code change removes that uncertainty; the architecture above is the closest
fit to the rules, and the honest answer at review time is the `/dalvik` boundary documented in item 6.

## The disclosure this app publishes

4.7.2 asks that an app making third-party software available be clear that the software is not
the app. Paperback's wording is the model, and HardlyTracking now carries the same statement in two
places that cannot drift apart:

- `README.md` → **Third-party sources**: not developed or maintained by the HardlyTracking
  developers, no information provided about them, support goes to the publisher, and extension
  issues are closed here and pointed at the publisher.
- In the app → the Extensions screen, from `src/lib/extensions/disclosure.ts`
  (`THIRD_PARTY_DISCLOSURE`, `THIRD_PARTY_DECISION`), on every tab. The repository panel keeps the
  one-line `THIRD_PARTY_NOTICE` before **Add Repository**.
- `tests/unit/extensions-disclosure.test.mjs` pins both copies, so the README and the screen say
  the same three things.

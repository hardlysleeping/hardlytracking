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
| 1 | Repo add needs a confirmation step | **Not done** — a `?repo=` deep link calls `addRepository()` itself (`src/views/Extensions.svelte` `$effect` on `repo`) |
| 2 | Restricted / Mature / Adult content levels | **Partly** — ratings are parsed (`contentWarningOf`: SAFE/MIXED/NSFW/UNKNOWN) and shown, but no setting, no filtering, no age step |
| 3 | Per-source cookie consent | **Not done** — login is user-initiated and the jar is per-domain, but nothing is asked or remembered |
| 4 | Software detail route + universal link | **Not done** — routes are `#/<name>/<id>`; the Extensions list is the only entry point |
| 5 | Report Source | **Not done** |
| 6 | Runtime boundary | **Done in shape** — `/dalvik` is the only JVM bridge; verify and record, do not rebuild |
| 7 | iOS networking | **Not done** — `NSAllowsArbitraryLoads = true` in `ios/App/App/Info.plist` |
| 8 | iOS project hygiene | **Not done** — `UIBackgroundModes=fetch`, `armv7`, `IPHONEOS_DEPLOYMENT_TARGET = 14.0`, no `PrivacyInfo.xcprivacy`, no entitlements |
| 9 | Billing on iOS | **Decide** — sync unlocks through Stripe (`billing.hardlysleep.ing`); that cannot ship in-app |

---

## 1. Repository add is a decision, never a side effect — blocker

- [ ] `Extensions.svelte`: remove the automatic `addRepository()` on a passed-in `pendingRepo`; keep the prefill
- [ ] Load the index into a **confirmation panel**: repo name, host, ecosystem (Mihon/Aidoku/Paperback), package count, and the line "Third-party sources from this repository are not maintained by HardlyTracking."
- [ ] Two actions only: **Cancel** / **Add Repository**
- [ ] Manual URL entry ends at the same panel — typing a URL and pressing the button inspects, it does not add
- [ ] Nothing installs from a repo without a separate tap on that package
- [ ] Fresh install ships with **zero third-party repositories**

*Done when:* `?repo=…` opens the panel and the repo store is unchanged until "Add Repository"; a test
pins it (`repo deep link cannot silently add`).

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

- [ ] Confirm what a loaded extension can reach through `/dalvik`: HTTP, source cookies, source preferences/state, WebView login, manga/chapter/page calls — and nothing else
- [ ] Confirm no path from extension code to a Capacitor plugin, the app's SQLite, Photos, Contacts, Location or Notifications
- [ ] Keep the chain as it is: APK → OpenJDK Zero → M-Extension-Server → `/dalvik` methods → app
- [ ] Same rule for any future Aidoku/Paperback/Suwatte execution: limited host, no native surface

*Done when:* a written answer per bullet in `docs/` with the file or call that proves it, and the
compliance test below passes.

## 7. iOS networking — blocker

- [ ] Replace `NSAllowsArbitraryLoads = true` with the narrow exceptions actually needed
- [ ] Keep plain HTTP working for the loopback runtime, Komga and HT-Server (`NSAllowsLocalNetworking` / scoped `NSExceptionDomains`)
- [ ] Confirm remote HTTP sources still work through the runtime/proxy path rather than through ATS
- [ ] Keep `NSLocalNetworkUsageDescription` accurate

*Done when:* the plist has no blanket allow, and a device can still reach the desktop host, Komga, and
a plain-HTTP source.

## 8. iOS project hygiene — blocker

- [ ] Remove `UIBackgroundModes → fetch` unless a feature uses it
- [ ] Remove the stale `armv7` device capability
- [ ] Raise `IPHONEOS_DEPLOYMENT_TARGET` from 14.0 to the current baseline (15+)
- [ ] Archive on the current required Xcode/iOS SDK
- [ ] Add `ios/App/App/PrivacyInfo.xcprivacy` to the app target and declare the required-reason APIs actually used (UserDefaults, file timestamps, disk space, SQLite/storage) across Capacitor, WebKit, the embedded OpenJDK and Supabase
- [ ] Xcode privacy report shows no unexplained entries
- [ ] Physical-device run after the target change: embedded JVM starts, `/capabilities` answers, a chapter reads

*Done when:* the archive validates and the device smoke test below passes on the new target.

## 9. Billing — blocker only if paid sync ships

- [ ] If sync is sold in-app: StoreKit for the iOS purchase, Stripe left for web/desktop, `Restore Purchases`, and both paths writing the same `cloudSync` entitlement
- [ ] If sync is not shipping in v1: hide every purchase entry point on iOS

*Done when:* no iOS surface links to Stripe checkout, and an Apple purchase and a web purchase unlock
the same row.

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
ATS is not globally disabled
PrivacyInfo.xcprivacy exists in the built app
UIBackgroundModes does not declare an unused mode
```

## Physical iPhone smoke test

```
add repo (panel) → install source → login/WebView (consent asked once) → browse → search
→ read → download → kill app → relaunch → offline read → update source → uninstall source
→ restore a .tachibk backup → check the library, history and shelves survived
```

## Gate

Do not submit until **1–8** are done. 9 is required only if paid sync ships. Backup/restore polish can
continue after submission, but the current backup system must keep working.

Order: **repo confirmation → content levels → cookie consent → detail route and links → Report Source
→ iOS networking and project hygiene → billing if needed.**

## Risk

Apple allows plug-ins under 4.7 and is currently distributing Paperback, whose public description
advertises downloadable scripting. The part with no direct precedent is **embedded OpenJDK executing
Mihon APK bytecode**. No code change removes that uncertainty; the architecture above is the closest
fit to the rules, and the honest answer at review time is the `/dalvik` boundary documented in item 6.

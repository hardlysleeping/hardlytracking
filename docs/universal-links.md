# A package link: one address, two devices

`https://hardlytracking.app/source?repo=…&id=…` is the canonical address of a package page. Tapped on
a phone with the app, it opens the app; opened anywhere else, it loads the same page in a browser,
because the app is a static build and that host serves it.

Nothing about that address installs anything. It names a repository and a package; the page reads
that repository's index, shows what the package is, and every action on it — Install, Update,
Disable, Uninstall, Review repository — is a tap of its own. `tests/unit/software.test.mjs` pins it
(`a software detail link opens and installs nothing`).

## The three files that have to agree

| what | where | what it says |
|---|---|---|
| the host the link is written on | `src/lib/software.ts` → `SOFTWARE_SITE` | `https://hardlytracking.app` |
| the domain iOS may hand to the app | `ios/App/App/App.entitlements` | `applinks:hardlytracking.app` |
| the paths that are links, and for which app | `deploy/apple-app-site-association` | `/source`, `/source/*`, appID `TEAMID.ing.hardlysleep.hardlytracking` |

`tests/unit/universal-links.test.mjs` reads all three and fails if they drift: a different host in
the entitlement than in `SOFTWARE_SITE`, an appID that is not this bundle id, a canonical path the
association file does not claim, or a target that is not built with the entitlement file.

The entitlement is wired into both App build configurations (`CODE_SIGN_ENTITLEMENTS =
App/App.entitlements`) and the file is in the Xcode group, so it is visible and versioned rather than
being a build-setting someone remembers.

## What the host has to do

Two things, on whichever machine answers for `hardlytracking.app`:

1. **Serve the build for `/source`.** It is a client-side route; the file to return is `index.html`.
   `server/proxy.mjs` already does this (an extensionless path falls back to `index.html`), so a
   self-hosted build behaves the same as the real host.
2. **Serve the association file at `/.well-known/apple-app-site-association`** as
   `application/json`, at the root, **unauthenticated**, with no redirect. Apple fetches it
   anonymously and does not follow a redirect. `server/proxy.mjs` serves it from `deploy/` for that
   reason — the path is testable on this machine before any deploy.

## The one thing that needs the Apple account

`deploy/apple-app-site-association` carries `TEAMID.ing.hardlysleep.hardlytracking`. The Team ID is
ten characters from the Apple Developer account, and it is not in this repository because it is not
known here. Replace `TEAMID` when the app is signed, and enable the **Associated Domains** capability
for the App ID in the developer portal — a provisioning profile without it fails to sign a build that
carries this entitlement.

Until both are done, Apple rejects an appID it cannot resolve, so the failure is a link that opens in
the browser instead of the app: it never opens the wrong thing, and it never installs anything.

## Opening a link in the app

iOS does not load a page for a universal link — it launches the app at `capacitor://localhost` and
hands over the URL. So the app reads it twice, the way it reads a handed-over file
(`src/lib/files/opened.ts`): `App.getLaunchUrl()` for a cold start and the `appUrlOpen` event for a
warm one. Both live in `watchSoftwareLinks()` (`src/lib/software.ts`), which is inert off the packaged
shell, and both end at the same route the browser lands on.

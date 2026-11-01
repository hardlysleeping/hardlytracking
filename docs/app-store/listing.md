# App Store listing copy

The words that go into App Store Connect, and the reason each one is phrased the way it is. Kept in
the repo so a reviewer's copy, the README and the in-app first-run screen cannot drift apart.

Source of truth for the strategy: `~/.hermes/plans/2026-10-31_appstore-release.md` §0.

---

## Name and subtitle

| Field | Value | Notes |
|---|---|---|
| Name | `HardlyTracking` | 30-char limit; already the bundle display name. |
| Subtitle | `Your own comics, your servers` | 27 chars, under the 30 limit. Names both halves of the product without naming a site. |

## Description

> HardlyTracking does not include, host, stream or recommend any comics. It is a client: you point it
> at a server you run yourself (Komga or Suwayomi) with your own login, at DRM-free files you own on
> this device, or at the Internet Archive's public-domain and openly licensed scans. Nothing is
> preloaded, and there is no built-in catalogue of sites.
>
> **Read the comics you already own.** A CBZ, CBR or PDF you bought and downloaded opens straight from
> your phone's files — no server, no account, no network. Point it at a folder on your own cloud and
> it reads from there too.
>
> **Your own server, your own login.** Komga and Suwayomi are built in as sources: add the address you
> already use and sign in with the login you already have. Reading progress syncs both ways.
>
> **A real reader.** Vertical, paged, left-to-right and right-to-left; page fit, tap zones, keep-awake,
> margins; a library with categories, badges, filters and a continue-reading row that follows you.
>
> **Optional, and removable.** Third-party sources arrive only as repositories *you* add, and each one
> can be disabled or uninstalled. HardlyTracking ships none.
>
> No ads, no analytics, no account required to read.

## Keywords (100 chars)

```
comic reader,cbz,cbr,pdf,komga,suwayomi,local files,library,self hosted,offline
```

## Age rating

17+ if the extension host ships (user-added sources can carry adult material, and the app's own
content levels hide them by default at *Restricted* and *Mature*). Tachimanga sits at 16+ with the same
exposure; 17+ is the honest answer for a client whose sources the user chooses.

## Review notes

> HardlyTracking is a reading client. It contains no content and no source list.
>
> 1. Three sources ship with the app: this device's own files; the Internet Archive (a public library
>    of public-domain and openly licensed scans); and an optional server the user runs themselves
>    (Komga or Suwayomi), configured with the user's own address and login.
> 2. A user may add a third-party source repository URL that they supply themselves. The app does not
>    ship, embed, recommend or link to any repository, and holds no list of websites.
> 3. The optional extension runtime executes those user-installed source plugins in an interpreter;
>    no native code is downloaded, and it cannot change the app's own features. Precedent: Tachimanga
>    (id6447486175) and Suwatte (id6448855813) are on the store with the same model.
> 4. Reading works with no server at all: the Internet Archive source is usable on a fresh install,
>    and a public-domain CBZ can be opened from Files to exercise the local reader.
> 5. No analytics, no tracking, no account is required. The optional sync subscription is the only
>    paid feature and is bought through in-app purchase.

## What must never appear on the listing

- Any screenshot showing a real server address, hostname, tailnet name, file path, username, feed or
  category name of a real person, or a cover that carries a third party's site name.
- The words "manga" or "anime" as a *promise of a catalogue*: the app has no catalogue. "Comics" is
  the word, and every claim is about what the user brings.
- Any link to a repository, a wiki that lists them, or a QR code. §2.2 of the plan.

## Screenshots

`docs/app-store/screenshots/` — see the README there for what is captured, at which sizes, and what
is still blocked.

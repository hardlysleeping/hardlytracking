# What may ship inside the app, and what may not

HardlyTracking is a reader. It does not distribute manga, and it does not bundle anyone's catalogue.

## Never built in

**Content sources.** No manga, comic or webtoon source ships with this app. Not as a provider, not as
a bundled extension, not as a pre-filled repository. The user adds extension repositories (Keiyoushi
and the rest) or installs APKs themselves, exactly as they would in Mihon. This is a licensing rule,
not a preference: those sources are third-party code that carries its own terms, and an app that
ships them becomes a distributor of them.

The same applies to the indexes: the app may *read* a repository the user added, and it must never
pre-populate one.

## Allowed built-ins

Three kinds, and each is allowed for a stated reason:

| built-in | why it is allowed |
| --- | --- |
| **Locally hosted services** — Komga, Suwayomi | The user runs the server on their own machine. There is no third-party catalogue to distribute: the content is already theirs. |
| **Internet Archive** | Open, publicly documented API and public-domain / openly licensed material. Nothing is redistributed — the app reads archive.org's own endpoints. |
| **Our read server** | Our own code, hosted locally by the user. It is a transport between their devices, not a source of content. |

## How that shows up in the app

- Built-ins appear as extension cards with a **Built in** badge and a switch, and cannot be
  uninstalled — there is no APK to remove.
- `src/api/builtin.ts` holds that list. Adding a fourth entry is a legal decision before it is a code
  change: if it is a third-party content source, it does not belong there.
- The Mihon extension runtime (M-Extension-Server) is **infrastructure, not an extension**. It is a
  service the app talks to on `127.0.0.1:8792`; it has no card, no switch and nothing to uninstall,
  because it ships no content either — it executes APKs the user installed.

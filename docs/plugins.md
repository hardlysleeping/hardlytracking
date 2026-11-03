# Plugins

A plugin is a small program someone wrote for this app: a menu entry, a panel, a setting of its own.
It is not a comics source — those are **extensions** (`docs/builtins.md`) — and it cannot fetch
anything: a plugin runs sandboxed with the network switched off.

This document is the contract. A plugin author needs nothing else, and the app refuses anything that
does not follow it.

## A package is a ZIP

`something.htp` is a ZIP with `manifest.json` at its root:

```
manifest.json
entry.js
```

Limits, enforced before a byte is unpacked:

| Limit | Value |
| --- | --- |
| The `.htp` file | 10 MB |
| Everything extracted, summed | 30 MB |
| Entries | 200 |
| One file | 8 MB |
| One value in plugin storage | 256 KB, per plugin |

Refused, always: `..` in a path, an absolute path, a backslash, a Windows drive letter, a `.` path
segment, duplicate names, links (`.lnk`, `.symlink`), archive noise is dropped (`__MACOSX/`,
`.DS_Store`), and any executable-by-extension file (`.exe`, `.dll`, `.so`, `.dylib`, `.jar`, `.class`,
`.wasm`, `.node`, `.apk`, `.ipa`, `.pkg`, `.msi`, `.bat`, `.cmd`, `.com`, `.scr`). A plugin is
JavaScript.

## The manifest

```json
{
  "manifestVersion": 1,
  "id": "dev.example.reader-tools",
  "name": "Reader Tools",
  "version": "1.0.0",
  "apiVersion": 1,
  "minAppVersion": "0.5.8",
  "entry": "entry.js",
  "permissions": ["library.read", "plugin.storage", "ui.series"],
  "networkHosts": [],
  "contributes": {
    "seriesActions": [{ "id": "show-info", "title": "Show Extra Info" }]
  }
}
```

Two versions, and they mean different things:

- **`apiVersion`** is the host API the plugin was written against. This build implements `1`. A
  package asking for `2` is refused by name, not run against half a host.
- **`minAppVersion`** is the app's own floor. Compared by number: `0.5.10` is newer than `0.5.9`.

Also refused: an id that is not reverse-DNS lower-case, a version that is not semver, an `entry` that
is not a relative `.js` path, an unknown permission, a permission the platform cannot honour, and two
actions sharing one id. Refusals are reported whole — every problem in one answer.

### Permissions

| Permission | What it allows |
| --- | --- |
| `library.read` | Read the titles you have: id, title, cover, chapter counts, read counts |
| `plugin.storage` | Its own key/value space on this device |
| `ui.series` | Add an entry to a series page |
| `ui.reader` | Add an entry to the reader |
| `ui.library` | Add an entry to the library screen |
| `events.library` | Be told when a title is opened, added or removed |

A new permission is **not** inherited: an update that adds one asks the user before it is installed,
and an update the user declines leaves the previous version exactly as it was.

## The API

Everything is a method on `ht`, and everything is async except registration.

```js
ht.plugin.id;        // "dev.example.reader-tools"
ht.plugin.version;   // "1.0.0"

await ht.storage.get("key");        // your own value, or null
await ht.storage.set("key", value); // plain JSON, 256 KB per plugin
await ht.storage.delete("key");

await ht.library.getSeries(id);     // a summary, or null
await ht.library.query({            // [{ id, title, cover, author, description,
  search: "titans",                 //    chapterCount, readCount, categories, source, saved }]
  limit: 50,                        // capped at 200
  offset: 0,
});

await ht.ui.toast("Saved");
await ht.ui.confirm("Continue?");   // true / false — the app's own dialog
await ht.ui.openPanel("extra-info"); // the app decides where a panel goes

ht.actions.registerSeriesAction({ id: "show-info", title: "Show Extra Info", callback: run });
ht.actions.registerReaderAction({ ... });
ht.actions.registerLibraryAction({ ... });

ht.events.on("library.opened", (params) => { ... });
```

An action must have an `id` and a `title` that the **manifest already declares**: the manifest is what
the user granted, so an action it never named cannot appear in a menu.

A series summary is a data-transfer object, not the app's model: no history, no file paths, no remote
ids a plugin cannot use.

## What a plugin cannot do

The frame is `sandbox="allow-scripts"` with **no** `allow-same-origin`, so its origin is opaque:

- no `localStorage`, no cookies, no IndexedDB;
- `parent.document` throws `SecurityError` (verified live, see below);
- `fetch` fails — the document's CSP is
  `default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`;
- nothing is passed in: no token, no Supabase client, no Capacitor object, no database handle.

The host identifies a plugin by three things at once — a 128-bit channel generated per instance, the
plugin id, and the `WindowProxy` of the frame it created. A message failing any of the three is
dropped without an answer (the plugin sees a timeout, not a hint). Every call is rate limited, capped
at 64 KB, and has a 5-second deadline.

## What happens when things go wrong

| Event | Behaviour |
| --- | --- |
| A start that never says hello | Counted; three in a row switches the plugin off and puts back the last version that worked |
| A message that is not allowed | Dropped, logged to the host's diagnostics, never shown as a dialog |
| A call that does not answer | Abandoned after 5 s |
| Disable | Frame destroyed, actions unregistered, storage kept |
| Uninstall | Record, every package and its own storage removed |
| No network | Installed plugins keep working: their package is on the device, so nothing is fetched |

## The example

`examples/reader-tools/` is the reference plugin, and the acceptance test for the whole system.

```sh
npm run plugin:example                  # examples/reader-tools.htp
```

Install it under **More → Plugins → Install .htp**, then open a series page and tap **Show Extra
Info**.

Measured in the browser on 2026-11-02 (`tests/manual/plugin-probe.htp`, a probe that records what the
host answers):

```
storage   "ok"                          — plugin → host → IndexedDB round trip works
library   {"count":0}                   — the read-only API answers
network   "blocked: TypeError"          — CSP refuses fetch
parent    "blocked: SecurityError"      — opaque origin; no parent document
```

and after uninstall: `plugins 0, packages 0, storage 0` — nothing of it is left on the device.

## Building one

1. Write `manifest.json` and `entry.js`.
2. Zip them (any tool; the app unpacks with `fflate`).
3. Install the file, approve the permissions it asks for.
4. Ship the `.htp` yourself — there is no store yet; the community catalogue is the next phase and
   will re-validate every package on the server before publishing.

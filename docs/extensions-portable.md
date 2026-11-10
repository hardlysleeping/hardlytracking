# Portable extensions

Internet Archive, Komga and Suwayomi are becoming ordinary extensions: installed from one pinned
repository, versioned, updatable without a new IPA. This document is the contract for that layer.

Status: **the host is built and tested; the three ports are not.** Until a package exists, the native
providers in `src/api/{archive,komga,suwayomi}.ts` remain the sources — they are removed only after
their ports pass the parity harness (see `~/.hermes/plans/2026-11-08_141757-hardlytracking-portable-extensions.md`).

## What a package is

One ES module, served over https, default-exporting an object of methods:

```js
export default {
  async sources() { return [{ id: "lib:1", name: "Comics", lang: "en" }]; },
  async popular(sourceId, page, api) { … },
  async latest(sourceId, page, api) { … },
  async search(sourceId, query, page, filters, api) { … },
  async details(seriesId, api) { … },
  async chapters(seriesId, api) { … },
  async pages(chapterId, api) { … },
  async setRead(chapterId, read, page, api) { … },
  async filters(sourceId, api) { … },      // optional
  async readState(seriesId, api) { … },    // optional
}
```

A `sources()` row may declare `browseTabs: ["trending", "popular", "latest"]` to choose the listing
chips its page draws and their order; `trending(sourceId, page, api)` is optional and only drawn when
the package defines it. With no declaration a source keeps the host default, Popular then Latest —
which is all any source here shipped before Trending existed.

`api` is the last argument: `{ packageId, version, fetch }`. `api.fetch({url, method, headers, body})`
is the **only** way out — the host performs the request, applies cookies and tokens, and returns
`{status, ok, headers, text(), json(), bytes()}`. There is no `window`, no `document`, no plugin
access, no storage and no network inside the worker.

## Ids are the contract

A package works in its own native ids. The provider namespaces what comes back and strips what goes
down, so `komga:server1:series1` never becomes `komga:s1` because a port felt like it. Library rows,
read marks, page positions, downloads and sync documents are all keyed by those strings; the parity
harness diffs the native provider's output against the portable one on the same fixture.

`ownership`: a package that presents `kind: "komga"` or `"mihon"` is `ownsProgress: false` (the
server keeps progress and `readState` mirrors it); anything else is `true` (the library is ours).

## Manifest

```json
{
  "name": "Komga",
  "packageName": "org.hardlytracking.komga",
  "versionName": "1.0.0",
  "versionCode": 1,
  "runtime": "portable-js",
  "kind": "komga",
  "hostApi": 1,
  "resources": { "providerUrl": "extensions/komga/provider.js", "iconUrl": "extensions/komga/icon.png" },
  "sources": [{ "name": "Komga", "lang": "en" }]
}
```

Parsed by `src/lib/extensions/portable.ts`. Refusals are named, because they reach the Extensions
screen: a newer `hostApi` says both numbers; a non-https `providerUrl` says the scheme; an unknown
`kind` names the kind. One bad row is skipped, never the whole repository.

## Install and update

1. Fetch `providerUrl` (through `/api/repo` when a server is present, directly otherwise), cap 2 MB.
2. Start it in a worker and ask `sources()`. **Before** the row is written — a package that cannot
   answer leaves the working version installed.
3. Write `InstalledExtension` with `portable: { source, kind, hostApi }`; the text *is* the install,
   which is what makes an offline launch work.
4. An update replaces the row and swaps the live provider, closing the old worker.

`planUpdates` needs no change: a portable row has a `versionCode` and is not `builtin`, so "Check for
updates" compares it like any other extension.

## The pinned repository

`src/lib/extensions/pinned-repo.ts` seeds `hardlysleeping/hardlytracking-extensions` (branch `repo`)
before anything reads the repository list. The row carries `pinned: true`: `store.removeRepo` refuses
it, the Extensions screen shows **Official** instead of **Remove**, and a boot repairs a missing or
unpinned row without moving it. Its *extensions* stay removable — only the list is unmovable.

## The boundary rule

`tests/unit/runtime-boundary.test.mjs` holds two lines that must stay true:

- no `eval(` and no `new Function(` anywhere in `src/`;
- downloaded provider text becomes an ES module in exactly one file, `src/lib/extensions/worker/core.ts`,
  and the bootstrap next to it (`provider-worker.ts`) touches no `window`, no `document`, no Capacitor.

That is a deliberate narrowing of an older blanket rule ("extension text is never evaluated"). Running
downloaded code is the feature; running it through a string-to-code call is not, and a second module
loader anywhere needs a boundary review before it lands.

## Verified so far

- 1205 unit tests pass, `tsc --noEmit` clean.
- `vite build` emits `dist/assets/provider-worker-<hash>.js` as its own chunk, and the bundled app
  creates it with `new Worker(new URL("/assets/provider-worker-…js", import.meta.url))`.
- **Unverified:** that URL resolving inside the iOS bundle under `capacitor://localhost`, and a real
  `popular()` from a real package on a phone. That is the first device probe (plan task 6).

# Reader Tools — the example plugin

A `.htp` package is a ZIP with `manifest.json` at its root and a JavaScript entry file.

Build it:

```sh
npm run plugin:example      # writes examples/reader-tools.htp
```

Install it in the app (More → Plugins → Install .htp), then open any series page and look for
**Show Extra Info** in the sheet.

What it demonstrates, in the order an author meets them:

1. `contributes.seriesActions` in the manifest — the menu entry is declared, so the user's grant is
   what puts it on screen, and the host refuses an action the manifest never named.
2. `registerSeriesAction` at startup — the host draws it in the series sheet.
3. `ht.library.getSeries(id)` — a read-only summary (title, cover, chapter counts, read count), never
   the app's own model and never anything the plugin did not ask permission for.
4. `ht.storage.get/set` — its own key/value space, 256 KB, removed on uninstall.
5. `ht.ui.confirm` / `ht.ui.toast` / `ht.ui.openPanel` — the app's own dialogs, so a plugin never
   draws chrome that looks like the app but is not.

The plugin runs in an iframe with `sandbox="allow-scripts"` and no `allow-same-origin`: its origin is
opaque, it has no `localStorage`, no cookies, no `window.parent`, and a CSP that refuses every
network request. If you try to `fetch` in `entry.js`, it fails — that is the feature.

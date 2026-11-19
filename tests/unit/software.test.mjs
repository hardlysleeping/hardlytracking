/**
 * Checklist §4 — a detail page for every package, reachable by a link.
 *
 * The four cases the checklist names are four inputs to one pure function: a package that is
 * installed, one that is not (the web-fallback case), a repository URL that is malformed, and a
 * package the repository no longer carries. The last test is the compliance line —
 * "a software detail link opens and installs nothing" — pinned twice: the model is pure, and the
 * page's only automatic work is the index read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { parseRoute } from "../../src/lib/nav.ts";
import {
  SOFTWARE_SITE,
  canonicalSoftwareUrl,
  ratingLabel,
  repoRefusal,
  softwareFacts,
  softwareHref,
  softwareRefFromLocation,
} from "../../src/lib/software.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(repoRoot, path), "utf8");

const REPO = "https://raw.githubusercontent.com/keiyoushi/extensions/repo";
const OTHER_REPO = "https://example.invalid/other/repo";
const PKG = "eu.kanade.tachiyomi.extension.all.mangafire";

function entry(overrides = {}) {
  return {
    name: "MangaFire",
    pkg: PKG,
    version: "1.4.35",
    versionCode: 35,
    lib: "1.6",
    apkUrl: "https://example.invalid/mangafire.apk",
    contentWarning: "SAFE",
    sources: [
      { id: "2499283573021220255", name: "MangaFire", lang: "en" },
      { id: "42", name: "MangaFire ES", lang: "es" },
    ],
    ...overrides,
  };
}

function index(overrides = {}) {
  return {
    url: REPO,
    indexUrl: `${REPO}/index.min.json`,
    name: "Keiyoushi",
    extensions: [entry()],
    ...overrides,
  };
}

const addedRepo = { url: REPO, name: "Keiyoushi", indexUrl: `${REPO}/index.min.json` };

function installedRow(overrides = {}) {
  return {
    packageId: PKG,
    name: "MangaFire",
    versionName: "1.4.35",
    versionCode: 35,
    enabled: true,
    repoUrl: REPO,
    sources: [{ id: "2499283573021220255", name: "MangaFire", lang: "en" }],
    ...overrides,
  };
}

// ---- the route and the link --------------------------------------------------

test("a package page has a route, with and without a repository", () => {
  assert.deepEqual(parseRoute(`#/${softwareHref({ pkg: PKG, repo: null })}`), {
    name: "software",
    id: PKG,
    chapterId: null,
    repo: null,
  });
  const withRepo = parseRoute(`#/${softwareHref({ pkg: PKG, repo: REPO })}`);
  assert.deepEqual(withRepo, { name: "software", id: PKG, chapterId: null, repo: REPO });
  // A repository URL holds slashes; they are escaped, so the route stays three segments.
  assert.equal(softwareHref({ pkg: PKG, repo: REPO }).split("/").length, 3);
});

test("the canonical link is one address, and it round-trips", () => {
  const ref = { pkg: PKG, repo: REPO };
  const url = canonicalSoftwareUrl(ref);
  assert.ok(url.startsWith(`${SOFTWARE_SITE}/source?`), "the host and the path are the checklist's");
  assert.match(url, /repo=https%3A%2F%2Fraw\.githubusercontent\.com/);
  assert.match(url, new RegExp(`id=${PKG.replace(/\./g, "\\.")}`));
  assert.deepEqual(softwareRefFromLocation(url), ref);

  const bare = canonicalSoftwareUrl({ pkg: PKG, repo: null });
  assert.ok(!bare.includes("repo="), "no repository is not an empty repository");
  assert.deepEqual(softwareRefFromLocation(bare), { pkg: PKG, repo: null });
});

test("only a package page is a package page", () => {
  assert.equal(softwareRefFromLocation(`${SOFTWARE_SITE}/`), null);
  assert.equal(softwareRefFromLocation(`${SOFTWARE_SITE}/source`), null, "no id, no package");
  assert.equal(softwareRefFromLocation(`${SOFTWARE_SITE}/report?repo=x&id=${PKG}`), null);
  // A repository install link carries `repo` and nothing else: it must not be read as a package.
  assert.equal(softwareRefFromLocation(`${SOFTWARE_SITE}/?repo=${encodeURIComponent(REPO)}`), null);
  assert.equal(softwareRefFromLocation("not a url"), null);
  assert.equal(softwareRefFromLocation(""), null);
});

// ---- what the page says ------------------------------------------------------

test("an installed package shows what it is and offers the two destructive-free actions", () => {
  const facts = softwareFacts({
    ref: { pkg: PKG, repo: REPO },
    index: index(),
    repos: [addedRepo],
    installed: [installedRow()],
  });

  assert.equal(facts.name, "MangaFire");
  assert.equal(facts.version, "1.4.35");
  assert.equal(facts.state, "installed");
  assert.equal(facts.ecosystem, "Mihon / Keiyoushi · APK extensions");
  assert.deepEqual(facts.repository, { name: "Keiyoushi", url: REPO, host: "raw.githubusercontent.com" });
  assert.deepEqual(facts.languages, ["en", "es"]);
  assert.equal(facts.warning, "SAFE");
  assert.equal(facts.rating, "Safe");
  assert.equal(facts.sources.length, 2);
  assert.deepEqual(facts.actions, ["disable", "uninstall"]);
  assert.equal(facts.repoAdded, true);
  assert.equal(facts.upstreamRemoved, false);
});

test("a package that is not installed is installable only from a repository the app has added", () => {
  const added = softwareFacts({ ref: { pkg: PKG, repo: REPO }, index: index(), repos: [addedRepo], installed: [] });
  assert.equal(added.state, "not-installed");
  assert.deepEqual(added.actions, ["install"]);

  // The web-fallback case: a link names a package and a repository this device never added. The
  // page describes it; installing is not offered, because installing would mean adding the
  // repository first, and a link does not get to do that.
  const notAdded = softwareFacts({ ref: { pkg: PKG, repo: OTHER_REPO }, index: index({ url: OTHER_REPO }), repos: [], installed: [] });
  assert.equal(notAdded.state, "not-installed");
  assert.equal(notAdded.repoAdded, false);
  assert.deepEqual(notAdded.actions, []);
  assert.equal(notAdded.repository?.url, OTHER_REPO, "the page still says who publishes it");
});

test("a newer version in the index is an Update, not a silent replacement", () => {
  const facts = softwareFacts({
    ref: { pkg: PKG, repo: REPO },
    index: index({ extensions: [entry({ version: "1.4.40", versionCode: 40 })] }),
    repos: [addedRepo],
    installed: [installedRow()],
  });
  assert.equal(facts.updateAvailable, true);
  assert.equal(facts.installedVersion, "1.4.35");
  assert.equal(facts.availableVersion, "1.4.40");
  assert.deepEqual(facts.actions, ["update", "disable", "uninstall"]);
});

test("a disabled package offers Enable, and a built-in offers no Uninstall", () => {
  const disabled = softwareFacts({
    ref: { pkg: PKG, repo: REPO },
    index: index(),
    repos: [addedRepo],
    installed: [installedRow({ enabled: false })],
  });
  assert.equal(disabled.state, "disabled");
  assert.deepEqual(disabled.actions, ["enable", "uninstall"]);

  const builtin = softwareFacts({
    ref: { pkg: "builtin:komga", repo: null },
    index: null,
    repos: [],
    installed: [{ packageId: "builtin:komga", name: "Komga", versionName: "1.0.0", builtin: true, enabled: true, sources: [] }],
  });
  assert.equal(builtin.builtin, true);
  assert.deepEqual(builtin.actions, ["disable"], "an APK that ships in the app has nothing to uninstall");
});

test("a package the repository dropped still opens, and an installed copy stays removable", () => {
  const gone = index({ extensions: [entry({ pkg: "eu.kanade.tachiyomi.extension.all.somethingelse" })] });
  const facts = softwareFacts({ ref: { pkg: PKG, repo: REPO }, index: gone, repos: [addedRepo], installed: [installedRow()] });
  assert.equal(facts.upstreamRemoved, true);
  assert.equal(facts.availableVersion, null);
  assert.equal(facts.name, "MangaFire", "the installed row still knows the name");
  assert.deepEqual(facts.actions, ["disable", "uninstall"]);

  const notInstalled = softwareFacts({ ref: { pkg: PKG, repo: REPO }, index: gone, repos: [addedRepo], installed: [] });
  assert.equal(notInstalled.upstreamRemoved, true);
  assert.deepEqual(notInstalled.actions, []);
});

test("a repository that could not be read still produces a page", () => {
  const facts = softwareFacts({ ref: { pkg: PKG, repo: "https://example.invalid/nope" }, index: null, repos: [], installed: [] });
  assert.equal(facts.name, "Mangafire", "the package id is all that is left, and it is enough");
  assert.equal(facts.repository?.host, "example.invalid");
  assert.equal(facts.ecosystem, "Extension repository");
  assert.deepEqual(facts.actions, []);
});

test("ratings read as words, and a malformed repository is refused before it is fetched", () => {
  assert.equal(ratingLabel("SAFE"), "Safe");
  assert.equal(ratingLabel("MIXED"), "Mature");
  assert.equal(ratingLabel("NSFW"), "18+");
  assert.equal(ratingLabel("UNKNOWN"), "Unrated");
  assert.equal(ratingLabel("WHATEVER"), "Unrated");

  assert.equal(repoRefusal(null), null);
  assert.equal(repoRefusal(REPO), null);
  assert.match(repoRefusal("javascript:alert(1)") ?? "", /not an http\(s\) address/);
  assert.match(repoRefusal("file:///etc/passwd") ?? "", /not an http\(s\) address/);
  assert.match(repoRefusal("not a url") ?? "", /not an http\(s\) address/);
});

test("the model is pure: same input, same answer, input untouched", () => {
  const input = {
    ref: { pkg: PKG, repo: REPO },
    index: index(),
    repos: [addedRepo],
    installed: [installedRow()],
  };
  const snapshot = JSON.stringify(input);
  const first = softwareFacts(input);
  const second = softwareFacts(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), snapshot, "reading a page must not change what it read");
});

// ---- the compliance line: a link opens, and installs nothing ------------------

test("a software detail link opens and installs nothing", () => {
  const model = read("src/lib/software.ts");
  const view = read("src/views/Software.svelte");
  // Comments may name the things this module refuses to do; the code is what is checked.
  const code = model.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  // The model knows no write at all: no store, no library, no install.
  for (const write of ["addRepository", "installEntry", "installApk", "uninstallExtension", "setExtensionEnabled"]) {
    assert.ok(!code.includes(write), `src/lib/software.ts must not reach ${write}`);
  }

  // The page has exactly one automatic block, and it is the index read.
  const start = view.indexOf("$effect(");
  assert.ok(start >= 0, "the loader runs on open");
  const end = view.indexOf("});", start);
  const automatic = view.slice(start, end);
  assert.match(automatic, /void load\(\)/);
  for (const write of ["installEntry", "addRepository", "uninstallExtension", "setExtensionEnabled", "installApk", "installOnHost"]) {
    assert.ok(!automatic.includes(write), `${write} must never run on open`);
  }
  assert.equal(view.indexOf("$effect(", start + 1), -1, "one effect, so one thing happens on open");

  // Every action the page offers is reached from a tap: the only call sites are onclick handlers.
  const template = view.slice(view.indexOf("</script>"));
  for (const action of ["install", "update", "toggle", "uninstall"]) {
    const calls = template.split("\n").filter((line) => line.includes(`void ${action}()`));
    assert.ok(calls.length > 0, `${action} has a button`);
    for (const line of calls) assert.match(line, /onclick=/, `${action} is only ever a tap`);
  }
});

test("a link that opens a first run is not replaced by the welcome screen", () => {
  // The welcome sits above every route, so a first launch opened by a package link showed three
  // doors instead — and every door navigates away from the page the link named. The gate asks
  // whether this launch arrived from a link, and the answer is read before the first render (the
  // URL is rewritten to `#/software/…` in `onMount`).
  const app = read("src/App.svelte");
  assert.match(
    app,
    /\{#if settings\.ready && !settings\.welcomed && !arrivedByLink\}/,
    "the welcome gate ignores how the app was opened",
  );
  const start = app.indexOf("const arrivedByLink");
  assert.ok(start >= 0, "nothing decides whether this launch came from a link");
  const end = app.indexOf("onMount(", start);
  const decision = app.slice(start, end);
  assert.match(decision, /softwareRefFromLocation\(location\.href\)/, "a package link does not count");
  assert.match(decision, /repoFromLocation\(location\.href\)/, "an install link does not count");
  assert.match(decision, /isFetchableRepo\(/, "an unfetchable install link still counts");
  // It is a start, not a gate: skipping it once must not mark the person as welcomed.
  assert.doesNotMatch(decision, /welcomed\s*=|set\("welcomed"/, "the link launch writes the first-run flag");
});

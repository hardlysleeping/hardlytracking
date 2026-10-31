/**
 * Checklist §4's iOS half: a package link is the same address in the app and in a browser.
 *
 * Three files have to agree, and nothing in the build makes them:
 *
 * - `src/lib/software.ts` (`SOFTWARE_SITE`) — the host the canonical link is written on;
 * - `ios/App/App/App.entitlements` — the `applinks:` domain iOS is allowed to hand to the app;
 * - `deploy/apple-app-site-association` — the file that host serves, saying which app and which
 *   paths.
 *
 * A mismatch is silent in every direction: the entitlement without the file opens the web page
 * instead of the app, the file without the entitlement opens the browser, and a different host in
 * either is a link that never becomes a link. So they are read here, together, from the real files.
 *
 * The one thing this test cannot check is the Team ID: it comes from the Apple Developer account at
 * signing time, and the file carries `TEAMID` until then. Apple rejects an appID it cannot resolve,
 * so the failure is a link that does not open rather than one that opens wrongly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { readPlist } from "./plist.mjs";
import { SOFTWARE_SITE, canonicalSoftwareUrl } from "../../src/lib/software.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

const ENTITLEMENTS = "ios/App/App/App.entitlements";
const AASA = "deploy/apple-app-site-association";
const BUNDLE_ID = "ing.hardlysleep.hardlytracking";

test("the entitlement names the host the canonical link is written on", () => {
  const entitlements = readPlist(read(ENTITLEMENTS));
  const domains = entitlements["com.apple.developer.associated-domains"];
  assert.ok(Array.isArray(domains), "the app has the Associated Domains capability");
  const host = new URL(SOFTWARE_SITE).host;
  assert.ok(domains.includes(`applinks:${host}`), `${ENTITLEMENTS} must list applinks:${host}`);
  // One domain, spelled once: a second entry is a second host to keep right.
  assert.equal(domains.filter((entry) => entry.startsWith("applinks:")).length, 1);
});

test("the Xcode target is built with that entitlement file", () => {
  const project = read("ios/App/App.xcodeproj/project.pbxproj");
  const settings = [...project.matchAll(/CODE_SIGN_ENTITLEMENTS = ([^;]+);/g)].map((match) => match[1]);
  assert.ok(settings.length >= 2, "Debug and Release both sign with it");
  for (const value of settings) assert.equal(value, "App/App.entitlements");
  assert.match(project, /App\.entitlements \*\/ = \{isa = PBXFileReference/);
});

test("the association file names this app and this page", () => {
  const aasa = JSON.parse(read(AASA));
  const details = aasa.applinks?.details;
  assert.ok(Array.isArray(details) && details.length === 1, "one app, one detail block");
  const [detail] = details;
  assert.ok(Array.isArray(detail.appIDs) && detail.appIDs.length === 1);
  assert.match(detail.appIDs[0], new RegExp(`\\.${BUNDLE_ID.replace(/\./g, "\\.")}$`), "the appID ends with the bundle id");

  const components = detail.components ?? [];
  const paths = components.map((component) => component["/"]);
  assert.ok(paths.includes("/source"), "the package page is a universal link");
  assert.ok(paths.includes("/source/*"), "and so is anything under it");

  // The link the app prints must be a link the file claims.
  const canonical = canonicalSoftwareUrl({ pkg: "eu.kanade.tachiyomi.extension.all.mangafire", repo: "https://example.invalid/repo" });
  const path = new URL(canonical).pathname;
  assert.ok(paths.includes(path), `${canonical} is covered by ${AASA}`);
});

test("the app's own server answers that path, as Apple requires", () => {
  const proxy = read("server/proxy.mjs");
  assert.match(proxy, /"\/\.well-known\/apple-app-site-association"/, "served at the host root");
  assert.match(proxy, /serveAasa/, "with its own handler");
  // No token: Apple fetches it anonymously, like a browser navigation.
  const handler = proxy.slice(proxy.indexOf("async function serveAasa"), proxy.indexOf("/** The addresses a phone"));
  assert.ok(!handler.includes("authorised("), "the association file is public");
  assert.match(handler, /application\/json/);
});

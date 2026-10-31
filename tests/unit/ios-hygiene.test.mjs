/**
 * The App Store project-hygiene gate: §8 of `docs/app-store-release-checklist.md`.
 *
 * Four things are pinned here, and each one is a rejection or a review question when it drifts:
 *
 * - the deployment target, in all three places it is written (`project.pbxproj` four times, the
 *   `Podfile` and the runtime podspec). One of them left behind at 14.0 is a pod whose target is
 *   older than the app's — a warning that becomes an install failure on the next `pod install`.
 * - `UIBackgroundModes`: the app was declaring `fetch` and nothing fetched. An unused background
 *   mode is a review question with no answer.
 * - `UIRequiredDeviceCapabilities = armv7`: stale since iOS 11, and no armv7 device can run iOS 15.
 * - `PrivacyInfo.xcprivacy`: present, a member of the app target's Resources phase (a file in the
 *   group but not in the target builds into nothing and still fails upload), and declaring exactly
 *   the required-reason APIs this app's own code reaches — no more, so the privacy report has no
 *   entry nobody can explain, and no fewer, so the upload does not come back with ITMS-91053.
 *
 * `tests/unit/plist.mjs` reads the plists; the pbxproj and the workflow are read as text because
 * that is what they are.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readPlist } from "./plist.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const INFO_PLIST = join(root, "ios", "App", "App", "Info.plist");
const MANIFEST = join(root, "ios", "App", "App", "PrivacyInfo.xcprivacy");
const PBXPROJ = join(root, "ios", "App", "App.xcodeproj", "project.pbxproj");
const PODFILE = join(root, "ios", "App", "Podfile");
const PODSPEC = join(root, "plugins", "mihon-runtime", "MihonRuntime.podspec");
const WORKFLOW = join(root, ".github", "workflows", "ios-ipa.yml");

const info = readPlist(readFileSync(INFO_PLIST, "utf8"));
const pbxproj = readFileSync(PBXPROJ, "utf8");

/** `"15.0"` → 1500, so 15 and 15.0 and 15.0.0 compare the same way. */
function version(text) {
  const parts = String(text).split(".").map((part) => Number(part));
  assert.ok(parts.every((part) => Number.isFinite(part)), `${text} is not a version`);
  return ((parts[0] ?? 0) * 100 + (parts[1] ?? 0)) * 100 + (parts[2] ?? 0);
}

const MINIMUM = "15.0";

test("every deployment target in the project is iOS 15 or later", () => {
  const targets = [...pbxproj.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([0-9.]+);/g)].map((m) => m[1]);
  // Four configurations: project Debug/Release and target Debug/Release. A missing one means the
  // regex stopped matching, not that the setting disappeared.
  assert.equal(targets.length, 4, `expected four IPHONEOS_DEPLOYMENT_TARGET lines, saw ${targets.length}`);
  for (const target of targets) {
    assert.ok(version(target) >= version(MINIMUM), `IPHONEOS_DEPLOYMENT_TARGET is ${target}`);
  }

  const podfile = readFileSync(PODFILE, "utf8");
  const platform = podfile.match(/platform :ios, '([0-9.]+)'/);
  assert.ok(platform !== null, "the Podfile has no platform line");
  assert.ok(version(platform[1]) >= version(MINIMUM), `the Podfile platform is ${platform[1]}`);

  const podspec = readFileSync(PODSPEC, "utf8");
  const specPlatform = podspec.match(/s\.platform\s*=\s*:ios, '([0-9.]+)'/);
  assert.ok(specPlatform !== null, "the runtime podspec has no platform line");
  assert.ok(version(specPlatform[1]) >= version(MINIMUM), `the runtime podspec platform is ${specPlatform[1]}`);
});

test("no background mode is declared, because no feature runs in the background", () => {
  const modes = info.UIBackgroundModes;
  assert.ok(modes === undefined || modes.length === 0, `UIBackgroundModes declares ${JSON.stringify(modes)}`);
});

test("the stale armv7 device capability is gone", () => {
  const required = info.UIRequiredDeviceCapabilities ?? [];
  assert.ok(!required.includes("armv7"), "UIRequiredDeviceCapabilities still requires armv7");
});

test("PrivacyInfo.xcprivacy exists and is a resource of the app target", () => {
  assert.ok(existsSync(MANIFEST), "ios/App/App/PrivacyInfo.xcprivacy does not exist");

  // The file reference, the build file that puts it in a phase, and the phase itself. Checking all
  // three is the point: Xcode will happily show a file in the navigator that never ships.
  const fileRef = pbxproj.match(/([0-9A-F]{24}) \/\* PrivacyInfo\.xcprivacy \*\/ = \{isa = PBXFileReference;/);
  assert.ok(fileRef !== null, "the pbxproj has no PBXFileReference for PrivacyInfo.xcprivacy");
  const buildFile = pbxproj.match(
    /([0-9A-F]{24}) \/\* PrivacyInfo\.xcprivacy in Resources \*\/ = \{isa = PBXBuildFile; fileRef = ([0-9A-F]{24})/,
  );
  assert.ok(buildFile !== null, "the pbxproj has no PBXBuildFile for PrivacyInfo.xcprivacy");
  assert.equal(buildFile[2], fileRef[1], "the build file points at a different file reference");

  const resources = pbxproj.match(/[0-9A-F]{24} \/\* Resources \*\/ = \{\s*isa = PBXResourcesBuildPhase;[\s\S]*?\n\t\t\};/);
  assert.ok(resources !== null, "the pbxproj has no Resources build phase");
  assert.ok(
    resources[0].includes(`${buildFile[1]} /* PrivacyInfo.xcprivacy in Resources */`),
    "PrivacyInfo.xcprivacy is not in the app target's Resources phase",
  );
});

/**
 * The reason codes Apple publishes for each category. A code from another category is an
 * ITMS-91055 at upload, and the wrong code in the right category is a mismatch a reviewer can
 * cite — so the set is checked, not just the shape.
 */
const PUBLISHED_REASONS = {
  NSPrivacyAccessedAPICategoryUserDefaults: ["CA92.1", "1C8F.1", "C56D.1", "AC6B.1"],
  NSPrivacyAccessedAPICategoryFileTimestamp: ["DDA9.1", "C617.1", "3B52.1", "0A2A.1"],
  NSPrivacyAccessedAPICategoryDiskSpace: ["E174.1", "85F4.1", "7D9E.1", "B728.1"],
  NSPrivacyAccessedAPICategorySystemBootTime: ["35F9.1", "8FFB.1", "3D61.1"],
  NSPrivacyAccessedAPICategoryActiveKeyboards: ["3EC4.1", "54BD.1"],
};

/**
 * What this app actually reaches, with the call site named in the manifest next to each one:
 * Capacitor's `KeyValueStore` (UserDefaults), the embedded runtime's own state directory and a
 * user-selected CBZ opened in place (file timestamps), and Settings' storage line (disk space).
 * Adding a category here without a call site is the same mistake as leaving one out.
 */
const DECLARED = {
  NSPrivacyAccessedAPICategoryUserDefaults: ["CA92.1"],
  NSPrivacyAccessedAPICategoryFileTimestamp: ["C617.1", "3B52.1"],
  NSPrivacyAccessedAPICategoryDiskSpace: ["85F4.1"],
};

test("the manifest declares the required-reason APIs the app uses, and no others", () => {
  const manifest = readPlist(readFileSync(MANIFEST, "utf8"));
  assert.equal(manifest.NSPrivacyTracking, false, "the app does not track, and must not say it does");
  assert.deepEqual(manifest.NSPrivacyTrackingDomains ?? [], [], "no tracking domains");

  const declared = {};
  for (const entry of manifest.NSPrivacyAccessedAPITypes ?? []) {
    const category = entry.NSPrivacyAccessedAPIType;
    const reasons = entry.NSPrivacyAccessedAPITypeReasons ?? [];
    assert.ok(Object.hasOwn(PUBLISHED_REASONS, category), `${category} is not an Apple required-reason category`);
    assert.ok(reasons.length > 0, `${category} is declared with no reason code, which is what fails upload`);
    for (const reason of reasons) {
      assert.ok(PUBLISHED_REASONS[category].includes(reason), `${reason} is not a published reason for ${category}`);
    }
    declared[category] = [...reasons].sort();
  }

  const expected = Object.fromEntries(Object.entries(DECLARED).map(([category, reasons]) => [category, [...reasons].sort()]));
  assert.deepEqual(declared, expected, "the declared categories or reason codes drifted from what the app does");
});

test("the workflow archives on the current SDK and checks the built bundle", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  // A retired SDK is a rejection, so the build step asserts a floor instead of trusting the image's
  // default Xcode — and the archive is inspected rather than the source tree.
  assert.match(workflow, /xcode-select -s/, "the workflow does not select the newest Xcode");
  assert.match(workflow, /FLOOR=[0-9]/, "the workflow does not assert an SDK floor");
  assert.match(workflow, /App\.xcarchive/, "the workflow does not read the archive it built");
  assert.match(workflow, /PrivacyInfo\.xcprivacy/);
  assert.match(workflow, /MinimumOSVersion/);
});

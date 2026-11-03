/**
 * What this build is, and what it is running on.
 *
 * Two facts the plugin system needs and nothing else owns: the app's own version (a manifest can
 * require a minimum, and the install panel quotes it) and the shell it is running in (a permission
 * table may differ per platform).
 *
 * The version comes from the package at build time, not from a second copy in source — a hard-coded
 * `"0.5.8"` here would be wrong the first time the version moved, and it is the number a plugin's
 * `minAppVersion` is checked against.
 */
import { version as packageVersion } from "../../package.json";
import { detectPlatform } from "../lib/webview/index";
import { shellOf } from "../api/account";

/** The app's version, from `package.json`. One source of truth. */
export function appVersion(): string {
  return packageVersion;
}

/**
 * The shell this build runs in, in the vocabulary the plugin platform table uses.
 *
 * `shellOf` already answers this for billing (and refuses to guess "web" in an unknown native
 * shell); a plugin's permission set is the same question, so it is the same answer.
 */
export function platform(): "web" | "desktop" | "ios" | "android" {
  const shell = shellOf();
  if (shell === "desktop") return "desktop";
  if (shell === "ios") return "ios";
  if (shell === "android") return "android";
  // A plain browser build: the webview helper knows whether a Capacitor shell is wrapping it even
  // when `Capacitor` is not on `globalThis` yet, so both are consulted.
  const detected = detectPlatform();
  return detected === "capacitor" ? "ios" : "web";
}

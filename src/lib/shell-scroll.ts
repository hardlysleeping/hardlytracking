/**
 * Whether this shell needs the short-screen overflow guard.
 *
 * `main` is a scroll container even when its content fits, and WebKit rubber-bands every scroll
 * container it is handed: an empty Library and a three-line More screen could be dragged up and down.
 * So on those shells the frame's `overflow-y` is switched to `hidden` while there is nothing to
 * scroll.
 *
 * That is a WebKit behaviour, not a feature of the shell. Applying it everywhere meant the frame
 * carried an `overflow-y` owned by JavaScript, a whole-subtree `MutationObserver` and a measurement
 * pass on every mutation — on a desktop webview that never rubber-bands at all. On Linux, Windows and
 * a browser tab the frame is now a plain `overflow-y: auto` container and none of that code runs.
 */
import type { WebviewPlatform } from "./webview";

/** WKWebView, whatever the shell around it is called: iOS, iPadOS, or a Mac. */
export function isWebKitShell(platform: WebviewPlatform, userAgent: string): boolean {
  if (platform === "browser") return false;
  return /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(userAgent);
}
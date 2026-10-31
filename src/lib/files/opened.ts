/**
 * A comic handed to the app by the system — "Copy to HardlyTracking" from Files, or a tap on a CBZ
 * sitting in iCloud Drive.
 *
 * On iOS a file in iCloud Drive is not a path the app can read whenever it likes: the system gives
 * the app a URL and, with `LSSupportsOpeningDocumentsInPlace`, that URL is the file itself. So this
 * module does the only thing that keeps the promise the rest of the app makes — it reads the bytes
 * once, imports them like a picked file, and from then on the book is in the library and needs
 * neither iCloud nor a connection.
 *
 * Two entry points, because iOS has two: `getLaunchUrl` for a cold start (the app was not running
 * when the file was opened) and the `appUrlOpen` event for a warm one. Missing the first is the
 * classic bug — it works when the app is open and silently does nothing when it is not.
 *
 * Everything here is inert off iOS: `detectPlatform()` gates it, so the web build, the desktop app
 * and the test runner never load a Capacitor plugin.
 */
import { detectPlatform } from "../webview/index";
import { importComicFiles } from "./import";
import type { LibraryStore } from "../db/store";

/** `file:///private/var/mobile/.../Saga%20v01.cbz` → the path a filesystem plugin understands. */
export function pathFromFileUrl(url: string): string | null {
  if (!url.startsWith("file://")) return null;
  const withoutScheme = url.slice("file://".length);
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme; // a stray `%` is not worth failing the import over
  }
}

/** The name a URL refers to, which is what the library row will be called. */
export function nameFromPath(path: string): string {
  const base = path.split("/").filter((part) => part !== "").pop() ?? path;
  return base;
}

export function base64ToBlob(base64: string, type = "application/octet-stream"): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

export interface OpenInResult {
  added: number;
  skipped: string[];
  errors: string[];
}

/**
 * Read one handed-over URL into the library. Returns `null` when the URL is not a file this app
 * should touch (a `mihon://` deep link, a web URL), so the caller can ignore it silently.
 */
export async function importOpenedUrl(store: LibraryStore, url: string): Promise<OpenInResult | null> {
  const path = pathFromFileUrl(url);
  if (path === null) return null;
  const { Filesystem } = await import("@capacitor/filesystem");
  const { data } = await Filesystem.readFile({ path });
  const name = nameFromPath(path);
  const blob = base64ToBlob(typeof data === "string" ? data : "", "application/octet-stream");
  const file = new File([blob], name, { type: blob.type });
  return await importComicFiles(store, [file]);
}

/**
 * Listen for handed-over files for as long as the app runs. Resolves to a function that stops
 * listening, and to `null` everywhere this cannot happen.
 */
export async function watchOpenedFiles(
  store: LibraryStore,
  onImported: (result: OpenInResult) => void | Promise<void>,
): Promise<(() => void) | null> {
  // `capacitor` is the iOS shell; the desktop app is `tauri` and the web build is `browser`.
  if (detectPlatform() !== "capacitor") return null;
  const { App } = await import("@capacitor/app");

  const handle = async (url: string | null | undefined): Promise<void> => {
    if (url === null || url === undefined || !url.startsWith("file://")) return;
    try {
      const result = await importOpenedUrl(store, url);
      if (result !== null) await onImported(result);
    } catch {
      // A file the system handed us but we could not read (still downloading from iCloud, gone,
      // or not a comic) must not take the app down with it: the picker is still there.
    }
  };

  // The cold start: the file is why the app launched, and the event has already been missed.
  const launch = await App.getLaunchUrl();
  await handle(launch?.url);

  const listener = await App.addListener("appUrlOpen", ({ url }) => {
    void handle(url);
  });
  return () => void listener.remove();
}

/**
 * Saving a file the reader asked for, on the platform the app is actually running on.
 *
 * The backup screen built a Blob, clicked an `<a download>` and declared success. That works in a
 * browser tab and nowhere else: a WKWebView has no download machinery at all (iOS), and a Tauri
 * window has no download handler unless the shell installs one (desktop). So the one action that
 * gets a reader's library out of the app answered "here is your backup" with an empty Downloads
 * folder on every phone.
 *
 * Three platforms, three honest answers:
 *
 * | build | what happens |
 * |---|---|
 * | Capacitor (iOS/Android) | write to `Documents`, which iOS exposes in Files and Android makes readable |
 * | desktop (`__TAURI_INTERNALS__`) | `invoke("save_file")`, which writes into the OS Downloads folder |
 * | browser tab | the blob anchor, which is the browser's own save dialog |
 *
 * `where` is returned so the UI can say *where* the file went instead of "done": a sentence a
 * reader can act on is the difference between a backup and a rumour.
 */
import { detectPlatform } from "../webview/index";
import { isNativeShell } from "../webview/native-bridge";

export interface SavedFile {
  /** Which door was used, so the message can name a real place. */
  where: "documents" | "downloads" | "browser";
  /** The path or URL the platform reported, when it names one. */
  path?: string;
}

/** `/…/Documents/HardlyTracking-2026-11-19.json` → the file's own name. */
export function fileNameFromPath(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts.length === 0 ? path : parts[parts.length - 1];
}

/** Bytes → base64, in chunks: `String.fromCharCode(...bytes)` on a 5 MB backup throws. */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(binary);
}

interface FilesystemLike {
  writeFile(options: {
    path: string;
    data: string;
    directory: string;
    recursive?: boolean;
  }): Promise<{ uri: string }>;
}

/**
 * The Capacitor Filesystem plugin, or `null` outside a native shell.
 *
 * Read off `window.Capacitor` rather than imported: an `await import("@capacitor/filesystem")` in a
 * page with no bridge never settles, and a save that hangs is worse than one that says it cannot.
 */
function capacitorFilesystem(): FilesystemLike | null {
  if (!isNativeShell()) return null;
  const capacitor = (globalThis as Record<string, unknown>)["Capacitor"] as
    | { Plugins?: Record<string, unknown> }
    | undefined;
  const plugin = capacitor?.Plugins?.["Filesystem"] as FilesystemLike | undefined;
  return plugin !== undefined && typeof plugin.writeFile === "function" ? plugin : null;
}

/** The desktop shell's own save command, when this is the desktop shell. */
async function tauriSave(name: string, bytes: Uint8Array): Promise<SavedFile | null> {
  if (detectPlatform() !== "tauri") return null;
  const internals = (globalThis as Record<string, unknown>)["__TAURI_INTERNALS__"] as
    | { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> }
    | undefined;
  if (typeof internals?.invoke !== "function") return null;
  try {
    const path = await internals.invoke("save_file", { name, bytes: Array.from(bytes) });
    return typeof path === "string" && path !== "" ? { where: "downloads", path } : { where: "downloads" };
  } catch (error) {
    // The shell knows why (no Downloads directory, a full disk); it is the caller's to show.
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** A browser tab's own save: the anchor the app used everywhere, which is right here. */
function browserDownload(name: string, bytes: Uint8Array, mime: string): SavedFile {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // One turn of the event loop before the URL goes: Safari cancels an immediate revoke.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { where: "browser", path: name };
}

/**
 * Save `bytes` under `name` and say where it went.
 *
 * Throws only when the platform refused (a native write error); every other case resolves with the
 * place the file landed, because "saved to Documents" is what the reader needs to read.
 */
export async function saveFile(name: string, bytes: Uint8Array, mime = "application/octet-stream"): Promise<SavedFile> {
  const filesystem = capacitorFilesystem();
  if (filesystem !== null) {
    // `Documents` is the one directory both shells expose: iOS shows it in Files, Android's is the
    // app's own documents folder, which nothing else can delete.
    const written = await filesystem.writeFile({
      path: name,
      data: bytesToBase64(bytes),
      directory: "DOCUMENTS",
      recursive: true,
    });
    return { where: "documents", path: written.uri };
  }
  const desktop = await tauriSave(name, bytes);
  if (desktop !== null) return desktop;
  return browserDownload(name, bytes, mime);
}

/** One line for the UI: a sentence that names the place, not "done". */
export function describeSaved(saved: SavedFile): string {
  const name = saved.path === undefined ? "" : fileNameFromPath(saved.path);
  const file = name === "" ? "the file" : name;
  switch (saved.where) {
    case "documents":
      return `Saved ${file} to this app's Documents folder — open it from the Files app.`;
    case "downloads":
      return `Saved ${file} to your Downloads folder${saved.path === undefined ? "" : ` (${saved.path})`}.`;
    case "browser":
      return `Sent ${file} to the browser's downloads.`;
  }
}

/** Exported for the shell-facing test: the plugin shape, without a DOM. */
export type { FilesystemLike };
/**
 * Copying a link or a report, and saying whether it worked.
 *
 * Three places copied text with `navigator.clipboard?.writeText(...).catch(() => {})` and then told
 * the reader it had copied — a claim that is false in exactly the shells the app ships: an unfocused
 * Tauri window, a WebView with the clipboard denied, a page served over plain http where the async
 * clipboard API is not available at all. The optional chain turned "no clipboard" into "nothing
 * happened", and the caller turned that into "Copied".
 *
 * So the answer is a boolean, and there is a second door: `document.execCommand("copy")` on a
 * temporary selection still works where the async API is refused. When both fail the caller has to
 * say so — and the text it meant to copy is returned, so the UI can show something selectable
 * instead of an empty promise.
 */

export interface CopyResult {
  /** True only when the text actually reached the clipboard. */
  copied: boolean;
  /** How it was copied, for diagnostics: `clipboard`, `exec`, or `none`. */
  via: "clipboard" | "exec" | "none";
}

/** The system clipboard, when the runtime has one. */
async function viaClipboard(text: string): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== "function") return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The older path: a selection and a copy command. Deprecated, but the only door left in a webview. */
function viaExecCommand(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const area = document.createElement("textarea");
  area.value = text;
  // Off screen but still focusable: `display:none` cannot be selected.
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  const previous = document.activeElement as HTMLElement | null;
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus?.();
  }
}

/** Copy `text` and report what happened. Never throws. */
export async function copyText(text: string): Promise<CopyResult> {
  if (text === "") return { copied: false, via: "none" };
  if (await viaClipboard(text)) return { copied: true, via: "clipboard" };
  if (viaExecCommand(text)) return { copied: true, via: "exec" };
  return { copied: false, via: "none" };
}
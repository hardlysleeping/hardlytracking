/**
 * Opening a link outside the app.
 *
 * In the browser this is a new tab; on a phone it must be the system browser, because the WebView
 * has no address bar and navigating it away from the app is a dead end. Capacitor's Browser plugin
 * is the seam that does it, and it is only there when the build has it — hence the duck-typing rather
 * than an import, which would drag the plugin into the web build.
 */
export async function openExternal(url: string): Promise<void> {
  const bridge = (
    globalThis as {
      Capacitor?: {
        Plugins?: { Browser?: { open?: (options: { url: string }) => Promise<unknown> } };
      };
    }
  ).Capacitor;
  const open = bridge?.Plugins?.Browser?.open;
  if (typeof open === "function") {
    await open({ url });
    return;
  }
  if (typeof globalThis.open === "function") {
    globalThis.open(url, "_blank", "noopener");
  }
}

/** `archive.org`, `192.168.1.4:25600` — the part of a URL worth putting on a button. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

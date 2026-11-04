/**
 * The iOS shell: the same built web app in a WKWebView.
 *
 * It carries no runtime of its own — a packaged iPhone app either pairs with a desktop running the
 * extension host (Settings → Phone access) or, once the embedded JVM bridge lands, runs extensions
 * on-device. Everything it reads is the app's own code, so the shell is deliberately thin.
 */
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ing.hardlysleep.hardlytracking",
  appName: "HardlyTracking",
  webDir: "dist",
  ios: {
    // The app is full-bleed and handles the notch/home-indicator itself with `env(safe-area-inset-*)`.
    // "always" insets the webview a second time, which is the band of dead space under the bar.
    contentInset: "never",
    limitsNavigationsToAppBoundDomains: false,
    /**
     * The document does not scroll; `main` does.
     *
     * WKWebView gives its own `UIScrollView` a rubber band regardless of what the DOM says: on a page
     * whose content fits, dragging still lifted the title and let it spring back, which reads as "I can
     * scroll past the title on every page" — on screens with nothing to scroll. CSS cannot reach that
     * scroll view; this can. Inner scrollers are rendered by the web process and keep working.
     */
    scrollEnabled: false,
  },
  server: {
    iosScheme: "capacitor",
  },
  android: {
    // The WebView's own origin is https://localhost, so a paired PC on a plain-http LAN/tailnet
    // address would be refused as mixed content before the request left the app.
    allowMixedContent: true,
  },
  plugins: {
    // The on-device extension runtime serves `/dalvik` on `http://127.0.0.1:8747`, which is a
    // different origin from `capacitor://localhost`. CapacitorHttp sends those calls through native
    // URLSession, so the loopback runtime needs no CORS headers of its own — and URLSession is what
    // ATS governs, so the loopback address is exempted by name in `ios/App/App/Info.plist`
    // (`NSExceptionDomains`), not by a blanket allow.
    CapacitorHttp: { enabled: true },
  },
};

export default config;

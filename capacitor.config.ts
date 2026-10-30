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
  },
  server: {
    iosScheme: "capacitor",
  },
};

export default config;

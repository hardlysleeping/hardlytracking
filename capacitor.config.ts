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
    contentInset: "always",
    limitsNavigationsToAppBoundDomains: false,
  },
  server: {
    iosScheme: "capacitor",
  },
};

export default config;

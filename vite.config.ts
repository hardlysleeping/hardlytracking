import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/**
 * Dev server and the runtime share one origin in production (`server/proxy.mjs`).
 * In dev, the proxy below gives us the same shape so `/api/mihon/...` works
 * without CORS — the exact thing the brief asks nginx to do, in 6 lines.
 *
 * `/api/dalvik` is the same trick for the M-Extension-Server host: `/dalvik`,
 * `/capabilities` and its `/image/` proxy all arrive on this origin, so the page
 * never needs the runtime's loopback port (and never meets CORS on a POST).
 */
const RUNTIME = process.env.HARDLYTRACKING_RUNTIME ?? "http://127.0.0.1:4567";
const DALVIK = process.env.HARDLYTRACKING_DALVIK ?? "http://127.0.0.1:8792";
/**
 * The proxy that owns the read-only routes dev does not implement itself (`/api/repo`), so a dev tab
 * can add a repository and download an APK exactly as a served build does.
 *
 * `/api/host/*` is deliberately **not** proxied: that registry belongs to whichever machine is
 * serving the app, and a dev server is this device. Proxying it would make `npm run dev` claim to be
 * an HT-Server.
 */
const LOCAL_PROXY = process.env.HARDLYTRACKING_PROXY ?? "http://127.0.0.1:8460";

export default defineConfig({
  plugins: [svelte()],
  // HardlySyncing's two values are spelled `PUBLIC_SUPABASE_URL` /
  // `PUBLIC_SUPABASE_ANON_KEY` — the same names HardlyReader reads, because it is
  // the same project. Both are public by design (row-level security is what
  // protects the data), and neither is in source.
  envPrefix: ["VITE_", "PUBLIC_"],
  server: {
    port: 5199,
    proxy: {
      "/api/mihon": {
        target: RUNTIME,
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api\/mihon/, "/api"),
      },
      "/api/dalvik": {
        target: DALVIK,
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api\/dalvik/, ""),
      },
      "/api/repo": {
        target: LOCAL_PROXY,
        changeOrigin: true,
      },
    },
  },
});

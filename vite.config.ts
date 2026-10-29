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

export default defineConfig({
  plugins: [svelte()],
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
    },
  },
});

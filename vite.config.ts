import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/**
 * Dev server and the runtime share one origin in production (`server/proxy.mjs`).
 * In dev, the proxy below gives us the same shape so `/api/mihon/...` works
 * without CORS — the exact thing the brief asks nginx to do, in 6 lines.
 */
const RUNTIME = process.env.HARDLYTRACKING_RUNTIME ?? "http://127.0.0.1:4567";

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
    },
  },
});

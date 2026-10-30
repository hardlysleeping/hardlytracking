/**
 * A production build of the bench page only, so the numbers are the shipped bundle's and not the
 * dev server's (which ships every module unminified and pays for HMR).
 *
 *   npx vite build --config perf/vite.bench.config.ts
 *   npx vite preview --config perf/vite.bench.config.ts --port 5186
 *   open http://localhost:5186/perf/bench.html?rows=5000
 */
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [svelte()],
  build: {
    outDir: "dist-bench",
    emptyOutDir: true,
    rollupOptions: { input: { bench: fileURLToPath(new URL("./bench.html", import.meta.url)) } },
  },
  preview: { port: 5186 },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * Renderer-only Vite config. main + preload are built by esbuild (see
 * scripts/dev.ts and scripts/build.ts).
 *
 * The renderer is intentionally a "thin client": it does NOT import any
 * codeshell source. All Engine / AgentServer / AgentClient logic stays
 * in the main process. Renderer talks to main only through the
 * `window.codeShell.*` surface exposed by preload (see preload/index.ts).
 *
 * This avoids the whole "node:events / node:fs in a browser bundle"
 * problem entirely — the renderer bundle is just React + the renderer
 * source we own, no transitive Node dependencies at all.
 */
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  publicDir: false,
  server: {
    // Pick a port unlikely to collide with other vite projects (default 5173
    // gets crowded fast). dev.ts hard-codes the same port.
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: resolve(__dirname, "out/renderer"),
    emptyOutDir: true,
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@renderer": resolve(__dirname, "src/renderer"),
    },
  },
});

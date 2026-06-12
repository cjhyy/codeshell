import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
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
  plugins: [react(), tailwindcss()],
  // Pre-bundle every installed Radix package (+ lucide) at server start.
  // Without this, the FIRST import of a not-yet-used package mid-session
  // (e.g. adding a new shadcn component while dev is running) triggers a
  // re-optimize that bumps the deps-cache version — already-open windows
  // keep requesting the old `?v=` hash and hit
  // `504 (Outdated Optimize Dep)` until a full reload.
  optimizeDeps: {
    include: [
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-label",
      "@radix-ui/react-scroll-area",
      "@radix-ui/react-select",
      "@radix-ui/react-separator",
      "@radix-ui/react-slot",
      "@radix-ui/react-switch",
      "@radix-ui/react-tabs",
      "@radix-ui/react-tooltip",
      "lucide-react",
    ],
  },
  resolve: {
    alias: {
      "@renderer": resolve(__dirname, "src/renderer"),
      "@": resolve(__dirname, "src/renderer"),
    },
  },
});

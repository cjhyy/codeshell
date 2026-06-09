import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

/**
 * Mobile remote web app — a SECOND vite root, separate from the Electron
 * renderer (vite.config.ts). The phone/iPad loads this over HTTP/WS, NOT
 * through Electron preload, so it must be a self-contained browser bundle.
 *
 * It REUSES the renderer's shadcn components via the @ui alias (zero changes
 * to desktop) and shares the WS protocol types via @protocol (`import type`
 * only — types are erased, so main/mobile-remote/types.ts is never bundled).
 *
 * See docs/superpowers/specs/2026-06-10-mobile-ui-react-rebuild-design.md.
 */
export default defineConfig({
  root: resolve(__dirname, "src/mobile"),
  base: "./",
  publicDir: false,
  server: {
    // 5273 is the renderer dev server; mobile gets its own fixed port so the
    // remote host can proxy /mobile to it in dev (see scripts/dev.ts).
    port: 5373,
    strictPort: true,
  },
  build: {
    outDir: resolve(__dirname, "out/mobile"),
    emptyOutDir: true,
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // `@` MUST map to the renderer root: the shared shadcn components import
      // their `cn` helper from "@/lib/utils", so reusing them requires the same
      // alias the renderer uses. @ui is sugar for the components dir.
      "@": resolve(__dirname, "src/renderer"),
      "@ui": resolve(__dirname, "src/renderer/components/ui"),
      "@protocol": resolve(__dirname, "src/main/mobile-remote/types.ts"),
      "@mobile": resolve(__dirname, "src/mobile"),
    },
  },
});

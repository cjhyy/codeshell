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
 * only — types are erased, so packages/server mobile-remote/types.ts is never bundled).
 *
 * See docs/superpowers/specs/2026-06-10-mobile-ui-react-rebuild-design.md.
 */
export default defineConfig({
  root: resolve(__dirname, "src/mobile"),
  // MUST be the absolute "/mobile/" prefix, NOT "./". The app is served at
  // /mobile (the remote host only routes the /mobile prefix), so relative
  // "./assets/*" would resolve against the document base /mobile → /assets/*,
  // which falls outside the routed prefix and 404s (blank page). An absolute
  // /mobile/ base makes both the built bundle and vite's dev HMR/module URLs
  // (/mobile/@vite/client, /mobile/src/main.tsx) stay under the routed prefix.
  base: "/mobile/",
  publicDir: false,
  server: {
    // 5273 is the renderer dev server; mobile gets its own fixed port so the
    // remote host can proxy /mobile to it in dev (see scripts/dev.ts).
    // Bind 127.0.0.1 explicitly: the default binds IPv6-only ([::1]), which
    // makes the main-process proxy's target ambiguous (Node may resolve the
    // target to IPv4 and hit connection-refused). Pinning v4 keeps the proxy
    // target (127.0.0.1:5373) and the bind in lockstep.
    host: "127.0.0.1",
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
      "@protocol": resolve(__dirname, "../server/src/mobile-remote/types.ts"),
      "@mobile": resolve(__dirname, "src/mobile"),
      // Workspace TS source package (web client logic layer): bundle straight
      // from src so dev/build never read a stale dist. Barrel imports only.
      "@cjhyy/code-shell-web": resolve(__dirname, "../web/src/index.ts"),
    },
  },
});

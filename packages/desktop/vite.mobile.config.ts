import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/** Desktop-hosted Web entry: the same browser workbench as standalone Hub,
 * adapted to the existing paired Desktop protocol, without renderer imports. */
export default defineConfig({
  root: resolve(__dirname, "src/mobile"),
  // MUST be the absolute "/mobile/" prefix, NOT "./". The app is served at
  // /mobile (the remote host only routes the /mobile prefix), so relative
  // "./assets/*" would resolve against the document base /mobile → /assets/*,
  // which falls outside the routed prefix and 404s (blank page). An absolute
  // /mobile/ base makes both the built bundle and vite's dev HMR/module URLs
  // (/mobile/@vite/client, /mobile/src/main.tsx) stay under the routed prefix.
  base: "/mobile/",
  publicDir: resolve(__dirname, "../web/app/public"),
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
  plugins: [react()],
  resolve: {
    alias: {
      // Workspace TS source package (web client logic layer): bundle straight
      // from src so dev/build never read a stale dist. Barrel imports only.
      "@cjhyy/code-shell-web": resolve(__dirname, "../web/src/index.ts"),
    },
  },
});

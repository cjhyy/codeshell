// Vite build for the standalone browser client (app/). Output dist-app/ is
// what the headless serve host (resolveWebAppRoot) serves as the static root.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "app"),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist-app"),
    emptyOutDir: true,
  },
  server: {
    // Dev proxy: `vite dev` against a locally running code-shell-serve.
    proxy: {
      "/ws": { target: "http://127.0.0.1:8790", ws: true },
    },
  },
});

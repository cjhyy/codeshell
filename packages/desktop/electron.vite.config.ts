import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * Three sub-builds, one config:
 *
 *   main      Electron main process (Node-ish, has fs / ipcMain / Engine).
 *             Externalize deps so we don't try to bundle @cjhyy/code-shell.
 *   preload   Tiny bridge exposing a safe IPC surface to the renderer via
 *             contextBridge. Externalize electron itself.
 *   renderer  React DOM app; bundled normally with @vitejs/plugin-react.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer"),
      },
    },
  },
});

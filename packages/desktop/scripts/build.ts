/**
 * Production build — fire all three sub-builds in parallel, no watch,
 * no electron launch. Equivalent of `npm run build` in electron-vite
 * but with explicit control over every step.
 */

import { build as viteBuild } from "vite";
import esbuild from "esbuild";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = dirname(fileURLToPath(import.meta.url));
const root = resolve(cwd, "..");

async function buildMain(): Promise<void> {
  await rm(resolve(root, "out/main"), { recursive: true, force: true });
  await esbuild.build({
    entryPoints: [resolve(root, "src/main/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: resolve(root, "out/main"),
    entryNames: "index",
    chunkNames: "chunks/[name]-[hash]",
    outExtension: { ".js": ".mjs" },
    splitting: true,
    external: [
      "electron",
      "playwright-core",
      "@cjhyy/code-shell-core",
      "@cjhyy/code-shell-capability-coding",
    ],
    loader: { ".md": "text" },
    banner: {
      // esbuild wraps bundled CommonJS dependencies but does not provide the
      // per-module __filename/__dirname globals they normally receive from
      // Node. A few SDKs read those globals during module initialization, so
      // provide bundle-relative fallbacks alongside the existing require shim.
      js: "import { createRequire as __ccr } from 'node:module'; import { dirname as __ccd } from 'node:path'; import { fileURLToPath as __ccf } from 'node:url'; var require = __ccr(import.meta.url); var __filename = __ccf(import.meta.url); var __dirname = __ccd(__filename);",
    },
    minify: false,
    logLevel: "info",
  });
}

async function buildPreload(): Promise<void> {
  await esbuild.build({
    entryPoints: {
      index: resolve(root, "src/preload/index.ts"),
      "browser-guest": resolve(root, "src/preload/browser-guest.ts"),
      "panel-app": resolve(root, "src/preload/panel-app.ts"),
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outdir: resolve(root, "out/preload"),
    outExtension: { ".js": ".cjs" },
    external: ["electron"],
    minify: false,
    logLevel: "info",
  });
}

async function buildRenderer(): Promise<void> {
  await viteBuild({
    configFile: resolve(root, "vite.config.ts"),
  });
}

/** The phone/iPad remote web app — a separate vite root (src/mobile → out/mobile),
 *  served as static assets by RemoteHostManager. See vite.mobile.config.ts. */
async function buildMobile(): Promise<void> {
  await viteBuild({
    configFile: resolve(root, "vite.mobile.config.ts"),
  });
}

async function main(): Promise<void> {
  await Promise.all([buildMain(), buildPreload(), buildRenderer(), buildMobile()]);
  // eslint-disable-next-line no-console
  console.log("[build] all four sub-builds OK");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[build] failed:", err);
  process.exit(1);
});

import esbuild, { type BuildOptions } from "esbuild";
import { rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Main and its worker-loaded Link module must ship together in every build mode. */
export function desktopMainBuildOptions(root = desktopRoot): BuildOptions {
  return {
    entryPoints: {
      index: resolve(root, "src/main/index.ts"),
      "link-provider-module": resolve(root, "src/main/link-provider-module.ts"),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: resolve(root, "out/main"),
    chunkNames: "chunks/[name]-[hash]",
    outExtension: { ".js": ".mjs" },
    splitting: true,
    // Share Core's registry and Link's error constructors with the worker.
    // Server implementations stay bundled rather than becoming runtime packages.
    external: [
      "electron",
      "playwright-core",
      "@cjhyy/code-shell-core",
      "@cjhyy/code-shell-link",
      "@cjhyy/code-shell-capability-coding",
    ],
    loader: { ".md": "text" },
    // Bundled CommonJS dependencies need Node's require and path globals.
    banner: {
      js: "import { createRequire as __ccr } from 'node:module'; import { dirname as __ccd } from 'node:path'; import { fileURLToPath as __ccf } from 'node:url'; var require = __ccr(import.meta.url); var __filename = __ccf(import.meta.url); var __dirname = __ccd(__filename);",
    },
    minify: false,
    logLevel: "info",
  };
}

export async function buildDesktopMain(metafilePath?: string): Promise<void> {
  const options = desktopMainBuildOptions();
  await rm(options.outdir!, { recursive: true, force: true });
  const result = await esbuild.build({ ...options, metafile: Boolean(metafilePath) });
  if (metafilePath) await writeFile(metafilePath, JSON.stringify(result.metafile));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !arg.startsWith("--metafile="))) {
    throw new Error("build:main only accepts --metafile=<path>");
  }
  await buildDesktopMain(args.find((arg) => arg.startsWith("--metafile="))?.slice(11));
}

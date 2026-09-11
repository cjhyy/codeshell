import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { createRequire } from "node:module";
import { puppeteerExtensionCspPlugin } from "./puppeteer-extension-csp.js";

export async function buildChromeExtension(outputFile?: string): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const functionModulePath = createRequire(import.meta.url).resolve(
    "puppeteer-core/lib/esm/puppeteer/util/Function.js",
  );
  await build({
    absWorkingDir: root,
    entryPoints: ["src/chrome-extension/service-worker.ts"],
    outfile: outputFile ?? "resources/chrome-extension/service-worker.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome125",
    minify: true,
    legalComments: "linked",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { crypto: path.join(root, "src/chrome-extension/webcrypto.ts") },
    plugins: [puppeteerExtensionCspPlugin(functionModulePath)],
  });
}

if (import.meta.main) await buildChromeExtension();

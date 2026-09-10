import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

export async function buildChromeExtension(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await build({
    absWorkingDir: root,
    entryPoints: ["src/chrome-extension/service-worker.ts"],
    outfile: "resources/chrome-extension/service-worker.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome125",
    minify: true,
    legalComments: "linked",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { crypto: path.join(root, "src/chrome-extension/webcrypto.ts") },
  });
}

if (import.meta.main) await buildChromeExtension();

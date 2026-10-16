import esbuild from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_LINK_PROVIDER_BUNDLE } from "../src/main/link-provider-module.js";

/** The worker cannot depend on workspace packages that exist only inside main's bundle. */
export async function buildWorkerLinkProviders(
  options: { desktopRoot?: string; outfile?: string } = {},
): Promise<esbuild.BuildResult> {
  const desktopRoot = options.desktopRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await esbuild.build({
    stdin: {
      contents: 'export { createLinkProviderModule } from "@cjhyy/code-shell-server/links";',
      resolveDir: desktopRoot,
      sourcefile: "desktop-worker-link-providers.ts",
    },
    outfile: options.outfile ?? resolve(desktopRoot, DESKTOP_LINK_PROVIDER_BUNDLE),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    // Share Core's registry and Link's error constructors with the worker.
    external: ["@cjhyy/code-shell-core", "@cjhyy/code-shell-link"],
    metafile: true,
    logLevel: "info",
  });
  for (const output of Object.values(result.metafile!.outputs)) {
    for (const entry of output.imports) {
      if (
        entry.external &&
        entry.path.startsWith("@cjhyy/") &&
        !/^@cjhyy\/code-shell-(?:core|link)(?:\/|$)/.test(entry.path)
      )
        throw new Error(`Worker Link bundle has an undelivered runtime dependency: ${entry.path}`);
    }
  }
  return result;
}

if (import.meta.main) await buildWorkerLinkProviders();

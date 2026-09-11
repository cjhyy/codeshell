import { readFile } from "node:fs/promises";
import type { Plugin } from "esbuild";

const OLD_CSP_CHECK =
  "err.message.includes(`Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive`)";
const NEW_CSP_MESSAGE =
  "Evaluating a string as JavaScript violates the following Content Security Policy";

/**
 * Backport Puppeteer #14156 without changing the extension's CSP or its dependency version.
 * https://github.com/puppeteer/puppeteer/commit/41e39c77987b5186f11b59296ebd5e9347efcd09
 * Remove this adapter when the pinned Puppeteer includes that fix (or its eval-free successor).
 * An upstream source change must be reviewed instead of silently shipping an unpatched bundle.
 */
export function backportPuppeteerExtensionCsp(source: string): string {
  const first = source.indexOf(OLD_CSP_CHECK);
  if (
    first < 0 ||
    first !== source.lastIndexOf(OLD_CSP_CHECK) ||
    source.includes(NEW_CSP_MESSAGE)
  ) {
    throw new Error(
      "Puppeteer function serializer changed; review or remove the extension CSP backport before building",
    );
  }
  return source.replace(
    OLD_CSP_CHECK,
    `(${OLD_CSP_CHECK} || err.message.includes(${JSON.stringify(NEW_CSP_MESSAGE)}))`,
  );
}

/** Only the resolved browser dependency is transformed in memory; node_modules stays untouched. */
export function puppeteerExtensionCspPlugin(functionModulePath: string): Plugin {
  return {
    name: "puppeteer-extension-csp-backport",
    setup(build) {
      let patchedModules = 0;
      build.onStart(() => {
        patchedModules = 0;
      });
      build.onLoad({ filter: /[/\\]util[/\\]Function\.js$/ }, async ({ path }) => {
        if (path !== functionModulePath) return;
        const contents = backportPuppeteerExtensionCsp(await readFile(path, "utf8"));
        patchedModules++;
        return {
          contents,
          loader: "js",
        };
      });
      build.onEnd((result) => {
        if (!result.errors.length && patchedModules !== 1) {
          return {
            errors: [{ text: "Puppeteer extension CSP backport must patch exactly one module" }],
          };
        }
      });
    },
  };
}

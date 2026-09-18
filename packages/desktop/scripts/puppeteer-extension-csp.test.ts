import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { Script } from "node:vm";
import { build } from "esbuild";
import {
  backportPuppeteerExtensionCsp,
  puppeteerExtensionCspPlugin,
} from "./puppeteer-extension-csp.js";

const functionModulePath = createRequire(import.meta.url).resolve(
  "puppeteer-core/lib/esm/puppeteer/util/Function.js",
);
const dependency = readFileSync(functionModulePath, "utf8");
const modernCspMessage =
  "Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script: script-src 'self'";
const legacyCspMessage =
  "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: script-src 'self'";

function serializer(source: string, cspMessage?: string): (fn: unknown) => string {
  return new Script(`${source.replace(/^export /gm, "")}\nstringifyFunction;`).runInNewContext(
    cspMessage
      ? {
          Function: function () {
            throw new EvalError(cspMessage);
          },
        }
      : {},
  );
}

describe("Puppeteer extension CSP backport", () => {
  test("repairs the captured Chrome 145/149 CSP failure in the actual pinned serializer", () => {
    const fn = () => "observed element";
    expect(() => serializer(dependency, modernCspMessage)(fn)).toThrow(
      "Passed function cannot be serialized!",
    );
    expect(serializer(backportPuppeteerExtensionCsp(dependency), modernCspMessage)(fn)).toBe(
      fn.toString(),
    );
  });

  test("preserves the Chrome 141 CSP path", () => {
    const fn = async () => "observed element";
    expect(serializer(backportPuppeteerExtensionCsp(dependency), legacyCspMessage)(fn)).toBe(
      fn.toString(),
    );
  });

  test("keeps real syntax validation and method shorthand normalization", () => {
    const stringify = serializer(backportPuppeteerExtensionCsp(dependency));
    const method = {
      value() {
        return 42;
      },
    }.value;
    const normalized = stringify(method);
    expect(new Script(`(${normalized})()`).runInNewContext()).toBe(42);
    expect(() => stringify({ toString: () => "broken(){" })).toThrow(
      "Passed function cannot be serialized!",
    );
  });

  test("stops the build when dependency code drifts or already contains the upstream fix", () => {
    expect(() => backportPuppeteerExtensionCsp("export function stringifyFunction() {}")).toThrow(
      "Puppeteer function serializer changed",
    );
    expect(() => backportPuppeteerExtensionCsp(dependency + dependency)).toThrow(
      "Puppeteer function serializer changed",
    );
    expect(() => backportPuppeteerExtensionCsp(backportPuppeteerExtensionCsp(dependency))).toThrow(
      "Puppeteer function serializer changed",
    );
  });
  test("applies the backport in a real browser bundle without modifying the dependency", async () => {
    const result = await build({
      stdin: {
        contents: `import { stringifyFunction } from ${JSON.stringify(functionModulePath)}; globalThis.serialized = stringifyFunction(() => 42);`,
        resolveDir: dirname(functionModulePath),
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      plugins: [puppeteerExtensionCspPlugin(functionModulePath)],
    });
    const context = {
      serialized: "",
      Function: function () {
        throw new EvalError(modernCspMessage);
      },
    };
    new Script(result.outputFiles[0].text).runInNewContext(context);
    expect(context.serialized).toBe("() => 42");
    expect(readFileSync(functionModulePath, "utf8")).toBe(dependency);
  });

  test("rejects a build that never loaded the resolved Puppeteer function module", async () => {
    await expect(
      build({
        stdin: { contents: "globalThis.unrelated = true;" },
        write: false,
        logLevel: "silent",
        plugins: [puppeteerExtensionCspPlugin(functionModulePath)],
      }),
    ).rejects.toThrow("Puppeteer extension CSP backport must patch exactly one module");
  });
});

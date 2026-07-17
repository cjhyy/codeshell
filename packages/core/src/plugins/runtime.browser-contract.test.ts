import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const coreRoot = new URL("../../", import.meta.url);
const runtimeEntry = new URL("./runtime.ts", import.meta.url);

describe("plugin lifecycle browser contract", () => {
  test("bundles for browsers without Node or Electron runtime dependencies", async () => {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(runtimeEntry)],
      target: "browser",
      format: "esm",
    });

    expect(result.success).toBe(true);
    expect(result.logs).toEqual([]);
    expect(result.outputs).toHaveLength(1);
    const output = await result.outputs[0]!.text();
    expect(output).not.toMatch(
      /\b(?:node:|electron|process\.|Buffer\b|require\s*\(|__dirname\b|__filename\b)/,
    );
  });

  test("publishes an explicit browser-safe subpath while preserving the legacy entry", async () => {
    const manifest = (await Bun.file(new URL("package.json", coreRoot)).json()) as {
      exports: Record<string, unknown>;
    };

    expect(manifest.exports["./browser/plugin-runtime"]).toEqual({
      types: "./dist/plugins/runtime.d.ts",
      import: "./dist/plugins/runtime.js",
    });
    expect(manifest.exports["./plugin-runtime"]).toEqual(
      manifest.exports["./browser/plugin-runtime"],
    );
  });
});

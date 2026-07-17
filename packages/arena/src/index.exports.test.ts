import { describe, expect, it } from "bun:test";
import * as rootApi from "./index.js";
import * as runtimeApi from "./index.runtime.js";

describe("Arena package public entry contracts", () => {
  it("keeps the host runtime focused and root-compatible", () => {
    expect(runtimeApi.Arena).toBe(rootApi.Arena);
    expect(runtimeApi.createArenaCapability).toBe(rootApi.createArenaCapability);
    expect(runtimeApi.formatArenaResultForSession).toBe(rootApi.formatArenaResultForSession);
    expect(runtimeApi.MODEL_PRESETS).toBe(rootApi.MODEL_PRESETS);

    expect(runtimeApi).not.toHaveProperty("IterativeArena");
    expect(runtimeApi).not.toHaveProperty("ArenaLedger");
    expect(runtimeApi).not.toHaveProperty("planArena");
    expect(runtimeApi).not.toHaveProperty("runParticipantResearch");
  });

  it("declares the exact runtime export and source alias", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
    const rootTsconfig = await Bun.file(new URL("../../../tsconfig.json", import.meta.url)).json();

    expect(packageJson.exports["./runtime"]).toEqual({
      types: "./dist/index.runtime.d.ts",
      import: "./dist/index.runtime.js",
    });
    expect(rootTsconfig.compilerOptions.paths["@cjhyy/code-shell-arena/runtime"]).toEqual([
      "packages/arena/src/index.runtime.ts",
    ]);
    expect(rootTsconfig.compilerOptions.paths["@cjhyy/code-shell-arena/*"]).toBeUndefined();
  });
});

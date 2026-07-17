import { describe, expect, it } from "bun:test";
import * as capabilityApi from "./index.capability.js";
import * as gitApi from "./index.git.js";
import * as orchestrationApi from "./index.orchestration.js";
import * as rootApi from "./index.js";

describe("Coding package public entry contracts", () => {
  it("keeps the capability surface focused and root-compatible", () => {
    expect(Object.keys(capabilityApi).sort()).toEqual([
      "CODING_CAPABILITY",
      "CODING_GENERAL_PRESET",
      "CODING_TOOLS",
      "TERMINAL_CODING_PRESET",
    ]);
    expect(capabilityApi.CODING_CAPABILITY).toBe(rootApi.CODING_CAPABILITY);
    expect(capabilityApi.CODING_TOOLS).toBe(rootApi.CODING_TOOLS);
    expect(capabilityApi).not.toHaveProperty("createWorktree");
    expect(capabilityApi).not.toHaveProperty("probeClaudeCli");
  });

  it("separates Git/worktree helpers from external-agent orchestration", () => {
    expect(gitApi.resolveProjectRoot).toBe(rootApi.resolveProjectRoot);
    expect(gitApi.createWorktree).toBe(rootApi.createWorktree);
    expect(gitApi.buildReviewPrompt).toBe(rootApi.buildReviewPrompt);
    expect(gitApi).not.toHaveProperty("CODING_CAPABILITY");
    expect(gitApi).not.toHaveProperty("probeClaudeCli");

    expect(orchestrationApi.probeClaudeCli).toBe(rootApi.probeClaudeCli);
    expect(orchestrationApi.CC_COST_GUARD_PROMPT).toBe(rootApi.CC_COST_GUARD_PROMPT);
    expect(orchestrationApi.resolveQuotaCredentials).toBe(rootApi.resolveQuotaCredentials);
    expect(orchestrationApi).not.toHaveProperty("CODING_CAPABILITY");
    expect(orchestrationApi).not.toHaveProperty("createWorktree");
    expect(orchestrationApi).not.toHaveProperty("LSPClient");
  });

  it("declares exact exports and source aliases without a deep-import wildcard", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
    const rootTsconfig = await Bun.file(new URL("../../../tsconfig.json", import.meta.url)).json();

    expect(packageJson.exports["./capability"]).toEqual({
      types: "./dist/index.capability.d.ts",
      import: "./dist/index.capability.js",
    });
    expect(packageJson.exports["./git"]).toEqual({
      types: "./dist/index.git.d.ts",
      import: "./dist/index.git.js",
    });
    expect(packageJson.exports["./orchestration"]).toEqual({
      types: "./dist/index.orchestration.d.ts",
      import: "./dist/index.orchestration.js",
    });
    expect(
      rootTsconfig.compilerOptions.paths["@cjhyy/code-shell-capability-coding/capability"],
    ).toEqual(["packages/coding/src/index.capability.ts"]);
    expect(rootTsconfig.compilerOptions.paths["@cjhyy/code-shell-capability-coding/git"]).toEqual([
      "packages/coding/src/index.git.ts",
    ]);
    expect(
      rootTsconfig.compilerOptions.paths["@cjhyy/code-shell-capability-coding/orchestration"],
    ).toEqual(["packages/coding/src/index.orchestration.ts"]);
    expect(
      rootTsconfig.compilerOptions.paths["@cjhyy/code-shell-capability-coding/*"],
    ).toBeUndefined();
  });
});

import { describe, expect, it } from "bun:test";
import type { EngineConfig } from "./types.js";
import { RunEnvironmentResolver } from "./run-environment.js";
import { defaultSandboxConfig, type SandboxBackend } from "../tool-system/sandbox/index.js";

const offBackend: SandboxBackend = {
  name: "off",
  wrap: (command, options) => ({ file: options.shell, args: ["-lc", command] }),
  hintForBlockedOutput: () => undefined,
};

describe("RunEnvironmentResolver", () => {
  it("resolves project sandbox, shallow-copies network, and caches by config/cwd", async () => {
    let calls = 0;
    const shared: SandboxBackend = { ...offBackend, name: "seatbelt" };
    const resolver = new RunEnvironmentResolver({
      config: () => ({ llm: { provider: "x", model: "m" }, headless: true } as EngineConfig),
      settings: () => ({
        get: () => ({}),
        getForScope: (scope: string) =>
          scope === "project" ? { sandbox: { mode: "seatbelt", network: "deny" } } : {},
      }),
      credentialAccess: { envExposures: () => ({}) },
      resolveBackend: async () => {
        calls++;
        return shared;
      },
    });

    const first = await resolver.resolve("/repo");
    const second = await resolver.resolve("/repo");
    expect(calls).toBe(1);
    expect(first.sandbox).not.toBe(shared);
    expect(first.sandbox.network).toBe("deny");
    expect(shared.network).toBeUndefined();
    expect(second.sandbox.name).toBe("seatbelt");
  });

  it("evicts a rejected backend promise so an explicit mode can retry", async () => {
    let calls = 0;
    const resolver = new RunEnvironmentResolver({
      config: () => ({
        llm: { provider: "x", model: "m" },
        sandbox: defaultSandboxConfig("seatbelt"),
      } as EngineConfig),
      settings: () => ({ get: () => ({}), getForScope: () => ({}) }),
      credentialAccess: { envExposures: () => ({}) },
      resolveBackend: async () => {
        calls++;
        if (calls === 1) throw new Error("unavailable");
        return offBackend;
      },
    });

    await expect(resolver.resolveSandbox("/repo")).rejects.toThrow("unavailable");
    await expect(resolver.resolveSandbox("/repo")).resolves.toBe(offBackend);
    expect(calls).toBe(2);
  });

  it("layers local env, credential exposure, and explicit env in precedence order", () => {
    const resolver = new RunEnvironmentResolver({
      config: () => ({
        llm: { provider: "x", model: "m" },
        settingsScope: "full",
      } as EngineConfig),
      settings: () => ({
        get: () => ({
          localEnvironment: { env: { FLOOR: "local", OVERLAP: "local" } },
          env: { TOP: "settings", OVERLAP: "settings" },
        }),
        getForScope: () => ({}),
      }),
      credentialAccess: {
        envExposures: (_cwd, scope) => ({ CREDENTIAL: scope, OVERLAP: "credential" }),
      },
      resolveBackend: async () => offBackend,
    });

    expect(resolver.readShellEnv("/repo")).toEqual({
      FLOOR: "local",
      CREDENTIAL: "full",
      TOP: "settings",
      OVERLAP: "settings",
    });
  });

  it("reads worktree settings only from the intended scope", () => {
    const resolver = new RunEnvironmentResolver({
      config: () => ({ llm: { provider: "x", model: "m" } }) as EngineConfig,
      settings: () => ({
        get: () => ({ worktree: { branchPrefix: "feature/" } }),
        getForScope: () => ({ localEnvironment: { setupScripts: { default: "bun install" } } }),
      }),
      credentialAccess: { envExposures: () => ({}) },
      resolveBackend: async () => offBackend,
    });
    expect(resolver.readWorktreeSetupScripts("/repo")).toEqual({ default: "bun install" });
    expect(resolver.readWorktreeBranchPrefix("/repo")).toBe("feature/");
  });
});

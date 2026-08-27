import { describe, expect, it } from "bun:test";
import type { EngineConfig } from "./types.js";
import { RunEnvironmentResolver } from "./run-environment.js";
import { defaultSandboxConfig, type SandboxBackend } from "../tool-system/sandbox/index.js";
import { createWorkspaceContext, legacySingleRootWorkspace } from "../workspace/workspace-context.js";

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
      config: () => ({ llm: { provider: "x", model: "m" }, headless: true }) as EngineConfig,
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

    const run = { cwd: "/repo", workspaceContext: legacySingleRootWorkspace("/repo") };
    const first = await resolver.resolve(run);
    const second = await resolver.resolve(run);
    expect(calls).toBe(1);
    expect(first.sandbox).not.toBe(shared);
    expect(first.sandbox.network).toBe("deny");
    expect(shared.network).toBeUndefined();
    expect(second.sandbox.name).toBe("seatbelt");
  });

  it("evicts a rejected backend promise so an explicit mode can retry", async () => {
    let calls = 0;
    const resolver = new RunEnvironmentResolver({
      config: () =>
        ({
          llm: { provider: "x", model: "m" },
          sandbox: defaultSandboxConfig("seatbelt"),
        }) as EngineConfig,
      settings: () => ({ get: () => ({}), getForScope: () => ({}) }),
      credentialAccess: { envExposures: () => ({}) },
      resolveBackend: async () => {
        calls++;
        if (calls === 1) throw new Error("unavailable");
        return offBackend;
      },
    });

    const run = { cwd: "/repo", workspaceContext: legacySingleRootWorkspace("/repo") };
    await expect(resolver.resolveSandbox(run)).rejects.toThrow("unavailable");
    await expect(resolver.resolveSandbox(run)).resolves.toBe(offBackend);
    expect(calls).toBe(2);
  });

  it("layers local env, credential exposure, and explicit env in precedence order", () => {
    const resolver = new RunEnvironmentResolver({
      config: () =>
        ({
          llm: { provider: "x", model: "m" },
          settingsScope: "full",
        }) as EngineConfig,
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

  it("appends every run root to explicit sandbox writableRoots and de-duplicates aliases", () => {
    const resolver = new RunEnvironmentResolver({
      config: () =>
        ({
          llm: { provider: "x", model: "m" },
          sandbox: { ...defaultSandboxConfig("seatbelt"), writableRoots: ["/repo"] },
        }) as EngineConfig,
      settings: () => ({ get: () => ({}), getForScope: () => ({}) }),
      credentialAccess: { envExposures: () => ({}) },
      resolveBackend: async () => offBackend,
    });
    const workspaceContext = createWorkspaceContext({
      projectId: "project-1",
      projectRevision: 1,
      sessionMainRootId: "main",
      roots: [
        { id: "main", path: "/repo", role: "primary" },
        { id: "docs", path: "/docs", role: "secondary" },
      ],
    });

    expect(resolver.resolveSandboxConfig({ cwd: "/repo", workspaceContext }).writableRoots).toEqual(
      ["/repo", "/docs"],
    );
  });
});

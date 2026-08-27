import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineConfig } from "./types.js";
import { RunEnvironmentResolver } from "./run-environment.js";
import {
  defaultSandboxConfig,
  expandPath,
  type SandboxBackend,
} from "../tool-system/sandbox/index.js";
import { canonicalKey, canonicalPath } from "../workspace/canonical-key.js";
import {
  createWorkspaceContext,
  legacySingleRootWorkspace,
} from "../workspace/workspace-context.js";

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
    const fixture = mkdtempSync(join(tmpdir(), "codeshell-run-environment-"));
    try {
      const primary = join(fixture, "primary");
      const secondary = join(fixture, "secondary");
      const secondaryAlias = join(fixture, "secondary-alias");
      mkdirSync(primary);
      mkdirSync(secondary);
      symlinkSync(secondary, secondaryAlias, process.platform === "win32" ? "junction" : "dir");
      const resolver = new RunEnvironmentResolver({
        config: () =>
          ({
            llm: { provider: "x", model: "m" },
            sandbox: {
              ...defaultSandboxConfig("seatbelt"),
              writableRoots: ["${workspace}", secondaryAlias],
            },
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
          { id: "main", path: primary, role: "primary" },
          { id: "docs", path: secondary, role: "secondary" },
        ],
      });

      expect(
        resolver.resolveSandboxConfig({ cwd: primary, workspaceContext }).writableRoots,
      ).toEqual(["${workspace}", secondaryAlias]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("keeps default ${workspace} first and adds each canonical run root exactly once", () => {
    const resolver = new RunEnvironmentResolver({
      config: () => ({ llm: { provider: "x", model: "m" }, headless: true }) as EngineConfig,
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

    const roots = resolver.resolveSandboxConfig({
      cwd: "/repo",
      workspaceContext,
    }).writableRoots;
    const expandedKeys = roots.map((root) => canonicalKey(expandPath(root, "/repo")));

    expect(roots[0]).toBe("${workspace}");
    expect(expandedKeys.filter((key) => key === canonicalKey("/repo"))).toHaveLength(1);
    expect(expandedKeys.filter((key) => key === canonicalKey("/docs"))).toHaveLength(1);
    expect(new Set(expandedKeys).size).toBe(expandedKeys.length);
  });

  it("uses a new cached backend when the canonical run roots change", async () => {
    const resolvedRoots: string[][] = [];
    const resolver = new RunEnvironmentResolver({
      config: () =>
        ({
          llm: { provider: "x", model: "m" },
          sandbox: defaultSandboxConfig("off"),
        }) as EngineConfig,
      settings: () => ({ get: () => ({}), getForScope: () => ({}) }),
      credentialAccess: { envExposures: () => ({}) },
      resolveBackend: async (config) => {
        resolvedRoots.push(config.writableRoots);
        return offBackend;
      },
    });
    const context = (secondary: string, revision: number) =>
      createWorkspaceContext({
        projectId: "project-1",
        projectRevision: revision,
        sessionMainRootId: "main",
        roots: [
          { id: "main", path: "/repo", role: "primary" },
          { id: `secondary-${revision}`, path: secondary, role: "secondary" },
        ],
      });
    const first = { cwd: "/repo", workspaceContext: context("/docs-a", 1) };
    const second = { cwd: "/repo", workspaceContext: context("/docs-b", 2) };

    await resolver.resolveSandbox(first);
    await resolver.resolveSandbox(first);
    await resolver.resolveSandbox(second);

    expect(resolvedRoots).toHaveLength(2);
    expect(resolvedRoots[0]).toContain(canonicalPath("/docs-a"));
    expect(resolvedRoots[1]).toContain(canonicalPath("/docs-b"));
  });
});

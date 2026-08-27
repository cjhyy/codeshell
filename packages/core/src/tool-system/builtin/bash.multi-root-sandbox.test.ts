import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunEnvironmentResolver } from "../../engine/run-environment.js";
import { BackgroundShellManager } from "../../runtime/background-shell.js";
import { createWorkspaceContext } from "../../workspace/workspace-context.js";
import { canonicalPath } from "../../workspace/canonical-key.js";
import type { ToolContext } from "../context.js";
import { createOffBackend } from "../sandbox/off.js";
import { defaultSandboxConfig, type SandboxConfig } from "../sandbox/index.js";
import { bashTool } from "./bash.js";

let fixtureRoot: string | undefined;
let backgroundShells: BackgroundShellManager | undefined;

afterEach(async () => {
  await backgroundShells?.killAll();
  backgroundShells = undefined;
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

describe("Bash multi-root sandbox", () => {
  test("foreground and background shells share the backend resolved with every root", async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "codeshell-bash-multi-root-"));
    const primary = join(fixtureRoot, "primary");
    const secondary = join(fixtureRoot, "secondary");
    mkdirSync(primary);
    mkdirSync(secondary);

    const wrappedCommands: string[] = [];
    const resolvedConfigs: SandboxConfig[] = [];
    const off = createOffBackend();
    const backend = {
      ...off,
      wrap(command: string, options: { cwd: string; shell: string }) {
        wrappedCommands.push(command);
        return off.wrap(command, options);
      },
    };
    const resolver = new RunEnvironmentResolver({
      config: () => ({ sandbox: defaultSandboxConfig("seatbelt") }),
      settings: () => ({ get: () => ({}), getForScope: () => ({}) }),
      credentialAccess: { envExposures: () => ({}) },
      resolveBackend: async (config) => {
        resolvedConfigs.push(config);
        return backend;
      },
    });
    const workspaceContext = createWorkspaceContext({
      projectId: "project-1",
      projectRevision: 1,
      sessionMainRootId: "root-primary",
      roots: [
        { id: "root-primary", path: primary, role: "primary" },
        { id: "root-secondary", path: secondary, role: "secondary" },
      ],
    });
    const sandbox = await resolver.resolveSandbox({ cwd: primary, workspaceContext });
    backgroundShells = new BackgroundShellManager();
    const context = {
      cwd: primary,
      sessionId: "session-1",
      sandbox,
      backgroundShells,
    } as unknown as ToolContext;

    await bashTool({ command: "echo foreground" }, context);
    await bashTool({ command: "echo background", run_in_background: true }, context);

    expect(resolvedConfigs).toHaveLength(1);
    expect(resolvedConfigs[0]?.writableRoots).toEqual(
      expect.arrayContaining([canonicalPath(primary), canonicalPath(secondary)]),
    );
    expect(wrappedCommands).toEqual(["echo foreground", "echo background"]);
  });
});

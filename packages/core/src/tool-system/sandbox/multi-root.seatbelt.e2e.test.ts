import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RunEnvironmentResolver } from "../../engine/run-environment.js";
import { safeSpawnShell } from "../../runtime/safe-spawn.js";
import type { EngineConfig } from "../../engine/types.js";
import { createWorkspaceContext } from "../../workspace/workspace-context.js";
import { detectSandboxCapabilities } from "./index.js";

const IS_DARWIN = process.platform === "darwin";
const HAS_SEATBELT = detectSandboxCapabilities().seatbelt;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

if (!IS_DARWIN) {
  test.skip("real multi-root Seatbelt E2E (requires macOS)", () => {});
} else if (!HAS_SEATBELT) {
  test.skip("real multi-root Seatbelt E2E (sandbox-exec unavailable)", () => {});
} else {
  test("real multi-root Seatbelt E2E writes primary and secondary but denies outside", async () => {
    const fixture = mkdtempSync(join(homedir(), ".codeshell-seatbelt-multi-root-"));
    try {
      const primary = join(fixture, "primary");
      const secondary = join(fixture, "secondary");
      const outside = join(fixture, "outside");
      mkdirSync(primary);
      mkdirSync(secondary);
      mkdirSync(outside);
      const workspaceContext = createWorkspaceContext({
        projectId: "seatbelt-e2e",
        projectRevision: 1,
        sessionMainRootId: "primary",
        roots: [
          { id: "primary", path: primary, role: "primary" },
          { id: "secondary", path: secondary, role: "secondary" },
        ],
      });
      const resolver = new RunEnvironmentResolver({
        config: () => ({ llm: { provider: "test", model: "test" } }) as EngineConfig,
        settings: () => ({
          get: () => ({}),
          getForScope: (scope: string) =>
            scope === "project" ? { sandbox: { mode: "seatbelt" } } : {},
        }),
        credentialAccess: { envExposures: () => ({}) },
      });
      const run = { cwd: primary, workspaceContext };
      const resolved = await resolver.resolve(run);
      expect(resolved.sandboxConfig.mode).toBe("seatbelt");
      expect(resolved.sandbox.name).toBe("seatbelt");

      const primaryFile = join(primary, "primary.txt");
      const secondaryFile = join(secondary, "secondary.txt");
      const outsideFile = join(outside, "outside.txt");
      const executeWrite = (path: string, contents: string) =>
        safeSpawnShell(`printf %s ${shellQuote(contents)} > ${shellQuote(path)}`, {
          cwd: primary,
          env: { PATH: "/usr/bin:/bin" },
          timeoutMs: 5_000,
          shell: "/bin/sh",
          sandbox: resolved.sandbox,
        });

      const primaryWrite = await executeWrite(primaryFile, "primary");
      expect(primaryWrite.reason).toBe("ok");
      expect(primaryWrite.exitCode).toBe(0);
      expect(readFileSync(primaryFile, "utf8")).toBe("primary");

      const secondaryWrite = await executeWrite(secondaryFile, "secondary");
      expect(secondaryWrite.reason).toBe("ok");
      expect(secondaryWrite.exitCode).toBe(0);
      expect(readFileSync(secondaryFile, "utf8")).toBe("secondary");

      const outsideWrite = await executeWrite(outsideFile, "outside");
      expect(outsideWrite.reason).toBe("ok");
      expect(outsideWrite.exitCode).not.toBe(0);
      expect(outsideWrite.stderr).toMatch(/Operation not permitted|sandbox|denied/i);
      expect(existsSync(outsideFile)).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 15_000);
}

import { expect, test } from "bun:test";
import { buildRunToolContext } from "./run-tooling.js";
import { bashTool } from "../tool-system/builtin/bash.js";
import type { ToolContext } from "../tool-system/context.js";

test("per-turn background prohibition is enforced by the real Bash tool and does not relax the base policy", async () => {
  for (const base of [true, false]) {
    for (const perRun of [undefined, true, false]) {
      const context = buildRunToolContext({
        base: { cwd: "/tmp", allowBackgroundShells: base } as ToolContext,
        options: { allowBackgroundShells: perRun },
        runPermissionMode: "default",
        runPlanMode: false,
        cwd: "/tmp",
        profileParams: {},
        reportResult: () => {},
      } as any);
      expect(context.allowBackgroundShells).toBe(base && perRun !== false);
      if (!context.allowBackgroundShells) {
        const result = await bashTool(
          { command: "echo should-not-run", run_in_background: true },
          context,
        );
        expect(result).toMatchObject({ ok: false });
        expect(JSON.stringify(result)).toContain("background shells are not available");
      }
    }
  }
});

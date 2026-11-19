import { describe, expect, it } from "bun:test";
import { HookRegistry } from "../hooks/registry.js";
import type { ApprovalRequest, PermissionMode } from "../types.js";
import type { ToolContext } from "./context.js";
import { ToolExecutor } from "./executor.js";
import { PermissionClassifier } from "./permission.js";
import { ToolRegistry } from "./registry.js";

/**
 * A delegated external worker (DriveAgent) asks through the launching Session's
 * approval path. The seam must answer exactly as a CodeShell tool ask would in
 * that Session's mode, and must keep working after the launching call returned.
 */
describe("ToolContext.requestDelegatedToolApproval", () => {
  async function capture(mode: PermissionMode, approved = true) {
    const asked: ApprovalRequest[] = [];
    const registry = new ToolRegistry({ builtinTools: [] });
    let captured: ToolContext["requestDelegatedToolApproval"];
    registry.registerTool(
      {
        name: "Launch",
        description: "captures the seam",
        inputSchema: { type: "object", properties: {} },
        source: "builtin",
        permissionDefault: "allow",
      },
      async (_args, ctx) => {
        captured = ctx?.requestDelegatedToolApproval;
        return "launched";
      },
    );
    const permission = new PermissionClassifier([{ tool: "Launch", decision: "allow" }], mode, {
      requestApproval: async (request) => {
        asked.push(request);
        return approved ? { approved: true } : { approved: false, reason: "not today" };
      },
    });
    const executor = new ToolExecutor(registry, permission, new HookRegistry());
    executor.setContext({ cwd: process.cwd(), sessionId: "S-DELEGATED" } as ToolContext);
    const result = await executor.executeSingle({ id: "c1", toolName: "Launch", args: {} });
    expect(result.isError).toBeFalsy();
    return { ask: captured!, asked };
  }
  const request = {
    toolName: "Claude Code Bash",
    args: { command: "git status" },
    reason: "Requested by background task «Fix login test» (DriveAgent worker).",
  };

  it("reaches the Session's approval backend, attributed to the Session and the task", async () => {
    const { ask, asked } = await capture("default");
    expect(await ask(request)).toEqual({ approved: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      sessionId: "S-DELEGATED",
      toolName: "Claude Code Bash",
      args: { command: "git status" },
    });
    expect(asked[0]!.description).toContain("background task «Fix login test»");
  });

  it("returns the user's refusal with its reason", async () => {
    const { ask } = await capture("acceptEdits", false);
    expect(await ask(request)).toEqual({ approved: false, reason: "not today" });
  });

  it("approves without prompting under full access and denies without prompting under dontAsk", async () => {
    const full = await capture("bypassPermissions");
    expect(await full.ask(request)).toEqual({ approved: true });
    expect(full.asked).toHaveLength(0);
    const silent = await capture("dontAsk");
    expect((await silent.ask(request)).approved).toBe(false);
    expect(silent.asked).toHaveLength(0);
  });
});

import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../src/tool-system/registry.js";
import { ToolExecutor } from "../src/tool-system/executor.js";
import { PermissionClassifier } from "../src/tool-system/permission.js";
import { HookRegistry } from "../src/hooks/registry.js";

function setupExecutor(classifierRule: "allow" | "deny" | "ask") {
  const registry = new ToolRegistry({ builtinTools: ["Read"] });
  let toolRan = false;
  registry.registerTool(
    { name: "Read", description: "x", inputSchema: { type: "object" } },
    async () => {
      toolRan = true;
      return { id: "ok", toolName: "Read", content: "ran" };
    },
  );
  const permission = new PermissionClassifier(
    [{ tool: "Read", decision: classifierRule }],
    "default",
    { requestApproval: async () => ({ approved: true }) },
  );
  const hooks = new HookRegistry();
  const exec = new ToolExecutor(registry, permission, hooks);
  return {
    exec,
    hooks,
    didToolRun: () => toolRan,
  };
}

describe("on_permission_check hook", () => {
  it("handler can override classifier 'deny' with 'allow'", async () => {
    const { exec, hooks, didToolRun } = setupExecutor("deny");
    let seenClassifierDecision: string | undefined;
    hooks.register("on_permission_check", (ctx) => {
      seenClassifierDecision = ctx.data.classifierDecision as string;
      return { decision: "allow" };
    });

    const result = await exec.executeSingle({
      id: "c1",
      toolName: "Read",
      args: { file_path: "/x" },
    });

    expect(seenClassifierDecision).toBe("deny");
    expect(didToolRun()).toBe(true);
    expect(result.isError).toBeFalsy();
  });

  it("handler can override classifier 'allow' with 'deny'", async () => {
    const { exec, hooks, didToolRun } = setupExecutor("allow");
    hooks.register("on_permission_check", () => ({ decision: "deny" }));

    const result = await exec.executeSingle({
      id: "c2",
      toolName: "Read",
      args: { file_path: "/x" },
    });

    expect(didToolRun()).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("no decision = passthrough (classifier's original decision wins)", async () => {
    const { exec, hooks, didToolRun } = setupExecutor("allow");
    let invoked = false;
    hooks.register("on_permission_check", () => {
      invoked = true;
      return {};
    });

    const result = await exec.executeSingle({
      id: "c3",
      toolName: "Read",
      args: { file_path: "/x" },
    });

    expect(invoked).toBe(true);
    expect(didToolRun()).toBe(true);
    expect(result.isError).toBeFalsy();
  });

  it("handler can downgrade 'deny' to 'ask' and thread messages to the prompt", async () => {
    const registry = new ToolRegistry({ builtinTools: ["Read"] });
    let toolRan = false;
    registry.registerTool(
      { name: "Read", description: "x", inputSchema: { type: "object" } },
      async () => {
        toolRan = true;
        return { id: "ok", toolName: "Read", content: "ran" };
      },
    );
    let approvalReason: string | undefined;
    const permission = new PermissionClassifier(
      [{ tool: "Read", decision: "deny" }],
      "default",
      {
        requestApproval: async (req) => {
          approvalReason = req.description;
          return { approved: true };
        },
      },
    );
    const hooks = new HookRegistry();
    const exec = new ToolExecutor(registry, permission, hooks);
    hooks.register("on_permission_check", () => ({
      decision: "ask",
      messages: ["audit policy: read in /secrets needs explicit ok"],
    }));

    const result = await exec.executeSingle({
      id: "c4",
      toolName: "Read",
      args: { file_path: "/secrets/x" },
    });

    expect(toolRan).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(approvalReason).toContain("audit policy");
  });
});

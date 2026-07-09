import { describe, expect, it } from "bun:test";
import { HookRegistry } from "../hooks/registry.js";
import type { ApprovalRequest, ApprovalResult, RegisteredTool } from "../types.js";
import type { ApprovalBackend } from "./permission.js";
import { PermissionClassifier } from "./permission.js";
import { ToolExecutor } from "./executor.js";
import { ToolRegistry } from "./registry.js";

const TOOL = "PermissionDefaultProbe";

function probeTool(permissionDefault: RegisteredTool["permissionDefault"]): RegisteredTool {
  return {
    name: TOOL,
    description: "permissionDefault metadata probe",
    inputSchema: { type: "object", properties: {} },
    source: "builtin",
    permissionDefault,
  };
}

function backendWith(
  result: ApprovalResult,
  onRequest?: (request: ApprovalRequest) => void,
): ApprovalBackend {
  return {
    requestApproval: async (request) => {
      onRequest?.(request);
      return result;
    },
  };
}

function makeExecutor(options: {
  permissionDefault: RegisteredTool["permissionDefault"];
  permission: PermissionClassifier;
}): { executor: ToolExecutor; didRun: () => boolean } {
  let ran = false;
  const registry = new ToolRegistry({ builtinTools: [] });
  registry.registerTool(probeTool(options.permissionDefault), async () => {
    ran = true;
    return "ran";
  });
  return {
    executor: new ToolExecutor(registry, options.permission, new HookRegistry()),
    didRun: () => ran,
  };
}

describe("RegisteredTool.permissionDefault is UI metadata", () => {
  it("does not auto-allow a default-mode tool whose permissionDefault is allow", async () => {
    let approvalRequests = 0;
    const { executor, didRun } = makeExecutor({
      permissionDefault: "allow",
      permission: new PermissionClassifier(
        [],
        "default",
        backendWith({ approved: false, reason: "user denied" }, () => {
          approvalRequests++;
        }),
      ),
    });

    const result = await executor.executeSingle({ id: "c1", toolName: TOOL, args: {} });

    expect(approvalRequests).toBe(1);
    expect(didRun()).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("does not hard-deny a tool whose permissionDefault is deny when an explicit rule allows it", async () => {
    const { executor, didRun } = makeExecutor({
      permissionDefault: "deny",
      permission: new PermissionClassifier([{ tool: TOOL, decision: "allow" }], "default"),
    });

    const result = await executor.executeSingle({ id: "c1", toolName: TOOL, args: {} });

    expect(didRun()).toBe(true);
    expect(result.result).toBe("ran");
    expect(result.isError).toBeFalsy();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRegistry } from "../hooks/registry.js";
import type {
  ApprovalRequest,
  ApprovalResult,
  PermissionDecision,
  PermissionRule,
  RegisteredTool,
  ToolPathPolicy,
} from "../types.js";
import type { ToolContext } from "./context.js";
import { ToolExecutor } from "./executor.js";
import type { ApprovalBackend } from "./permission.js";
import { PermissionClassifier } from "./permission.js";
import { ToolRegistry } from "./registry.js";
import { runPluginCommandHook } from "../plugins/pluginCommandHook.js";

const PROBE_TOOL = "HookPermissionProbe";

function makeProbeTool(pathPolicy?: ToolPathPolicy[]): RegisteredTool {
  return {
    name: PROBE_TOOL,
    description: "permission hook hardening test probe",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
      },
    },
    source: "builtin",
    permissionDefault: "allow",
    ...(pathPolicy ? { pathPolicy } : {}),
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
  rules: PermissionRule[];
  approvalBackend?: ApprovalBackend;
  pathPolicy?: ToolPathPolicy[];
}): {
  executor: ToolExecutor;
  hooks: HookRegistry;
  didRun: () => boolean;
} {
  let ran = false;
  const registry = new ToolRegistry({ builtinTools: [] });
  registry.registerTool(makeProbeTool(options.pathPolicy), async () => {
    ran = true;
    return "ran";
  });
  const hooks = new HookRegistry();
  const permission = new PermissionClassifier(options.rules, "default", options.approvalBackend);
  const executor = new ToolExecutor(registry, permission, hooks);
  return { executor, hooks, didRun: () => ran };
}

function rule(decision: PermissionDecision): PermissionRule {
  return { tool: PROBE_TOOL, decision };
}

async function runProbe(executor: ToolExecutor, filePath = "/tmp/probe.txt") {
  return executor.executeSingle({
    id: "call-1",
    toolName: PROBE_TOOL,
    args: { file_path: filePath },
  });
}

describe("ToolExecutor permission hook hardening", () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "codeshell-hook-perm-ws-"));
    outside = mkdtempSync(join(tmpdir(), "codeshell-hook-perm-out-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects pre_tool_use allow when the classifier denies the call", async () => {
    const { executor, hooks, didRun } = makeExecutor({ rules: [rule("deny")] });
    hooks.register("pre_tool_use", () => ({ decision: "allow" }));

    const result = await runProbe(executor);

    expect(didRun()).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain(`Permission denied for tool: ${PROBE_TOOL}`);
  });

  it("blocks execution when a CC-compatible plugin exits 2 from pre_tool_use", async () => {
    const { executor, hooks, didRun } = makeExecutor({ rules: [rule("allow")] });
    hooks.register("pre_tool_use", (ctx) =>
      runPluginCommandHook(
        {
          command: "printf '%s' 'rejected by plugin' >&2; exit 2",
          installPath: process.cwd(),
          pluginKey: "deny-test@local",
        },
        ctx,
      ),
    );

    const result = await runProbe(executor);

    expect(didRun()).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain("Blocked by pre_tool_use hook");
    expect(result.error).toContain("rejected by plugin");
  });

  it("keeps the user-approval gate when pre_tool_use allow tries to bypass classifier ask", async () => {
    let approvalRequests = 0;
    const { executor, hooks, didRun } = makeExecutor({
      rules: [rule("ask")],
      approvalBackend: backendWith({ approved: false, reason: "user denied" }, () => {
        approvalRequests++;
      }),
    });
    hooks.register("pre_tool_use", () => ({ decision: "allow" }));

    const result = await runProbe(executor);

    expect(approvalRequests).toBe(1);
    expect(didRun()).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain(`Permission denied by user for tool: ${PROBE_TOOL}`);
  });

  it("does not let pre_tool_use ask bypass a classifier deny rule", async () => {
    let approvalRequests = 0;
    const { executor, hooks, didRun } = makeExecutor({
      rules: [rule("deny")],
      approvalBackend: backendWith({ approved: true }, () => {
        approvalRequests++;
      }),
    });
    hooks.register("pre_tool_use", () => ({
      decision: "ask",
      messages: ["extra confirmation"],
    }));

    const result = await runProbe(executor);

    expect(approvalRequests).toBe(0);
    expect(didRun()).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain(`Permission denied for tool: ${PROBE_TOOL}`);
  });

  it("lets pre_tool_use ask downgrade classifier allow to one user approval", async () => {
    let approvalRequests = 0;
    let description = "";
    const { executor, hooks, didRun } = makeExecutor({
      rules: [rule("allow")],
      approvalBackend: backendWith({ approved: true }, (request) => {
        approvalRequests++;
        description = request.description;
      }),
    });
    hooks.register("pre_tool_use", () => ({
      decision: "ask",
      messages: ["extra confirmation"],
    }));

    const result = await runProbe(executor);

    expect(approvalRequests).toBe(1);
    expect(description).toContain("pre_tool_use");
    expect(description).toContain("extra confirmation");
    expect(didRun()).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(result.result).toBe("ran");
  });

  it("denies when user rejects a pre_tool_use ask downgrade from classifier allow", async () => {
    let approvalRequests = 0;
    const { executor, hooks, didRun } = makeExecutor({
      rules: [rule("allow")],
      approvalBackend: backendWith({ approved: false, reason: "user denied" }, () => {
        approvalRequests++;
      }),
    });
    hooks.register("pre_tool_use", () => ({
      decision: "ask",
      messages: ["extra confirmation"],
    }));

    const result = await runProbe(executor);

    expect(approvalRequests).toBe(1);
    expect(didRun()).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain(`Permission denied by user for tool: ${PROBE_TOOL}`);
  });

  it("merges classifier ask with pre_tool_use ask into a single prompt", async () => {
    let approvalRequests = 0;
    let description = "";
    const { executor, hooks, didRun } = makeExecutor({
      rules: [rule("ask")],
      approvalBackend: backendWith({ approved: true }, (request) => {
        approvalRequests++;
        description = request.description;
      }),
    });
    hooks.register("pre_tool_use", () => ({
      decision: "ask",
      messages: ["extra confirmation"],
    }));

    const result = await runProbe(executor);

    expect(approvalRequests).toBe(1);
    expect(description).toContain("pre_tool_use");
    expect(description).toContain("extra confirmation");
    expect(didRun()).toBe(true);
    expect(result.isError).toBeFalsy();
  });

  it("runs path policy after pre_tool_use allow, before any handler execution", async () => {
    let pathPrompts = 0;
    const { executor, hooks, didRun } = makeExecutor({
      rules: [rule("allow")],
      pathPolicy: [{ kind: "arg", arg: "file_path", operation: "read" }],
    });
    executor.setContext({
      cwd: workspace,
      permissionMode: "default",
      askUser: async () => {
        pathPrompts++;
        return "拒绝";
      },
    } as unknown as ToolContext);
    hooks.register("pre_tool_use", () => ({ decision: "allow" }));

    const result = await runProbe(executor, join(outside, "secret.txt"));

    expect(pathPrompts).toBe(1);
    expect(didRun()).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/path approval denied|blocked by path policy/i);
  });

  it("rejects on_permission_check allow when the classifier denies the call", async () => {
    const { executor, hooks, didRun } = makeExecutor({ rules: [rule("deny")] });
    let seenClassifierDecision: unknown;
    hooks.register("on_permission_check", (ctx) => {
      seenClassifierDecision = ctx.data.classifierDecision;
      return { decision: "allow" };
    });

    const result = await runProbe(executor);

    expect(seenClassifierDecision).toBe("deny");
    expect(didRun()).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain(`Permission denied for tool: ${PROBE_TOOL}`);
  });

  it("does not let on_permission_check ask relax a classifier deny rule", async () => {
    let approvalRequests = 0;
    const { executor, hooks, didRun } = makeExecutor({
      rules: [rule("deny")],
      approvalBackend: backendWith({ approved: true }, () => {
        approvalRequests++;
      }),
    });
    hooks.register("on_permission_check", () => ({
      decision: "ask",
      messages: ["audit wants user confirmation"],
    }));

    const result = await runProbe(executor);

    expect(approvalRequests).toBe(0);
    expect(didRun()).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain(`Permission denied for tool: ${PROBE_TOOL}`);
  });

  it("keeps the user-approval gate when on_permission_check allow tries to bypass classifier ask", async () => {
    let approvalRequests = 0;
    const { executor, hooks, didRun } = makeExecutor({
      rules: [rule("ask")],
      approvalBackend: backendWith({ approved: false, reason: "user denied" }, () => {
        approvalRequests++;
      }),
    });
    hooks.register("on_permission_check", () => ({ decision: "allow" }));

    const result = await runProbe(executor);

    expect(approvalRequests).toBe(1);
    expect(didRun()).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain(`Permission denied by user for tool: ${PROBE_TOOL}`);
  });

  it("allows on_permission_check to downgrade classifier allow to deny", async () => {
    const { executor, hooks, didRun } = makeExecutor({ rules: [rule("allow")] });
    hooks.register("on_permission_check", () => ({ decision: "deny" }));

    const result = await runProbe(executor);

    expect(didRun()).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain(`Permission denied for tool: ${PROBE_TOOL}`);
  });

  it("allows on_permission_check to downgrade classifier allow to ask", async () => {
    let approvalRequests = 0;
    const { executor, hooks, didRun } = makeExecutor({
      rules: [rule("allow")],
      approvalBackend: backendWith({ approved: true }, () => {
        approvalRequests++;
      }),
    });
    hooks.register("on_permission_check", () => ({
      decision: "ask",
      messages: ["audit hook requires confirmation"],
    }));

    const result = await runProbe(executor);

    expect(approvalRequests).toBe(1);
    expect(didRun()).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(result.result).toBe("ran");
  });
});

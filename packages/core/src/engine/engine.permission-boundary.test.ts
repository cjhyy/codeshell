import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { ApprovalRequest, LLMResponse } from "../types.js";
import type { ToolContext } from "../tool-system/context.js";

const provider = "fake-permission-boundary";

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Scenario {
  call: number;
  firstEntered: Deferred;
  releaseFirst: Deferred;
  responses: LLMResponse[];
}

const scenarios = new Map<string, Scenario>();
const tempDirs: string[] = [];

class PermissionBoundaryClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing permission scenario: ${this.model}`);
    if ((options.tools?.length ?? 0) === 0) {
      return stopResponse("auxiliary summary");
    }
    const index = scenario.call++;
    if (index === 0) {
      scenario.firstEntered.resolve();
      await scenario.releaseFirst.promise;
    }
    const response = scenario.responses[index];
    if (!response) throw new Error(`unexpected model call ${index + 1}`);
    this.recordUsage(
      response.usage ?? { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      options,
    );
    return response;
  }
}

registerProvider(provider, PermissionBoundaryClient);

function toolResponse(id: string): LLMResponse {
  return {
    text: "",
    toolCalls: [{ id, toolName: "BoundaryMutation", args: {} }],
    stopReason: "tool_use",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

function stopResponse(text: string): LLMResponse {
  return {
    text,
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

function makeEngine(initialMode: "default" | "bypassPermissions") {
  const cwd = mkdtempSync(join(tmpdir(), "permission-boundary-"));
  tempDirs.push(cwd);
  const model = `${provider}-${Date.now()}-${Math.random()}`;
  const scenario: Scenario = {
    call: 0,
    firstEntered: deferred(),
    releaseFirst: deferred(),
    responses: [
      toolResponse("tool-first"),
      stopResponse("first done"),
      toolResponse("tool-second"),
      stopResponse("second done"),
    ],
  };
  scenarios.set(model, scenario);

  const approvals: ApprovalRequest[] = [];
  const executions: Array<{ planMode: boolean | undefined; permissionMode: string | undefined }> =
    [];
  const engine = new Engine({
    llm: { provider, model, apiKey: "test" } as never,
    cwd,
    sessionStorageDir: join(cwd, "sessions"),
    permissionMode: initialMode,
    approvalBackend: {
      async requestApproval(request) {
        approvals.push(request);
        return { approved: true };
      },
    },
    settingsScope: "isolated",
    headless: true,
    maxTurns: 4,
  });
  engine.registerCustomTool(
    {
      name: "BoundaryMutation",
      description: "A mutating test tool used to verify permission snapshots.",
      inputSchema: { type: "object", properties: {} },
      source: "builtin",
    },
    async (_args, ctx?: ToolContext) => {
      executions.push({ planMode: ctx?.planMode, permissionMode: ctx?.permissionMode });
      return "mutated";
    },
  );
  (engine as any).hooks.clear();
  return { engine, cwd, model, scenario, approvals, executions };
}

afterEach(() => {
  scenarios.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Engine permission context changes at run boundaries", () => {
  it("keeps a busy turn approval-gated and applies bypass to the next turn", async () => {
    const { engine, cwd, scenario, approvals, executions } = makeEngine("default");
    const first = engine.run("first", { sessionId: "permission-boundary", cwd });
    await scenario.firstEntered.promise;

    engine.setPermissionMode("bypassPermissions");
    expect(engine.getPermissionMode()).toBe("default");
    scenario.releaseFirst.resolve();
    await first;

    expect(approvals).toHaveLength(1);
    expect(executions).toEqual([{ planMode: false, permissionMode: "default" }]);

    await engine.run("second", { sessionId: "permission-boundary", cwd });
    expect(approvals).toHaveLength(1);
    expect(executions).toEqual([
      { planMode: false, permissionMode: "default" },
      { planMode: false, permissionMode: "bypassPermissions" },
    ]);
  });

  it("keeps a busy turn out of plan mode and enables the hard gate next turn", async () => {
    const { engine, cwd, scenario, approvals, executions } = makeEngine("bypassPermissions");
    const first = engine.run("first", { sessionId: "plan-boundary", cwd });
    await scenario.firstEntered.promise;

    engine.setPlanMode(true);
    expect(engine.planMode).toBe(false);
    scenario.releaseFirst.resolve();
    await first;

    expect(approvals).toHaveLength(0);
    expect(executions).toEqual([{ planMode: false, permissionMode: "bypassPermissions" }]);

    await engine.run("second", { sessionId: "plan-boundary", cwd });
    expect(approvals).toHaveLength(0);
    expect(executions).toHaveLength(1);
  });

  it("applies an idle serial permission switch to the next run", async () => {
    const { engine, cwd, scenario, approvals, executions } = makeEngine("default");
    engine.setPermissionMode("bypassPermissions");
    scenario.releaseFirst.resolve();

    await engine.run("first", { sessionId: "idle-switch", cwd });

    expect(approvals).toHaveLength(0);
    expect(executions).toEqual([{ planMode: false, permissionMode: "bypassPermissions" }]);
  });
});

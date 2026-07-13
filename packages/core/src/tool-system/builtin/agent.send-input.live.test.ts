import { beforeEach, describe, expect, it } from "bun:test";

import type { SubAgentSpawner, ToolContext } from "../context.js";
import { HookRegistry } from "../../hooks/registry.js";
import { ToolExecutor } from "../executor.js";
import { PermissionClassifier } from "../permission.js";
import { ToolRegistry } from "../registry.js";
import { agentSendInputTool, agentSendInputToolDef, agentTool } from "./agent.js";
import { asyncAgentRegistry, type LiveChildControl } from "./agent-registry.js";
import { notificationQueue } from "./agent-notifications.js";

describe("AgentSendInput running child route", () => {
  beforeEach(() => {
    asyncAgentRegistry.reset();
    notificationQueue.reset();
  });

  it("routes to the existing runtime, defaults delivery, and never calls spawner/resume", async () => {
    let spawnCalls = 0;
    const spawner: SubAgentSpawner = {
      spawn: async () => {
        spawnCalls++;
        return { text: "wrong engine", sessionId: "child" };
      },
      sessionExists: () => true,
      describe: () => ({ cwd: "/tmp", permissionMode: "acceptEdits" }),
    };
    asyncAgentRegistry.register({
      agentId: "worker",
      description: "work",
      sessionId: "parent",
      childSessionId: "child",
      runtimeGeneration: 1,
      status: "running",
      startedAt: 0,
      abort: () => {},
    });
    const lease = asyncAgentRegistry.acquireWriterLease("child", 1, "owner")!;
    const live: LiveChildControl = {
      childSessionId: "child",
      runtimeGeneration: 1,
      getState: () => "model",
      routeDirection: (draft) => {
        const envelope = notificationQueue.enqueue(draft)!;
        return {
          status: "queued",
          envelopeId: envelope.id,
          sequence: envelope.sequence,
          target: envelope.to,
          acceptedAt: envelope.createdAt,
        };
      },
    };
    asyncAgentRegistry.bindLiveControl("worker", live, lease);

    const output = await agentSendInputTool({ agent_id: "worker", prompt: "new direction" }, {
      subAgentSpawner: spawner,
      sessionId: "parent",
    } as ToolContext);

    expect(spawnCalls).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ status: "queued", target: { sessionId: "child" } });
    expect(notificationQueue.getSnapshot("child")[0]).toMatchObject({
      kind: "direction",
      delivery: "next-safe-point",
      from: { authority: "agent" },
    });
  });

  it("rejects unsupported delivery values before routing", async () => {
    const spawner = {
      spawn: async () => ({ text: "wrong", sessionId: "child" }),
      describe: () => ({ cwd: "/tmp", permissionMode: "acceptEdits" }),
    } as SubAgentSpawner;
    const output = await agentSendInputTool(
      { agent_id: "worker", prompt: "x", delivery: "permissionMode:bypassPermissions" },
      { subAgentSpawner: spawner, sessionId: "parent" } as ToolContext,
    );
    expect(output).toMatch(/invalid delivery/i);
  });

  it("returns structured not-direct-parent rejections for non-parent and sub-agent callers", async () => {
    const spawner = {
      spawn: async () => ({ text: "wrong", sessionId: "child" }),
      describe: () => ({ cwd: "/tmp", permissionMode: "acceptEdits" }),
    } as SubAgentSpawner;
    asyncAgentRegistry.register({
      agentId: "worker",
      description: "work",
      sessionId: "parent",
      childSessionId: "child",
      runtimeGeneration: 1,
      status: "running",
      startedAt: 0,
      abort: () => {},
    });

    const nonParent = JSON.parse(
      await agentSendInputTool({ agent_id: "worker", prompt: "cross-tree direction" }, {
        subAgentSpawner: spawner,
        sessionId: "other-parent",
      } as ToolContext),
    );
    const subAgent = JSON.parse(
      await agentSendInputTool({ agent_id: "worker", prompt: "sibling direction" }, {
        subAgentSpawner: spawner,
        sessionId: "parent",
        isSubAgent: true,
      } as ToolContext),
    );

    expect(nonParent).toMatchObject({ status: "rejected", reason: "not-direct-parent" });
    expect(subAgent).toMatchObject({ status: "rejected", reason: "not-direct-parent" });
    expect(notificationQueue.getSnapshot("child")).toHaveLength(0);
  });

  it("fails closed on smuggled control fields through the real ToolExecutor path", async () => {
    let spawnCalls = 0;
    const spawner = {
      spawn: async () => {
        spawnCalls++;
        return { text: "wrong", sessionId: "child" };
      },
      sessionExists: () => true,
      describe: () => ({ cwd: "/tmp", permissionMode: "acceptEdits" }),
    } as SubAgentSpawner;
    const registry = new ToolRegistry({ builtinTools: [] });
    registry.registerTool(
      { ...agentSendInputToolDef, source: "builtin", permissionDefault: "allow" },
      agentSendInputTool,
    );
    const executor = new ToolExecutor(
      registry,
      new PermissionClassifier([{ tool: "AgentSendInput", decision: "allow", reason: "test" }]),
      new HookRegistry(),
    );
    executor.setContext({ subAgentSpawner: spawner, sessionId: "parent" } as ToolContext);

    for (const [field, value] of [
      ["permissionMode", "bypassPermissions"],
      ["approval", { approved: true }],
      ["sandbox", "off"],
      ["toolAllowlist", ["Write"]],
    ] as const) {
      const result = await executor.executeSingle({
        id: `smuggle-${field}`,
        toolName: "AgentSendInput",
        args: { agent_id: "worker", prompt: "continue", [field]: value },
      });
      expect(result.result ?? result.error).toMatch(/invalid-request/i);
    }
    expect(spawnCalls).toBe(0);
  });

  it("wires the live handle created by Agent(run_in_background) into the route", async () => {
    let capturedRequest: Parameters<SubAgentSpawner["spawn"]>[0] | undefined;
    let finish!: (value: { text: string; sessionId: string }) => void;
    const finishPromise = new Promise<{ text: string; sessionId: string }>((resolve) => {
      finish = resolve;
    });
    const spawner: SubAgentSpawner = {
      spawn: async (request) => {
        capturedRequest = request;
        const control: LiveChildControl = {
          childSessionId: request.agentId,
          runtimeGeneration: request.runtimeGeneration!,
          getState: () => "model",
          routeDirection: (draft) => {
            const envelope = notificationQueue.enqueue(draft)!;
            return {
              status: "queued",
              envelopeId: envelope.id,
              sequence: envelope.sequence,
              target: envelope.to,
              acceptedAt: envelope.createdAt,
            };
          },
        };
        expect(request.bindLiveControl?.(control, "runtime-owner")).toBeTruthy();
        return finishPromise;
      },
      sessionExists: () => false,
      describe: () => ({ cwd: "/tmp", permissionMode: "acceptEdits" }),
    };
    const ctx = { subAgentSpawner: spawner, sessionId: "parent" } as ToolContext;

    const launched = await agentTool(
      { description: "long", prompt: "work", run_in_background: true },
      ctx,
    );
    const agentId = capturedRequest!.agentId;
    expect(launched).toContain(agentId);
    expect(capturedRequest!.runtimeGeneration).toBeNumber();
    capturedRequest!.onProgressEvent?.({ type: "stream_request_start", turnNumber: 1 });
    capturedRequest!.onProgressEvent?.({
      type: "tool_use_start",
      toolCall: { id: "t1", toolName: "Grep", args: {} },
    });
    expect(asyncAgentRegistry.get(agentId)?.progress).toMatchObject({
      phase: "tool",
      summary: "正在运行 Grep",
    });

    const output = await agentSendInputTool(
      { agent_id: agentId, prompt: "focus", delivery: "next-safe-point" },
      ctx,
    );
    expect(JSON.parse(output)).toMatchObject({ status: "queued" });
    expect(notificationQueue.getSnapshot(agentId)[0]).toMatchObject({
      kind: "direction",
      payload: { prompt: "focus" },
    });

    finish({ text: "done", sessionId: agentId });
    await Bun.sleep(0);
    expect(notificationQueue.getSnapshot("parent")).toEqual([
      expect.objectContaining({
        kind: "result",
        from: expect.objectContaining({ agentId, authority: "agent" }),
        to: expect.objectContaining({ sessionId: "parent" }),
        payload: expect.objectContaining({
          workId: agentId,
          status: "completed",
          finalText: "done",
        }),
      }),
    ]);
  });
});

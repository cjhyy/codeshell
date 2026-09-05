import { afterEach, describe, expect, test } from "bun:test";
import { agentTool } from "./agent.js";
import { asyncAgentRegistry } from "./agent-registry.js";
import { notificationQueue } from "./agent-notifications.js";
import { wrapChildStream } from "../../engine/subagent-spawner.js";
import type { StreamEvent } from "../../types.js";
import type { SubAgentSpawner, ToolContext } from "../context.js";

afterEach(() => {
  asyncAgentRegistry.reset();
  notificationQueue.reset();
});

describe("explicit background agent activity", () => {
  test("mirrors scoped live operations while retaining the dock transcript", async () => {
    const events: StreamEvent[] = [];
    let finish!: () => void;
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let agentId = "";
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const spawner: SubAgentSpawner = {
      parentStream: (event) => {
        events.push(event);
        if (event.type === "agent_end") complete();
      },
      describe: () => ({ cwd: "/tmp", permissionMode: "acceptEdits" }),
      spawn: async (request) => {
        agentId = request.agentId;
        const emit = wrapChildStream(request.streamOverride, agentId)!;
        emit({ type: "text_delta", text: "Checking the build." });
        emit({
          type: "tool_use_start",
          toolCall: { id: "build", toolName: "Bash", args: {} },
        });
        emit({
          type: "tool_use_args_delta",
          toolCallId: "build",
          toolName: "Bash",
          args: { command: "bun run build" },
        });
        await release;
        emit({
          type: "tool_result",
          result: { id: "build", toolName: "Bash", result: "Build passed", durationMs: 20 },
        });
        return { text: "Build passed", sessionId: agentId };
      },
    };
    try {
      const result = await agentTool(
        { prompt: "Check the build", description: "Build check", run_in_background: true },
        { subAgentSpawner: spawner, sessionId: "activity-parent" } as ToolContext,
      );
      expect(result).toContain(agentId);
      expect(events.map((event) => event.type)).toEqual([
        "agent_start",
        "agent_backgrounded",
        "text_delta",
        "tool_use_start",
        "tool_use_args_delta",
      ]);
      expect(events.every((event) => (event as { agentId?: string }).agentId === agentId)).toBe(
        true,
      );
      expect(asyncAgentRegistry.get(agentId)?.status).toBe("running");
      expect(asyncAgentRegistry.get(agentId)?.transcript).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "assistant_text", text: "Checking the build." }),
          expect.objectContaining({ type: "tool_start", args: { command: "bun run build" } }),
        ]),
      );
    } finally {
      finish();
      await completed;
      await Promise.resolve();
    }
    expect(events.filter((event) => event.type === "tool_result")).toEqual([
      expect.objectContaining({
        agentId,
        result: expect.objectContaining({ result: "Build passed" }),
      }),
    ]);
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    expect(asyncAgentRegistry.get(agentId)?.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_result", result: "Build passed" }),
      ]),
    );
  });

  test("a failing UI callback cannot stop the child or its transcript", async () => {
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let agentId = "";
    const spawner: SubAgentSpawner = {
      parentStream: (event) => {
        if (event.type === "agent_end") complete();
        throw new Error("UI disconnected");
      },
      describe: () => ({ cwd: "/tmp", permissionMode: "acceptEdits" }),
      spawn: async (request) => {
        agentId = request.agentId;
        const emit = wrapChildStream(request.streamOverride, agentId)!;
        emit({ type: "text_delta", text: "Still working" });
        return { text: "Completed", sessionId: agentId };
      },
    };
    await agentTool({ prompt: "Check", run_in_background: true }, {
      subAgentSpawner: spawner,
      sessionId: "activity-parent",
    } as ToolContext);
    await completed;
    await Promise.resolve();
    expect(asyncAgentRegistry.get(agentId)?.status).toBe("completed");
    expect(asyncAgentRegistry.get(agentId)?.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "assistant_text", text: "Still working" }),
      ]),
    );
  });
});

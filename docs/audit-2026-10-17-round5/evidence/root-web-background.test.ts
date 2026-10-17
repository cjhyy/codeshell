import { afterEach, expect, test } from "bun:test";
import { agentTool } from "../../../packages/core/src/tool-system/builtin/agent.ts";
import { asyncAgentRegistry } from "../../../packages/core/src/tool-system/builtin/agent-registry.ts";
import { notificationQueue } from "../../../packages/core/src/tool-system/builtin/agent-notifications.ts";
import { wrapChildStream } from "../../../packages/core/src/engine/subagent-spawner.ts";
import { initialChatState, reduceStream } from "../../../packages/web/src/lib/streamReducer.ts";
import type { SubAgentSpawner, ToolContext } from "../../../packages/core/src/tool-system/context.ts";

afterEach(() => {
  asyncAgentRegistry.reset();
  notificationQueue.reset();
});

test("WEB-R5-01 actual background Agent forwards child text after simulated parent completion", async () => {
  let chat = reduceStream(initialChatState(), { type: "stream_request_start" });
  let finish!: () => void;
  const release = new Promise<void>((resolve) => { finish = resolve; });
  let completed!: () => void;
  const done = new Promise<void>((resolve) => { completed = resolve; });
  const seen: string[] = [];
  let childId = "";
  const spawner: SubAgentSpawner = {
    describe: () => ({ cwd: "/owned", permissionMode: "acceptEdits" }),
    parentStream: (event) => {
      seen.push(event.type);
      chat = reduceStream(chat, event);
      if (event.type === "agent_end") completed();
    },
    spawn: async (request) => {
      childId = request.agentId;
      const emit = wrapChildStream(request.streamOverride, request.agentId)!;
      await release;
      emit({ type: "text_delta", text: "Owned late child result." });
      emit({ type: "assistant_message", text: "Owned late child result." } as any);
      emit({ type: "turn_complete", reason: "completed" } as any);
      return { text: "Owned late child result.", sessionId: request.agentId };
    },
  };
  try {
    const result = await agentTool({ description: "Owned background data", prompt: "Owned prompt", run_in_background: true }, {
      subAgentSpawner: spawner, sessionId: "owned-web-parent",
    } as ToolContext);
    expect(result).toContain(childId);
    expect(seen).toEqual(["agent_start", "agent_backgrounded"]);
    chat = reduceStream(chat, { type: "turn_complete", reason: "completed" });
    expect(chat.run).toBe("completed");
    finish();
    await done;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(asyncAgentRegistry.get(childId)?.status).toBe("completed");
    expect(chat.run).toBe("running");
    expect(chat.items.find((item) => item.kind === "assistant" && item.agentId === childId)).toMatchObject({ text: "Owned late child result.", done: true });
    expect(chat.items.find((item) => item.kind === "subagent" && item.agentId === childId)).toMatchObject({ status: "completed" });
    expect(notificationQueue.drainAll("owned-web-parent")).toHaveLength(1);
  } finally {
    finish();
    await done;
  }
});

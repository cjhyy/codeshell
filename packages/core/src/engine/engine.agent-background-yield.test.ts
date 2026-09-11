import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, StreamEvent } from "../types.js";
import type { SubAgentSpawner, ToolContext } from "../tool-system/context.js";
import { agentTool, agentToolDef } from "../tool-system/builtin/agent.js";
import { asyncAgentRegistry } from "../tool-system/builtin/agent-registry.js";
import {
  buildNotificationMessage,
  notificationQueue,
} from "../tool-system/builtin/agent-notifications.js";
import { Engine } from "./engine.js";

const FINAL_RESULT = "Verified result: the document contains one new row.";
let previousThreshold: string | undefined;
let providerSequence = 0;

beforeEach(() => {
  previousThreshold = process.env.CODE_SHELL_AGENT_BG_MS;
  process.env.CODE_SHELL_AGENT_BG_MS = "20";
  asyncAgentRegistry.reset();
  notificationQueue.reset();
});

afterEach(() => {
  if (previousThreshold === undefined) delete process.env.CODE_SHELL_AGENT_BG_MS;
  else process.env.CODE_SHELL_AGENT_BG_MS = previousThreshold;
  asyncAgentRegistry.reset();
  notificationQueue.reset();
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Background result did not arrive");
    await Bun.sleep(5);
  }
}

function harness(options: { explicit: boolean; headless?: boolean; mixedBatch?: boolean }) {
  const directory = mkdtempSync(join(tmpdir(), "agent-background-yield-"));
  const provider = `agent-background-yield-${++providerSequence}`;
  let launched = false;
  let mainRequests = 0;
  const spawned: string[] = [];
  const events: StreamEvent[] = [];
  let finish!: (text: string) => void;
  const childResult = new Promise<string>((resolve) => {
    finish = resolve;
  });
  class Provider extends LLMClientBase {
    protected initClient(): void {}
    async createMessage(request: CreateMessageOptions): Promise<LLMResponse> {
      const usage = { promptTokens: 10, completionTokens: 1, totalTokens: 11 };
      this.recordUsage(usage, request);
      if (!request.tools?.some((tool) => tool.name === "Agent")) {
        return { text: "Test task", toolCalls: [], stopReason: "stop", usage };
      }
      mainRequests += 1;
      if (!launched) {
        launched = true;
        const toolCalls = [
          {
            id: "detached",
            toolName: "Agent",
            args: {
              prompt: "Read the document",
              description: "Read document",
              ...(options.explicit ? { run_in_background: true } : {}),
            },
          },
        ];
        if (options.mixedBatch) {
          toolCalls.push({
            id: "foreground",
            toolName: "Agent",
            args: {
              prompt: "foreground sibling",
              description: "Quick independent check",
            },
          });
          toolCalls.push({
            id: "second-detached",
            toolName: "Agent",
            args: {
              prompt: "second background sibling",
              description: "Parallel evidence",
              run_in_background: true,
            },
          });
        }
        return { text: "Starting the document check.", toolCalls, stopReason: "tool_use", usage };
      }
      const hasResult = JSON.stringify(request.messages).includes(FINAL_RESULT);
      return {
        text: hasResult ? FINAL_RESULT : "The check is still running in the background.",
        toolCalls: [],
        stopReason: "stop",
        usage,
      };
    }
  }
  registerProvider(provider, Provider);
  const engine = new Engine({
    llm: { provider, model: "test", apiKey: "test" } as never,
    cwd: directory,
    sessionStorageDir: join(directory, "sessions"),
    enabledBuiltinTools: [],
    headless: options.headless === true,
    maxTurns: 5,
    permissionMode: "bypassPermissions",
  });
  (engine as any).hooks.clear();
  engine.registerCustomTool(agentToolDef, (args, ctx?: ToolContext) => {
    const spawner: SubAgentSpawner = {
      describe: () => ({ cwd: directory, permissionMode: "bypassPermissions" }),
      parentStream: (event) => events.push(event),
      spawn: async (request) => {
        spawned.push(request.prompt);
        return {
          text:
            request.prompt === "foreground sibling" ? "Sibling check passed" : await childResult,
          sessionId: request.agentId,
        };
      },
    };
    return agentTool(args, { ...ctx!, subAgentSpawner: spawner });
  });
  const completeEvents = () =>
    events.filter(
      (event): event is Extract<StreamEvent, { type: "turn_complete" }> =>
        event.type === "turn_complete" && !event.agentId,
    );
  return {
    engine,
    directory,
    spawned,
    events,
    finish,
    completeEvents,
    mainRequests: () => mainRequests,
    state: (sessionId: string) =>
      JSON.parse(readFileSync(join(directory, "sessions", sessionId, "state.json"), "utf8")),
    async close() {
      finish(FINAL_RESULT);
      await until(() => asyncAgentRegistry.runningCount() === 0);
      await engine.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("Agent background completion boundaries", () => {
  for (const explicit of [false, true]) {
    test(`${explicit ? "explicit background" : "automatic timeout"} waits first and completes only after the result notification`, async () => {
      const h = harness({ explicit });
      try {
        const initial = await h.engine.run("Check the document and report the actual result", {
          onStream: (event) => h.events.push(event),
        });
        // Regression: the 120-second handoff used to produce a plain completed
        // turn with only "running in background", so Mimi closed the task early.
        expect(h.mainRequests()).toBe(1);
        expect(h.completeEvents()).toEqual([
          {
            type: "turn_complete",
            reason: "completed",
            completionKind: "background_wait",
            text: initial.text,
          },
        ]);
        expect(h.state(initial.sessionId).lastCompletionKind).toBe("background_wait");
        expect(asyncAgentRegistry.hasRunningForSession(initial.sessionId)).toBe(true);
        expect(notificationQueue.getSnapshot(initial.sessionId)).toHaveLength(0);

        h.finish(FINAL_RESULT);
        await until(() => notificationQueue.getSnapshot(initial.sessionId).length === 1);
        // Simulate the protocol host waking the same Session with its actual
        // notification. The child output is model evidence, not a new user ask.
        const result = await h.engine.run(
          buildNotificationMessage(notificationQueue.drainAll(initial.sessionId)),
          {
            sessionId: initial.sessionId,
            injected: true,
            onStream: (event) => h.events.push(event),
          },
        );
        expect(result.text).toBe(FINAL_RESULT);
        expect(result.sessionId).toBe(initial.sessionId);
        expect(h.mainRequests()).toBe(2);
        expect(h.completeEvents()).toEqual([
          {
            type: "turn_complete",
            reason: "completed",
            completionKind: "background_wait",
            text: initial.text,
          },
          { type: "turn_complete", reason: "completed", text: result.text },
        ]);
        expect(h.state(initial.sessionId).lastCompletionKind).toBeUndefined();
      } finally {
        await h.close();
      }
    });

    test(`${explicit ? "explicit background" : "automatic timeout"} still returns the final result to a headless caller`, async () => {
      const h = harness({ explicit, headless: true });
      try {
        const run = h.engine.run("Check the document", {
          onStream: (event) => h.events.push(event),
        });
        await until(() => h.events.some((event) => event.type === "agent_backgrounded"));
        expect(h.completeEvents()).toHaveLength(0);
        h.finish(FINAL_RESULT);
        const result = await run;
        expect(result.text).toBe(FINAL_RESULT);
        expect(h.completeEvents()).toEqual([
          { type: "turn_complete", reason: "completed", text: result.text },
        ]);
        expect(h.state(result.sessionId).lastCompletionKind).toBeUndefined();
      } finally {
        await h.close();
      }
    });
  }

  test("finishes all foreground siblings and launches all background siblings in the same tool batch", async () => {
    const h = harness({ explicit: true, mixedBatch: true });
    try {
      const initial = await h.engine.run("Run the independent checks together", {
        onStream: (event) => h.events.push(event),
      });
      expect(h.spawned).toEqual(
        expect.arrayContaining([
          "Read the document",
          "foreground sibling",
          "second background sibling",
        ]),
      );
      expect(h.events).toContainEqual(
        expect.objectContaining({ type: "agent_end", text: "Sibling check passed" }),
      );
      expect(h.completeEvents()).toEqual([
        {
          type: "turn_complete",
          reason: "completed",
          completionKind: "background_wait",
          text: initial.text,
        },
      ]);
      h.finish(FINAL_RESULT);
      await until(() => notificationQueue.getSnapshot(initial.sessionId).length === 2);
      expect(h.mainRequests()).toBe(1);
    } finally {
      await h.close();
    }
  });
});

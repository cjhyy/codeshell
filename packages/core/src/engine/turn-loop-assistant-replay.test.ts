import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../context/manager.js";
import { HookRegistry } from "../hooks/registry.js";
import { LLMClientBase } from "../llm/client-base.js";
import type { CreateMessageOptions } from "../llm/types.js";
import { Transcript } from "../session/transcript.js";
import { installPromptPrefixGuard } from "../testing/prompt-prefix-guard.js";
import type { LLMResponse, Message, ToolCall } from "../types.js";
import { ModelFacade } from "./model-facade.js";
import { TurnLoop, type TurnLoopDeps } from "./turn-loop.js";

installPromptPrefixGuard({ beforeEach, afterEach });

class OfflineClient extends LLMClientBase {
  readonly requests: Message[][] = [];
  constructor(private readonly responses: LLMResponse[]) {
    super({ provider: "openai", model: "offline-assistant-replay" });
  }
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    this.requests.push(structuredClone(options.messages));
    const response = this.responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  }
}

function loop(client: OfflineClient, transcript: Transcript): TurnLoop {
  const contextManager = new ContextManager({ maxTokens: 1_000_000 });
  contextManager.setPromptCacheSessionKey("assistant-replay");
  return new TurnLoop(
    {
      model: new ModelFacade(client, transcript),
      contextManager,
      hooks: new HookRegistry(),
      transcript,
      systemPrompt: "offline replay fixture",
      tools: [],
      sessionId: "assistant-replay",
      ctxOverheadStore: { get: () => 0, set: () => {} },
      toolExecutor: {
        setLogger() {},
        getInvestigationGuard() {
          return undefined;
        },
        getTaskGuard() {
          return undefined;
        },
        isConcurrencySafe() {
          return false;
        },
        async executeSingle(call: ToolCall) {
          return { id: call.id, toolName: call.toolName, result: "local result" };
        },
      } as unknown as TurnLoopDeps["toolExecutor"],
    },
    { maxTurns: 4, maxToolCallsPerTurn: 10 },
  );
}

const answer = (text: string, reasoningContent?: string): LLMResponse => ({
  text,
  reasoningContent,
  toolCalls: [],
  stopReason: "stop",
  usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
});

test("reasoning and plain responses retain exact shapes in live runs and disk replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "assistant-replay-"));
  try {
    const path = join(directory, "transcript.jsonl");
    const transcript = new Transcript(path);
    transcript.appendMessage("user", "first task");
    const client = new OfflineClient([
      {
        ...answer("working", "reason before tool"),
        stopReason: "tool_use",
        toolCalls: [{ id: "read", toolName: "Read", args: { path: "local" } }],
      },
      answer("first done", "reason before answer"),
      answer("second done"),
    ]);
    const first = await loop(client, transcript).run(transcript.toMessages());
    expect(first.reason).toBe("completed");
    expect(first.messages).toEqual(transcript.toMessages());
    transcript.appendMessage("user", "second task");
    const second = await loop(client, transcript).run([
      ...first.messages,
      { role: "user", content: "second task" },
    ]);
    expect(second.reason).toBe("completed");
    expect(second.messages).toEqual(transcript.toMessages());
    expect(second.messages.at(-1)!.content).toBe("second done");

    const reloaded = Transcript.loadFromFile(path);
    expect(reloaded.toMessages()).toEqual(second.messages);
    reloaded.appendMessage("user", "third task");
    const resumedClient = new OfflineClient([answer("third done")]);
    const third = await loop(resumedClient, reloaded).run(reloaded.toMessages());
    expect(third.reason).toBe("completed");
    expect(third.messages).toEqual(reloaded.toMessages());
    const requests = [...client.requests, ...resumedClient.requests];
    for (let index = 1; index < requests.length; index++) {
      expect(requests[index]!.slice(0, requests[index - 1]!.length)).toEqual(requests[index - 1]!);
    }
    const reasoning = requests
      .at(-1)!
      .flatMap((message) =>
        Array.isArray(message.content)
          ? message.content
              .filter((block) => block.type === "reasoning")
              .map((block) => block.reasoningContent)
          : [],
      );
    expect(reasoning).toEqual(["reason before tool", "reason before answer"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

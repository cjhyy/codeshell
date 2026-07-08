import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { estimateTokens } from "../context/compaction.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, Message, StreamEvent } from "../types.js";
import { Engine } from "./engine.js";

const provider = "fake-context-anchor";
const responses = new Map<string, LLMResponse>();

class ContextAnchorClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const response = responses.get(this.model) ?? {
      text: "ok",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 321, completionTokens: 1, totalTokens: 322 },
    };
    this.recordUsage(
      response.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      options,
    );
    return response;
  }
}

registerProvider(provider, ContextAnchorClient);

function uniqueModel(name: string): string {
  return `${provider}-${name}-${Date.now()}-${Math.random()}`;
}

function makeEngine(dir: string, model: string): Engine {
  const engine = new Engine({
    llm: { provider, model, apiKey: "test" } as never,
    cwd: dir,
    sessionStorageDir: join(dir, "sessions"),
    enabledBuiltinTools: [],
    maxTurns: 1,
    headless: true,
    permissionMode: "bypassPermissions",
  });
  (engine as any).hooks.clear();
  return engine;
}

describe("Engine context usage anchor", () => {
  it("persists the provider prompt-token anchor in session state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-context-anchor-"));
    const model = uniqueModel("persist");
    responses.set(model, {
      text: "ok",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 12_345, completionTokens: 7, totalTokens: 12_352 },
    });

    try {
      const engine = makeEngine(dir, model);

      const result = await engine.run("remember this", {
        sessionId: "ctx-anchor-persist",
        cwd: dir,
      });
      const resumed = engine.getSessionManager().resume(result.sessionId);

      expect(resumed.state.contextUsageAnchor).toMatchObject({
        promptTokens: 12_345,
        provider,
        model,
      });
      expect(resumed.state.contextUsageAnchor?.messageCount).toBeGreaterThan(0);
      expect(resumed.state.contextUsageAnchor?.estimateAtAnchor).toBeGreaterThan(0);
      expect(resumed.state.contextUsageAnchor?.recordedAt).toBeGreaterThan(0);
    } finally {
      responses.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses a compatible persisted anchor for the resumed session-start estimate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-context-anchor-"));
    const model = uniqueModel("resume");
    const priorMessages: Message[] = [{ role: "user", content: "prior " + "content ".repeat(20) }];
    const nextMessage: Message = { role: "user", content: "next" };
    const actualPromptTokens = estimateTokens(priorMessages) * 3;
    const expectedPromptTokens = actualPromptTokens + estimateTokens([nextMessage]);
    const events: StreamEvent[] = [];
    responses.set(model, {
      text: "ok",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    try {
      const engine = makeEngine(dir, model);
      const session = engine.getSessionManager().create(dir, model, provider, "ctx-anchor-resume");
      session.transcript.appendMessage("user", priorMessages[0]!.content);
      session.state.contextUsageAnchor = {
        promptTokens: actualPromptTokens,
        messageCount: priorMessages.length,
        estimateAtAnchor: estimateTokens(priorMessages),
        recordedAt: Date.now(),
      };
      engine.getSessionManager().saveState(session.state);

      await engine.run(nextMessage.content as string, {
        sessionId: "ctx-anchor-resume",
        cwd: dir,
        onStream: (event) => {
          events.push(event);
        },
      });

      const started = events.find(
        (event): event is Extract<StreamEvent, { type: "session_started" }> =>
          event.type === "session_started",
      );
      expect(started?.promptTokens).toBe(expectedPromptTokens);
    } finally {
      responses.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

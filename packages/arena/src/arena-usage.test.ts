import { describe, expect, it } from "bun:test";

import {
  LLMClientBase,
  registerProvider,
  type CreateMessageOptions,
  type LLMResponse,
  type TokenUsage,
} from "@cjhyy/code-shell-core/extension";
import { Arena } from "./arena.js";

const provider = "fake-arena-usage";
const CALL_USAGE: TokenUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

class ArenaUsageClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const response: LLMResponse = {
      text: "{}",
      toolCalls: [],
      stopReason: "stop",
      usage: CALL_USAGE,
    };
    this.recordUsage(CALL_USAGE, options);
    return response;
  }
}

registerProvider(provider, ArenaUsageClient);

describe("Arena usage accounting", () => {
  it("returns usage aggregated across its multi-phase provider calls", async () => {
    const participant = (name: string) => ({
      name,
      llm: { provider, model: `${name}-model`, apiKey: "test" } as never,
    });
    const arena = new Arena({
      participants: [participant("one"), participant("two")],
      mode: "discussion",
      enableContextTools: false,
    });

    const result = await arena.run("Discuss accounting trade-offs", {
      mode: "discussion",
      base: "HEAD",
    });

    // Two participant-research calls, two force-conclude calls (the fake
    // response is empty), and one consensus call. Empty findings intentionally
    // skip verification/debate/adjudication.
    expect(result.usage).toEqual({
      promptTokens: 50,
      completionTokens: 25,
      totalTokens: 75,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});

import { describe, it, expect } from "bun:test";
import { buildSessionTitle } from "./session-title.js";
import type { LLMClientBase } from "../llm/client-base.js";

function fakeClient(text: string, opts?: { throws?: boolean }): LLMClientBase {
  return {
    provider: "fake",
    model: "fake",
    createMessage: async () => {
      if (opts?.throws) throw new Error("boom");
      return {
        text,
        toolCalls: [],
        stopReason: "end_turn",
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    },
    getUsage: () => ({
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
    }),
  } as unknown as LLMClientBase;
}

describe("buildSessionTitle", () => {
  it("returns a trimmed one-line title from the LLM", async () => {
    const title = await buildSessionTitle(
      fakeClient("  修复登录超时问题  \n"),
      "帮我看看登录为什么会超时",
      "登录超时通常是因为...",
    );
    expect(title).toBe("修复登录超时问题");
  });

  it("strips surrounding quotes the model sometimes adds", async () => {
    const title = await buildSessionTitle(fakeClient('"配置热切换设计"'), "q", "a");
    expect(title).toBe("配置热切换设计");
  });

  it("returns null when the LLM throws (best-effort)", async () => {
    const title = await buildSessionTitle(fakeClient("x", { throws: true }), "q", "a");
    expect(title).toBeNull();
  });

  it("returns null when the model yields empty text", async () => {
    const title = await buildSessionTitle(fakeClient("   "), "q", "a");
    expect(title).toBeNull();
  });
});

import { describe, it, expect } from "bun:test";
import { ModelFacade } from "./model-facade.js";
import type { LLMClientBase } from "../llm/client-base.js";
import type { LLMResponse } from "../types.js";
import { ContextLimitError, LLMError } from "../exceptions.js";

// Minimal fake transcript — ModelFacade only calls appendMessage on success.
const fakeTranscript = { appendMessage: () => {} } as never;

function ok(text: string): LLMResponse {
  return { text, toolCalls: [], stopReason: "stop", usage: undefined } as never;
}

/** A fake client whose createMessage runs the supplied behavior. */
function fakeClient(
  model: string,
  behavior: () => Promise<LLMResponse>,
): LLMClientBase {
  return {
    provider: "openai",
    model,
    createMessage: behavior,
    getUsage: () => ({ totalCompletionTokens: 0 }),
  } as unknown as LLMClientBase;
}

describe("ModelFacade model fallback (TODO 7.2)", () => {
  it("returns the primary result when it succeeds", async () => {
    const primary = fakeClient("primary", () => Promise.resolve(ok("from-primary")));
    const fb = fakeClient("fb", () => Promise.resolve(ok("from-fb")));
    const mf = new ModelFacade(primary, fakeTranscript, [fb]);
    const r = await mf.callWithoutStreaming("sys", [], []);
    expect(r.text).toBe("from-primary");
  });

  it("falls back to the next client on a terminal error", async () => {
    const primary = fakeClient("primary", () =>
      Promise.reject(new LLMError("500 boom", "openai")),
    );
    const fb = fakeClient("fb", () => Promise.resolve(ok("from-fb")));
    const mf = new ModelFacade(primary, fakeTranscript, [fb]);
    const r = await mf.callWithoutStreaming("sys", [], []);
    expect(r.text).toBe("from-fb");
  });

  it("tries fallbacks in order and returns the first success", async () => {
    const primary = fakeClient("primary", () => Promise.reject(new LLMError("boom", "openai")));
    const fb1 = fakeClient("fb1", () => Promise.reject(new LLMError("boom2", "openai")));
    const fb2 = fakeClient("fb2", () => Promise.resolve(ok("from-fb2")));
    const mf = new ModelFacade(primary, fakeTranscript, [fb1, fb2]);
    const r = await mf.callWithoutStreaming("sys", [], []);
    expect(r.text).toBe("from-fb2");
  });

  it("throws the last error when every client fails", async () => {
    const primary = fakeClient("primary", () => Promise.reject(new LLMError("p", "openai")));
    const fb = fakeClient("fb", () => Promise.reject(new LLMError("f-last", "openai")));
    const mf = new ModelFacade(primary, fakeTranscript, [fb]);
    await expect(mf.callWithoutStreaming("sys", [], [])).rejects.toThrow("f-last");
  });

  it("does NOT fall back on a context-limit error", async () => {
    const primary = fakeClient("primary", () =>
      Promise.reject(new ContextLimitError("too big")),
    );
    let fbCalled = false;
    const fb = fakeClient("fb", () => {
      fbCalled = true;
      return Promise.resolve(ok("from-fb"));
    });
    const mf = new ModelFacade(primary, fakeTranscript, [fb]);
    await expect(mf.callWithoutStreaming("sys", [], [])).rejects.toThrow();
    expect(fbCalled).toBe(false);
  });

  it("does nothing special when no fallbacks are configured", async () => {
    const primary = fakeClient("primary", () => Promise.reject(new LLMError("p", "openai")));
    const mf = new ModelFacade(primary, fakeTranscript);
    await expect(mf.callWithoutStreaming("sys", [], [])).rejects.toThrow("p");
  });
});

import { describe, it, expect } from "bun:test";
import { estimateTokens } from "./compaction.js";
import { ContextManager } from "./manager.js";
import type { Message } from "../types.js";

function textConversation(rounds: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: "user", content: `question ${i} ` + "lorem ipsum ".repeat(500) });
    msgs.push({ role: "assistant", content: `answer ${i} ` + "dolor sit amet ".repeat(500) });
  }
  return msgs;
}

function readPair(id: string, filePath: string, body: string): Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Read", input: { file_path: filePath } }],
    } as unknown as Message,
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: body }],
    } as unknown as Message,
  ];
}

function browserSnapshot(id: string, body: string): Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "browser_observe", input: {} }],
    } as unknown as Message,
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: body }],
    } as unknown as Message,
  ];
}

function resultContent(messages: Message[], toolUseId: string): string | undefined {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
        return typeof block.content === "string" ? block.content : undefined;
      }
    }
  }
  return undefined;
}

describe("ContextManager.manageAsync micro no-op escalation", () => {
  it("runs always-on cleanup before async compaction gates", async () => {
    const mgr = new ContextManager({ maxTokens: 200_000 });
    const messages: Message[] = [
      ...readPair("r1", "/proj/a.ts", "old file body"),
      ...readPair("r2", "/proj/a.ts", "new file body"),
      ...browserSnapshot("s1", "[ref=e1] stale browser snapshot"),
      ...browserSnapshot("s2", "[ref=e1] current browser snapshot"),
    ];
    expect(estimateTokens(messages)).toBeLessThan(200_000 * 0.7);

    const result = await mgr.manageAsync(messages);

    expect(resultContent(result, "r1")).toContain("superseded by a newer Read");
    expect(resultContent(result, "r2")).toBe("new file body");
    expect(resultContent(result, "s1")).toContain("collapsed");
    expect(resultContent(result, "s2")).toBe("[ref=e1] current browser snapshot");
  });

  it("summarizes a text-only conversation in the 0.7-0.85 spin band", async () => {
    const mgr = new ContextManager({ maxTokens: 200_000 });
    let summarizeCalls = 0;
    mgr.setSummarizeFn(async () => {
      summarizeCalls++;
      return "SUMMARY: " + "the prior text-only discussion was condensed. ".repeat(4);
    });

    const messages = textConversation(32);
    const before = estimateTokens(messages);
    expect(before).toBeGreaterThanOrEqual(200_000 * 0.7);
    expect(before).toBeLessThan(200_000 * 0.85);

    const result = await mgr.manageAsync(messages);
    const after = estimateTokens(result);

    expect(summarizeCalls).toBe(1);
    expect(after).toBeLessThan(before);
  });

  it("passes the run AbortSignal to summarizeFn", async () => {
    const mgr = new ContextManager({ maxTokens: 200_000 });
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    mgr.setSummarizeFn(async (_prompt, signal) => {
      receivedSignal = signal;
      return "SUMMARY: " + "the prior discussion was condensed safely. ".repeat(4);
    });

    await mgr.manageAsync(textConversation(32), controller.signal);

    expect(receivedSignal).toBe(controller.signal);
  });

  it("does not summarize below the microcompact floor", async () => {
    const mgr = new ContextManager({ maxTokens: 200_000 });
    let summarizeCalls = 0;
    mgr.setSummarizeFn(async () => {
      summarizeCalls++;
      return "SUMMARY: " + "this should not be used. ".repeat(4);
    });

    const messages = textConversation(28);
    const before = estimateTokens(messages);
    expect(before).toBeLessThan(200_000 * 0.7);

    const result = await mgr.manageAsync(messages);
    const after = estimateTokens(result);

    expect(summarizeCalls).toBe(0);
    expect(after).toBe(before);
  });

  it("still summarizes at or above the compact ratio", async () => {
    const mgr = new ContextManager({ maxTokens: 200_000 });
    let summarizeCalls = 0;
    mgr.setSummarizeFn(async () => {
      summarizeCalls++;
      return "SUMMARY: " + "the over-threshold conversation was condensed. ".repeat(4);
    });

    const messages = textConversation(40);
    const before = estimateTokens(messages);
    expect(before).toBeGreaterThanOrEqual(200_000 * 0.85);

    const result = await mgr.manageAsync(messages);
    const after = estimateTokens(result);

    expect(summarizeCalls).toBe(1);
    expect(after).toBeLessThan(before);
  });

  it("does not repeatedly summarize after an escalated summary makes no progress", async () => {
    const mgr = new ContextManager({ maxTokens: 200_000 });
    let summarizeCalls = 0;
    mgr.setSummarizeFn(async () => {
      summarizeCalls++;
      return "NO-PROGRESS ".repeat(100_000);
    });

    const messages = textConversation(32);
    const before = estimateTokens(messages);
    expect(before).toBeGreaterThanOrEqual(200_000 * 0.7);
    expect(before).toBeLessThan(200_000 * 0.85);

    const first = await mgr.manageAsync(messages);
    expect(summarizeCalls).toBe(1);
    expect(estimateTokens(first)).toBe(before);

    await mgr.manageAsync(first);
    expect(summarizeCalls).toBe(1);
  });
});

describe("ContextManager.manageAsync compaction ladder", () => {
  it("continues to snip when summary compaction still exceeds the anchored gate", async () => {
    const maxTokens = 200_000;
    const mgr = new ContextManager({ maxTokens });
    const strategies: string[] = [];
    mgr.setOnCompact(({ strategy }) => {
      strategies.push(strategy);
    });
    mgr.setSummarizeFn(async () => {
      return "SUMMARY: " + "the prior long discussion was condensed. ".repeat(4);
    });

    const messages = textConversation(80);
    const heuristicBefore = estimateTokens(messages);
    mgr.recordActualUsage(heuristicBefore * 2, messages.length, messages);

    const result = await mgr.manageAsync(messages);
    const { tokens } = mgr.checkLimits(result);

    expect(strategies).toEqual(["summary", "snip"]);
    expect(tokens).toBeLessThanOrEqual(maxTokens * 0.85);
  });

  it("does not run fallback tiers when summary compaction gets below the gate", async () => {
    const mgr = new ContextManager({ maxTokens: 200_000 });
    const strategies: string[] = [];
    mgr.setOnCompact(({ strategy }) => {
      strategies.push(strategy);
    });
    mgr.setSummarizeFn(async () => {
      return "SUMMARY: " + "the prior long discussion was condensed. ".repeat(4);
    });

    const messages = textConversation(80);
    const before = estimateTokens(messages);
    expect(before).toBeGreaterThan(200_000 * 0.85);

    const result = await mgr.manageAsync(messages);
    const after = estimateTokens(result);

    expect(strategies).toEqual(["summary"]);
    expect(after).toBeLessThanOrEqual(200_000 * 0.85);
  });
});

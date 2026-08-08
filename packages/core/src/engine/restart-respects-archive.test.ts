import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMConfig, LLMResponse } from "../types.js";

const ANCHORED_OPEN = "<anchored-summary";

// Fake provider for the second scenario (archiveTurnRange with a real
// summarizer). Returns a long, fixed "summary" so summarizeRange's
// length>50 rejection gate does not swallow it.
const fakeProvider = "fake-restart-respects-archive";
const SUMMARY_TEXT =
  "The user and assistant discussed the old topic at length before moving on to the new topic.";

class FakeSummarizerClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(_options: CreateMessageOptions): Promise<LLMResponse> {
    this.recordUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    return {
      text: SUMMARY_TEXT,
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}
registerProvider(fakeProvider, FakeSummarizerClient);

describe("restart respects persisted archive boundary", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-restart-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeEngine(): Engine {
    const engine = new Engine({
      // Unregistered provider name: createLLMClient throws synchronously, so
      // prepareContextManagerForSession's catch fires and no summarizeFn ever
      // gets wired — fast, no network I/O, and irrelevant to this test since
      // the marker is appended directly (no summarization needed).
      llm: {
        provider: "no-such-provider",
        model: "does-not-exist",
        apiKey: "",
      } satisfies LLMConfig,
      cwd: dir,
      sessionStorageDir: join(dir, "sessions"),
      headless: true,
    });
    (engine as any).hooks.clear();
    return engine;
  }

  it("a fresh Engine (simulated restart) replays trimmed context", async () => {
    const engineA = makeEngine();
    const bundle = (engineA as any).sessionManager.create(dir, "does-not-exist", "openai");
    const sessionId = bundle.state.sessionId;
    for (let i = 0; i < 20; i += 1) {
      bundle.transcript.appendMessage("user", `旧消息${i}`, { clientMessageId: `old-${i}` });
      bundle.transcript.appendMessage("assistant", `旧回复${i}`);
    }
    bundle.transcript.appendMessage("user", "当前切片", { clientMessageId: "current" });

    const appended = await engineA.appendArchiveMarker(sessionId, {
      summary: "20轮旧对话的摘要",
      toClientMessageId: "current",
      segmentId: "seg-old",
    });
    expect(appended).toBe(true);

    // 模拟重启：全新 Engine 实例（同一 sessions 目录），进程内缓存为空
    const engineB = makeEngine();
    const resumed = (engineB as any).sessionManager.resume(sessionId);
    // 分层断言：先确认标记确实持久化到磁盘并被新进程加载到，再确认回放
    // (toMessages) 生效——这样机制回归时报错能区分"没持久化/没加载/回放没生效"三层。
    expect(resumed.transcript.getEvents("range_archive")).toHaveLength(1);
    const messages = resumed.transcript.toMessages();
    const texts = messages.map((m: { content: unknown }) =>
      typeof m.content === "string" ? m.content : "",
    );

    expect(messages).toHaveLength(2); // 摘要 + 当前切片
    expect(texts[0]).toContain("20轮旧对话的摘要");
    expect(texts[0]).toContain(ANCHORED_OPEN); // envelope survives restart (rolling-merge contract)
    expect(texts[1]).toBe("当前切片");
    // 摘要文本本身不含"旧消息"字样，所以这一断言能钉住全部 20 条旧消息
    // 被裁剪，而不只是抽查第 3 条。
    expect(texts.some((x: string) => x.includes("旧消息"))).toBe(false);
  });

  it("a fresh Engine also honors a marker written by archiveTurnRange with a real summarizer", async () => {
    const summarizerDir = mkdtempSync(join(tmpdir(), "cs-restart-sum-"));
    try {
      const engineA = new Engine({
        llm: {
          provider: fakeProvider,
          model: "fake-model",
          apiKey: "test",
        } satisfies LLMConfig,
        cwd: summarizerDir,
        sessionStorageDir: join(summarizerDir, "sessions"),
        headless: true,
      });
      (engineA as any).hooks.clear();

      const bundle = (engineA as any).sessionManager.create(
        summarizerDir,
        "fake-model",
        fakeProvider,
      );
      bundle.transcript.appendMessage("user", "旧话题", { clientMessageId: "m1" });
      bundle.transcript.appendMessage("assistant", "旧回复");
      bundle.transcript.appendMessage("user", "新话题", { clientMessageId: "m2" });
      const sessionId = bundle.state.sessionId;

      const result = await engineA.archiveTurnRange(
        sessionId,
        { start: 0, end: 2 },
        { toClientMessageId: "m2", fromClientMessageId: "m1", segmentId: "seg-real" },
      );
      expect(result.after).not.toBe(result.before);

      // 模拟重启：全新 Engine 实例（同一 sessions 目录）
      const engineB = new Engine({
        llm: {
          provider: fakeProvider,
          model: "fake-model",
          apiKey: "test",
        } satisfies LLMConfig,
        cwd: summarizerDir,
        sessionStorageDir: join(summarizerDir, "sessions"),
        headless: true,
      });
      (engineB as any).hooks.clear();

      const resumed = (engineB as any).sessionManager.resume(sessionId);
      // 分层断言：先确认标记确实持久化并被新进程加载到，再确认回放生效。
      expect(resumed.transcript.getEvents("range_archive")).toHaveLength(1);
      const texts = resumed.transcript
        .toMessages()
        .map((m: { content: unknown }) => (typeof m.content === "string" ? m.content : ""));

      expect(texts.some((x: string) => x.includes(SUMMARY_TEXT))).toBe(true);
      expect(texts.some((x: string) => x === "旧话题")).toBe(false);
      expect(texts.some((x: string) => x === "新话题")).toBe(true);
    } finally {
      rmSync(summarizerDir, { recursive: true, force: true });
    }
  });
});

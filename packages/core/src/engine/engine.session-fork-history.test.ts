import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { ContentBlock, LLMResponse, Message } from "../types.js";
import { Engine } from "./engine.js";

const provider = "fake-session-fork-history";
const calls = new Map<string, Message[][]>();

class ForkHistoryClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    calls.get(this.model)?.push(structuredClone(options.messages));
    const usage = { promptTokens: 10, completionTokens: 1, totalTokens: 11 };
    this.recordUsage(usage, options);
    return { text: "continued", toolCalls: [], stopReason: "stop", usage };
  }
}

registerProvider(provider, ForkHistoryClient);

describe("Engine first turn after a session fork", () => {
  let dir: string | undefined;
  let model: string | undefined;

  afterEach(() => {
    if (model) calls.delete(model);
    if (dir) rmSync(dir, { recursive: true, force: true });
    model = undefined;
    dir = undefined;
  });

  test("sends copied legal tool history followed by the new user message", async () => {
    dir = mkdtempSync(join(tmpdir(), "engine-session-fork-"));
    model = `${provider}-${Date.now()}-${Math.random()}`;
    calls.set(model, []);
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
    const manager = engine.getSessionManager();
    const source = manager.create(dir, model, provider, "fork-source");
    source.transcript.appendMessage("user", "inspect the file");
    source.transcript.appendMessage("assistant", [
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "a.ts" } },
    ]);
    source.transcript.appendToolUse("Read", "read-1", { file_path: "a.ts" });
    source.transcript.appendToolResult("read-1", "Read", "file contents");
    manager.fork("fork-source", { targetSessionId: "fork-target" });

    await engine.run("continue from the fork", {
      sessionId: "fork-target",
      cwd: dir,
    });

    const providerCalls = calls.get(model)!;
    expect(providerCalls).toHaveLength(1);
    const messages = providerCalls[0]!;
    const originalUser = messages.findIndex((message) => message.content === "inspect the file");
    const assistantUse = messages.findIndex(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === "tool_use" && block.id === "read-1"),
    );
    const userResult = messages.findIndex(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some(
          (block) => block.type === "tool_result" && block.tool_use_id === "read-1",
        ),
    );
    const newUser = messages.findIndex((message) => message.content === "continue from the fork");

    expect([originalUser, assistantUse, userResult, newUser]).toEqual([
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(originalUser).toBeGreaterThanOrEqual(0);
    expect(originalUser).toBeLessThan(assistantUse);
    expect(assistantUse).toBeLessThan(userResult);
    expect(userResult).toBeLessThan(newUser);
    const resultBlocks = messages[userResult]!.content as ContentBlock[];
    expect(resultBlocks).toEqual([
      { type: "tool_result", tool_use_id: "read-1", content: "file contents" },
    ]);
    const completed = manager.resume("fork-target");
    expect(completed.state.completedThroughEventId).toBe(
      completed.transcript.getEvents().at(-1)?.id,
    );
  });

  test("sends only the persisted transfer summary before the first real target message", async () => {
    dir = mkdtempSync(join(tmpdir(), "engine-summary-fork-"));
    model = `${provider}-${Date.now()}-${Math.random()}`;
    calls.set(model, []);
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
    const manager = engine.getSessionManager();
    const source = manager.create(dir, model, provider, "summary-source");
    const from = source.transcript.appendMessage("user", "selected source detail");
    const to = source.transcript.appendMessage("assistant", "selected source answer");
    source.transcript.appendMessage("user", "outside selection");
    manager.createSummaryFork("summary-source", {
      targetSessionId: "summary-target",
      fromEventId: from.id,
      toEventId: to.id,
      summary: "portable background only",
      sourceEventCount: 2,
      estimatedTokens: 4,
    });

    await engine.run("first target request", { sessionId: "summary-target", cwd: dir });

    const messages = calls.get(model)![0]!;
    expect(JSON.stringify(messages)).toContain("portable background only");
    expect(JSON.stringify(messages)).not.toContain("selected source detail");
    expect(JSON.stringify(messages)).not.toContain("outside selection");
    const summaryIndex = messages.findIndex(
      (message) =>
        typeof message.content === "string" && message.content.includes("portable background only"),
    );
    const targetIndex = messages.findIndex((message) => message.content === "first target request");
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeLessThan(targetIndex);
  });

  test("a modern completed run with injected transcript flush degradation cannot use legacy tail fallback", async () => {
    dir = mkdtempSync(join(tmpdir(), "engine-session-fork-flush-degraded-"));
    model = `${provider}-${Date.now()}-${Math.random()}`;
    calls.set(model, []);
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
    const manager = engine.getSessionManager();
    const originalCreate = manager.create.bind(manager);
    manager.create = ((...args: Parameters<typeof manager.create>) => {
      const bundle = originalCreate(...args);
      bundle.transcript.flushFailed = () => true;
      return bundle;
    }) as typeof manager.create;

    await engine.run("completed in memory but transcript persistence degraded", {
      sessionId: "flush-degraded-parent",
      cwd: dir,
    });

    const parentState = JSON.parse(
      readFileSync(join(dir, "sessions", "flush-degraded-parent", "state.json"), "utf-8"),
    );
    expect(parentState.status).toBe("completed");
    expect(parentState.completedSnapshotVersion).toBe(1);
    expect(parentState.completedThroughEventId).toBeUndefined();
    const forked = manager.fork("flush-degraded-parent", {
      targetSessionId: "flush-degraded-side",
      snapshotMode: "completed",
    });
    expect(forked.copiedEventCount).toBe(0);
    expect(forked.bundle.transcript.getEvents("message")).toEqual([]);
  });
});

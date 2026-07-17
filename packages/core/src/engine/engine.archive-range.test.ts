import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse } from "../types.js";
import { Engine } from "./engine.js";

const provider = "fake-archive-range";

// A summarizer-only fake: any "conversation summarizer" prompt returns a short
// but non-trivial summary; nothing else is exercised by archiveTurnRange.
class ArchiveRangeClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    if (options.systemPrompt.includes("conversation summarizer")) {
      return {
        text: `A factual compacted history summary. ${"condensed context ".repeat(8)}`,
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      };
    }
    return { text: "unused", toolCalls: [], stopReason: "stop" };
  }
}

registerProvider(provider, ArchiveRangeClient);

describe("Engine.archiveTurnRange", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeEngine() {
    const dir = mkdtempSync(join(tmpdir(), "archive-range-"));
    roots.push(dir);
    const model = `${provider}-${Date.now()}-${Math.random()}`;
    const engine = new Engine({
      llm: { provider, model, apiKey: "test-key" } as never,
      cwd: "/tmp",
      sessionStorageDir: dir,
      maxContextTokens: 100_000,
      headless: true,
    });
    return { engine, dir };
  }

  function seedSession(engine: Engine, sessionId: string): void {
    const session = engine.getSessionManager().create("/tmp", "gpt-5", "openai", sessionId);
    for (let i = 0; i < 8; i++) {
      session.transcript.appendMessage("user", `question number ${i} `.repeat(20));
      session.transcript.appendMessage("assistant", `answer number ${i} `.repeat(40));
    }
  }

  it("collapses the given index window and caches the result", async () => {
    const { engine } = makeEngine();
    seedSession(engine, "archive-a");

    const result = await engine.archiveTurnRange("archive-a", { start: 2, end: 10 });

    expect(result.before).toBeGreaterThan(0);
    expect(result.after).toBeLessThan(result.before);

    // The cached (archived) messages are what a subsequent forceCompact reads.
    const cached = (engine as any).compactedMessagesBySession.get("archive-a") as Array<unknown>;
    expect(Array.isArray(cached)).toBe(true);
    // 16 seeded messages, window [2,10) → 8 collapsed to 1 summary → 9 total.
    expect(cached.length).toBe(9);
  });

  it("returns before === after when no session is active", async () => {
    const { engine } = makeEngine();
    const result = await engine.archiveTurnRange("", { start: 0, end: 3 });
    expect(result).toEqual({ before: 0, after: 0 });
  });

  it("leaves messages untouched for an empty window", async () => {
    const { engine } = makeEngine();
    seedSession(engine, "archive-empty");
    const result = await engine.archiveTurnRange("archive-empty", { start: 3, end: 3 });
    expect(result.after).toBe(result.before);
    const cached = (engine as any).compactedMessagesBySession.get("archive-empty") as Array<unknown>;
    expect(cached.length).toBe(16);
  });
});

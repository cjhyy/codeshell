import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateMessageOptions } from "../llm/types.js";
import { ModelPool } from "../llm/model-pool.js";
import { MemoryManager } from "../session/memory.js";
import type { SettingsManager } from "../settings/manager.js";
import type { ToolContext } from "../tool-system/context.js";
import type { ToolRegistry } from "../tool-system/registry.js";
import type { Transcript } from "../session/transcript.js";
import type { TokenUsage } from "../types.js";
import { AuxiliaryPipeline, type EngineLlmClient } from "./auxiliary-pipeline.js";
import { auxPromptCacheScope } from "./aux-prompt-cache.js";

let root: string;
let previousHome: string | undefined;
let previousCodeShellHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "memory-prompt-cache-"));
  previousHome = process.env.HOME;
  previousCodeShellHome = process.env.CODE_SHELL_HOME;
  process.env.HOME = root;
  process.env.CODE_SHELL_HOME = join(root, ".code-shell");
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousCodeShellHome;
  rmSync(root, { recursive: true, force: true });
});

const sessionId = "memory-prompt-cache-session";
const usage: TokenUsage = { promptTokens: 20, completionTokens: 10, totalTokens: 30 };

function turn(index: number) {
  return {
    role: index % 2 ? "assistant" : "user",
    content: `TURN_${index} ${"x".repeat(900)}`,
  };
}

function setup(cacheStrategy = "openai-hybrid", extracted: unknown[] = []) {
  const calls: CreateMessageOptions[] = [];
  const client = {
    getPromptCacheConfigIdentity: () => ({ cacheStrategy }),
    createMessage: async (options: CreateMessageOptions) => {
      calls.push(options);
      const system = options.systemPrompt;
      return {
        text: system.includes("session summariser")
          ? JSON.stringify({ summary: "s", keyTopics: [], decisions: [] })
          : system.includes("write decision")
            ? JSON.stringify({ action: "NOOP" })
            : JSON.stringify(extracted),
        toolCalls: [],
        stopReason: "stop",
        usage,
      };
    },
  } as EngineLlmClient;
  const pipeline = new AuxiliaryPipeline({
    config: () => ({ llm: { provider: "fixture", model: "memory-fixture" } }),
    settings: () =>
      ({
        invalidate: () => {},
        get: () => ({ memories: { autoExtract: true } }),
      }) as unknown as SettingsManager,
    modelPool: () => new ModelPool([]),
    toolRegistry: () => ({}) as ToolRegistry,
    toolContext: () => ({}) as ToolContext,
  });
  let length = 14;
  const transcript = {
    toMessages: () => Array.from({ length }, (_, index) => turn(index)),
  } as unknown as Transcript;
  return {
    calls,
    grow: (by: number) => (length += by),
    run: () => pipeline.runMemoryPipeline(transcript, sessionId, root, client),
  };
}

const text = (options: CreateMessageOptions) =>
  options.messages.map((message) => message.content as string);

describe("memory pipeline prompt cache", () => {
  test("extraction and summary send stable messages with a per-purpose cache scope", async () => {
    const fixture = setup();
    await fixture.run();

    expect(fixture.calls).toHaveLength(2);
    const [extraction, summary] = fixture.calls as [CreateMessageOptions, CreateMessageOptions];
    for (const call of [extraction, summary]) {
      expect(call.messages.length).toBeGreaterThan(2);
      expect(call.messages.every((message) => message.role === "user")).toBe(true);
      // The breakpoint lands on the last stable message; only the final,
      // volatile message is outside the settled prefix.
      expect(call.promptCache?.stablePrefixMessageCount).toBe(call.messages.length - 1);
    }
    expect(extraction.promptCache?.scopeId).toBe(
      auxPromptCacheScope(sessionId, "memory-extraction"),
    );
    expect(summary.promptCache?.scopeId).toBe(auxPromptCacheScope(sessionId, "session-summary"));
    expect(extraction.promptCache?.scopeId).not.toBe(summary.promptCache?.scopeId);
    expect(extraction.promptCache?.scopeId).not.toBe(sessionId);
    expect(auxPromptCacheScope("other-session", "memory-extraction")).not.toBe(
      extraction.promptCache?.scopeId,
    );
  });

  test.each(["provider-managed", "openai-implicit"])(
    "a %s route keeps one user message and still gets its own scope",
    async (strategy) => {
      const fixture = setup(strategy);
      await fixture.run();

      expect(fixture.calls).toHaveLength(2);
      for (const call of fixture.calls) {
        expect(call.messages).toHaveLength(1);
        expect(call.promptCache?.stablePrefixMessageCount).toBeUndefined();
      }
      expect(fixture.calls[0]!.promptCache?.scopeId).toBe(
        auxPromptCacheScope(sessionId, "memory-extraction"),
      );
      // Instructions lead and the conversation precedes the volatile lists.
      const prompt = fixture.calls[0]!.messages[0]!.content as string;
      expect(prompt.indexOf("## Instructions")).toBeLessThan(prompt.indexOf("TURN_0 "));
      expect(prompt.indexOf("TURN_13 ")).toBeLessThan(prompt.indexOf("## Existing Memories"));
    },
  );

  test("the next run re-sends the previous run's stable messages unchanged", async () => {
    const fixture = setup();
    await fixture.run();
    // The store changes between runs, as it does after every real extraction.
    new MemoryManager({ projectDir: root, scope: "dream" }).save({
      type: "project",
      name: "added between runs",
      description: "volatile existing memory",
      content: "body",
    });
    fixture.grow(4);
    await fixture.run();

    expect(fixture.calls).toHaveLength(4);
    for (const index of [0, 1]) {
      const before = fixture.calls[index]!;
      const after = fixture.calls[index + 2]!;
      const stableCount = before.promptCache!.stablePrefixMessageCount!;
      expect(after.systemPrompt).toBe(before.systemPrompt);
      expect(text(after).slice(0, stableCount)).toEqual(text(before).slice(0, stableCount));
      expect(after.promptCache?.scopeId).toBe(before.promptCache!.scopeId!);
      expect(after.promptCache!.stablePrefixMessageCount!).toBeGreaterThanOrEqual(stableCount);

      // Estimate of the reusable share: stable characters of the first
      // request over all characters of the second.
      const reusable = text(before).slice(0, stableCount).join("").length;
      const total = text(after).join("").length;
      expect(reusable / total).toBeGreaterThan(0.6);
    }
    expect(text(fixture.calls[2]!).at(-1)).toContain("added between runs");
    expect(text(fixture.calls[2]!).slice(0, -1).join("")).not.toContain("added between runs");
  });

  test("the write decision sends the catalogue as stable messages under its own scope", async () => {
    const dream = new MemoryManager({ projectDir: root, scope: "dream" });
    for (let index = 0; index < 24; index++) {
      dream.save({
        type: "project",
        name: `stored topic ${index}`,
        description: `stored description ${index} ${"d".repeat(80)}`,
        content: `stored body ${index}`,
        origin: "auto",
      });
    }
    const fixture = setup("openai-hybrid", [
      { type: "project", scope: "project", name: "fresh", description: "d", content: "c" },
    ]);
    await fixture.run();

    expect(fixture.calls).toHaveLength(3);
    const decision = fixture.calls[1]!;
    expect(decision.systemPrompt).toContain("write decision");
    expect(decision.promptCache).toEqual({
      scopeId: auxPromptCacheScope(sessionId, "memory-write-decision"),
      scopeKind: "auxiliary",
      stablePrefixMessageCount: decision.messages.length - 1,
    });
    expect(decision.messages.length).toBeGreaterThan(2);
    const stable = text(decision).slice(0, -1).join("");
    expect(stable).toContain("stored topic 0");
    expect(stable).not.toContain("fresh");
    expect(text(decision).at(-1)).toContain("Candidate:");
  });
});

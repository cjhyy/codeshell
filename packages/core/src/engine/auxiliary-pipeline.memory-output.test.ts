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
import type { LLMResponse, TokenUsage } from "../types.js";
import { AuxiliaryPipeline, type EngineLlmClient } from "./auxiliary-pipeline.js";

let root: string;
let previousHome: string | undefined;
let previousCodeShellHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "memory-output-budget-"));
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

const sessionId = "memory-budget-session";
const usage: TokenUsage = { promptTokens: 20, completionTokens: 10, totalTokens: 30 };

function setup(autoExtract: boolean, respond: (options: CreateMessageOptions) => LLMResponse) {
  const calls: CreateMessageOptions[] = [];
  const billed: TokenUsage[] = [];
  const client = {
    createMessage: async (options: CreateMessageOptions) => {
      calls.push(options);
      return respond(options);
    },
  } as EngineLlmClient;
  const pipeline = new AuxiliaryPipeline({
    config: () => ({ llm: { provider: "fixture", model: "memory-fixture" } }),
    settings: () =>
      ({
        invalidate: () => {},
        get: () => ({ memories: { autoExtract } }),
      }) as unknown as SettingsManager,
    modelPool: () => new ModelPool([]),
    toolRegistry: () => ({}) as ToolRegistry,
    toolContext: () => ({}) as ToolContext,
  });
  const transcript = {
    toMessages: () =>
      Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        content: `message ${index}`,
      })),
  } as unknown as Transcript;
  return {
    calls,
    billed,
    run: () =>
      pipeline.runMemoryPipeline(transcript, sessionId, root, client, (value) =>
        billed.push(value),
      ),
  };
}

describe("memory model output budgets", () => {
  test.each(["length", "max_tokens"])(
    "discards an extraction the provider reports as %s, without retrying",
    async (stopReason) => {
      const manager = new MemoryManager({ projectDir: root, scope: "dream" });
      manager.save({
        type: "project",
        name: "verified-memory",
        description: "verified",
        content: "keep this",
      });
      const before = manager.loadAll();
      const fixture = setup(true, () => ({
        text: JSON.stringify([
          {
            type: "project",
            scope: "project",
            name: "partial-new-memory",
            description: "partial",
            content: "discard this",
          },
        ]),
        toolCalls: [],
        stopReason,
        usage,
      }));

      await fixture.run();

      expect(fixture.calls).toHaveLength(1);
      expect(fixture.calls[0]!.maxTokens).toBe(3072);
      expect(fixture.billed).toEqual([usage]);
      expect(manager.loadAll()).toEqual(before);
    },
  );

  test("uses a bounded memory budget and persists complete output", async () => {
    const fixture = setup(true, () => ({
      text: JSON.stringify([
        {
          type: "project",
          scope: "project",
          name: "complete-memory",
          description: "complete",
          content: "keep this",
        },
      ]),
      toolCalls: [],
      stopReason: "stop",
      usage,
    }));

    await fixture.run();

    expect(fixture.calls.map((call) => call.maxTokens)).toEqual([3072]);
    expect(
      new MemoryManager({ projectDir: root, scope: "dream" }).loadAll().map((m) => m.name),
    ).toEqual(["complete-memory"]);
  });
});

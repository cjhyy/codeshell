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
import type { LLMResponse, TokenUsage, TranscriptEvent } from "../types.js";
import type { MemoryCursor } from "../services/memory-closure.js";
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

describe("memory closure", () => {
  let sequence = 0;
  const message = (
    role: "user" | "assistant",
    content: string,
    extra: Record<string, unknown> = {},
  ): TranscriptEvent => {
    sequence++;
    return {
      id: `closure-${sequence}`,
      type: "message",
      timestamp: sequence * 1000,
      turnNumber: 0,
      data: { role, content, ...extra },
    };
  };
  const exchange = (count: number, label: string, userExtra: Record<string, unknown> = {}) =>
    Array.from({ length: count }, (_, index) =>
      index % 2
        ? message("assistant", `${label} answer ${index}`)
        : message("user", `${label} question ${index}`, userExtra),
    );
  const sent = (options: CreateMessageOptions) =>
    options.messages
      .map((entry) => (typeof entry.content === "string" ? entry.content : ""))
      .join("");

  function closure(
    autoExtract: boolean | undefined,
    respond: (options: CreateMessageOptions) => LLMResponse = () => ({
      text: "[]",
      toolCalls: [],
      stopReason: "stop",
      usage,
    }),
  ) {
    const calls: CreateMessageOptions[] = [];
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
    const state: { cursor?: MemoryCursor } = {};
    return {
      calls,
      state,
      run: (events: TranscriptEvent[]) =>
        pipeline.runMemoryClosure({
          events,
          sessionId,
          cwd: root,
          primaryClient: client,
          trigger: "run-end",
          readCursor: () => state.cursor,
          writeCursor: (cursor) => (state.cursor = cursor),
        }),
    };
  }

  test("a stretch nobody typed in makes no request and keeps the cursor", async () => {
    const fixture = closure(true);
    await fixture.run(exchange(12, "background", { injected: true }));
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.state.cursor).toBeUndefined();
  });

  test("a first closure shorter than eight messages makes no request", async () => {
    const fixture = closure(true);
    await fixture.run(exchange(6, "short"));
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.state.cursor).toBeUndefined();
  });

  test("a closure reads only what follows the cursor and then advances it", async () => {
    const fixture = closure(true);
    const first = exchange(8, "early");
    await fixture.run(first);
    expect(fixture.calls).toHaveLength(1);
    expect(sent(fixture.calls[0]!)).toContain("[user]: early question 0");
    expect(sent(fixture.calls[0]!)).not.toContain("[context]:");
    expect(fixture.state.cursor).toMatchObject({
      v: 1,
      eventId: first.at(-1)!.id,
      at: first.at(-1)!.timestamp,
    });

    const second = exchange(2, "later");
    await fixture.run([...first, ...second]);
    expect(fixture.calls).toHaveLength(2);
    const prompt = sent(fixture.calls[1]!);
    expect(prompt).toContain("[user]: later question 0");
    expect(prompt).toContain("[assistant]: later answer 1");
    // The covered lead-in is one entry that says not to extract from it.
    expect(prompt).toContain("[context]: Earlier messages, already covered by a previous pass.");
    expect(prompt).toContain("- assistant: early answer 7");
    expect(prompt).not.toContain("early question 0");
    expect(prompt).not.toContain("[user]: early question 6");
    expect(fixture.state.cursor!.eventId).toBe(second.at(-1)!.id);
  });

  test("a failed request leaves the cursor where it was", async () => {
    const fixture = closure(true, () => {
      throw new Error("model unavailable");
    });
    await fixture.run(exchange(8, "failing"));
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.state.cursor).toBeUndefined();
  });

  test("with extraction turned off the stretch counts as read without a request", async () => {
    const fixture = closure(false);
    const events = exchange(8, "off");
    await fixture.run(events);
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.state.cursor!.eventId).toBe(events.at(-1)!.id);
  });
});

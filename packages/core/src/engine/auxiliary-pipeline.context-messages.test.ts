import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateMessageOptions } from "../llm/types.js";
import { ModelPool } from "../llm/model-pool.js";
import type { SettingsManager } from "../settings/manager.js";
import type { ToolContext } from "../tool-system/context.js";
import type { ToolRegistry } from "../tool-system/registry.js";
import { Transcript } from "../session/transcript.js";
import type { TokenUsage } from "../types.js";
import { AuxiliaryPipeline, type EngineLlmClient } from "./auxiliary-pipeline.js";

let root: string;
let previousHome: string | undefined;
let previousCodeShellHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "memory-context-messages-"));
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

const usage: TokenUsage = { promptTokens: 20, completionTokens: 10, totalTokens: 30 };

function setup(conversationMessages: number) {
  const calls: CreateMessageOptions[] = [];
  const client = {
    createMessage: async (options: CreateMessageOptions) => {
      calls.push(options);
      return { text: "[]", toolCalls: [], stopReason: "stop", usage };
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
  const transcript = Transcript.inMemory("memory-context-messages");
  const task = transcript.appendMessage("user", "message 0");
  transcript.appendMessage("user", "<system-reminder>\nHOOK_RULES\n</system-reminder>", {
    hookReminder: { beforeEventId: task.id, sessionStart: ["HOOK_RULES"] },
  });
  transcript.appendMessage("user", "<system-reminder>\nMEMORY_INDEX_TEXT\n</system-reminder>", {
    contextLedger: { kind: "snapshot", state: '{"version":1,"sections":{}}' },
  });
  for (let index = 1; index < conversationMessages; index += 1) {
    transcript.appendMessage(index % 2 ? "assistant" : "user", `message ${index}`);
  }
  return {
    calls,
    run: () => pipeline.runMemoryPipeline(transcript, "memory-context-session", root, client),
  };
}

test("engine context messages are not fed to memory extraction", async () => {
  const fixture = setup(8);
  await fixture.run();
  expect(fixture.calls.length).toBeGreaterThan(0);
  const sent = JSON.stringify(fixture.calls);
  expect(sent).toContain("message 7");
  expect(sent).not.toContain("MEMORY_INDEX_TEXT");
  expect(sent).not.toContain("HOOK_RULES");
});

test("engine context messages do not count towards the activity threshold", async () => {
  // Seven conversation messages plus two context messages is still too short.
  const fixture = setup(7);
  await fixture.run();
  expect(fixture.calls).toEqual([]);
});

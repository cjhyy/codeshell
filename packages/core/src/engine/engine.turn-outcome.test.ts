import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import { BUILTIN_TOOLS } from "../tool-system/builtin/index.js";
import type { LLMResponse, StreamEvent, TurnOutcome } from "../types.js";

const fakeProvider = "fake-engine-turn-outcome";
const scripts = new Map<string, { calls: number; responses: LLMResponse[] }>();
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

class ScriptedClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(): Promise<LLMResponse> {
    const script = scripts.get(this.model);
    if (!script) throw new Error(`missing script: ${this.model}`);
    return script.responses[Math.min(script.calls++, script.responses.length - 1)]!;
  }
}

registerProvider(fakeProvider, ScriptedClient);

const say = (text: string): LLMResponse => ({ text, toolCalls: [], stopReason: "stop", usage });
const call = (toolName: string, args: Record<string, unknown> = {}): LLMResponse => ({
  text: "",
  toolCalls: [{ id: `call-${toolName}`, toolName, args }],
  stopReason: "tool_use",
  usage,
});

async function runScript(
  responses: LLMResponse[],
  options: { maxTurns?: number; isSubAgent?: boolean } = {},
): Promise<Array<Extract<StreamEvent, { type: "turn_complete" }>>> {
  const dir = mkdtempSync(join(tmpdir(), "engine-turn-outcome-"));
  const model = `${fakeProvider}-${crypto.randomUUID()}`;
  scripts.set(model, { calls: 0, responses });
  const events: StreamEvent[] = [];
  try {
    const engine = new Engine({
      llm: { provider: fakeProvider, model, apiKey: "test" } as never,
      cwd: dir,
      sessionStorageDir: join(dir, "sessions"),
      enabledBuiltinTools: ["ToolSearch", "Glob"],
      maxTurns: options.maxTurns ?? 5,
      headless: true,
      permissionMode: "bypassPermissions",
      ...(options.isSubAgent ? { isSubAgent: true } : {}),
    });
    (engine as unknown as { hooks: { clear(): void } }).hooks.clear();
    await engine.run("do it", {
      sessionId: "s",
      cwd: dir,
      onStream: (event) => events.push(event),
    });
  } finally {
    scripts.delete(model);
    rmSync(dir, { recursive: true, force: true });
  }
  return events.filter(
    (event): event is Extract<StreamEvent, { type: "turn_complete" }> =>
      event.type === "turn_complete",
  );
}

describe("Engine reports turn_complete.outcome", () => {
  it("an acknowledgement turn did no work", async () => {
    const terminals = await runScript([say("OK, will do.")]);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ reason: "completed", text: "OK, will do." });
    expect(terminals[0]!.outcome).toEqual({
      didWork: false,
      backgroundPending: false,
    } satisfies TurnOutcome);
  });

  it("a turn that only loaded a tool schema did no work", async () => {
    const terminals = await runScript([call("ToolSearch", { query: "notify" }), say("Loaded.")]);
    expect(terminals[0]!.outcome).toEqual({ didWork: false, backgroundPending: false });
  });

  it("a turn that ran a real tool did work", async () => {
    const terminals = await runScript([call("Glob", { pattern: "*.none" }), say("Nothing.")]);
    expect(terminals[0]!.outcome).toEqual({ didWork: true, backgroundPending: false });
  });

  it("a run that ends on its turn budget still reports the outcome", async () => {
    const terminals = await runScript([call("Glob", { pattern: "*.none" })], { maxTurns: 1 });
    expect(terminals[0]).toMatchObject({
      reason: "max_turns",
      outcome: { didWork: true, backgroundPending: false },
    });
  });

  it("a sub-agent run reports none", async () => {
    const terminals = await runScript([call("Glob", { pattern: "*.none" }), say("Nothing.")], {
      isSubAgent: true,
    });
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.outcome).toBeUndefined();
  });
});

describe("bookkeeping tools", () => {
  it("core declares the tools that ask the user or load a schema", () => {
    expect(
      BUILTIN_TOOLS.filter((tool) => tool.definition.bookkeeping === true)
        .map((tool) => tool.definition.name)
        .sort(),
    ).toEqual(["AskUserQuestion", "AskUserQuestionAsync", "ToolSearch"]);
  });
});

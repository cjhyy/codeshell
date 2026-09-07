import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import type { EngineConfig } from "./types.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, Message, StreamEvent } from "../types.js";

const PROVIDER = "fake-engine-context-notes";
const NOTE_TOOLS = ["SaveContextNote", "NewContext", "SearchHistory"];
const EXACT_OLD_FACT = "The original release checksum is zebrafish-4821; keep this exact spelling.";
const NOTE =
  "Continue the existing release task. User correction: prepare documentation only; do not publish. Next: verify the original release checksum in history.";
const SUMMARY =
  "The conversation covered release preparation and its earlier implementation details. The latest user request remains unfinished and should be continued from the retained recent messages.";
const USAGE = { promptTokens: 10, completionTokens: 1, totalTokens: 11 };

interface Scenario {
  rounds: Array<{ messages: Message[]; tools: string[]; systemPrompt: string }>;
  auxiliary: Array<{ messages: Message[]; systemPrompt: string }>;
  respond: (round: number, options: CreateMessageOptions) => Partial<LLMResponse>;
}

const scenarios = new Map<string, Scenario>();
const engines: Engine[] = [];
const directories: string[] = [];

class ContextNotesClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`Missing context notes scenario: ${this.model}`);
    let response: Partial<LLMResponse>;
    if ((options.tools?.length ?? 0) > 0) {
      scenario.rounds.push({
        messages: structuredClone(options.messages),
        tools: (options.tools ?? []).map((tool) => tool.name),
        systemPrompt: options.systemPrompt,
      });
      response = scenario.respond(scenario.rounds.length, options);
    } else {
      scenario.auxiliary.push({
        messages: structuredClone(options.messages),
        systemPrompt: options.systemPrompt,
      });
      response = { text: SUMMARY };
    }
    this.recordUsage(USAGE, options);
    return { text: "continued", toolCalls: [], stopReason: "stop", usage: USAGE, ...response };
  }
}

registerProvider(PROVIDER, ContextNotesClient);

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  scenarios.clear();
});

function makeEngine(
  options: {
    contextStrategy?: "summary" | "notes";
    settingsStrategy?: "summary" | "notes";
    respond?: Scenario["respond"];
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "engine-context-notes-"));
  directories.push(dir);
  if (options.settingsStrategy) {
    mkdirSync(join(dir, ".code-shell"), { recursive: true });
    writeFileSync(
      join(dir, ".code-shell", "settings.json"),
      JSON.stringify({ context: { strategy: options.settingsStrategy } }),
    );
  }
  const model = `${PROVIDER}-${Date.now()}-${Math.random()}`;
  const scenario: Scenario = {
    rounds: [],
    auxiliary: [],
    respond: options.respond ?? (() => ({ text: "continued" })),
  };
  scenarios.set(model, scenario);
  const config: EngineConfig = {
    llm: { provider: PROVIDER, model, apiKey: "test" },
    cwd: dir,
    sessionStorageDir: join(dir, "sessions"),
    settingsScope: "project",
    enabledBuiltinTools: ["Read", ...NOTE_TOOLS],
    maxContextTokens: 200_000,
    maxTurns: 8,
    headless: true,
    contextStrategy: options.contextStrategy,
  };
  const engine = restartEngine(config);
  return { dir, model, scenario, engine, config };
}

function restartEngine(config: EngineConfig): Engine {
  const engine = new Engine(config);
  engine.getHookRegistry().clear();
  engines.push(engine);
  return engine;
}

function seedSession(engine: Engine, dir: string, model: string, long = false) {
  const session = engine.getSessionManager().create(dir, model, PROVIDER, "notes-session");
  const original = session.transcript.appendMessage("user", EXACT_OLD_FACT, {
    clientMessageId: "original-fact",
  });
  session.transcript.appendMessage("assistant", "I will preserve the original checksum.");
  if (long) {
    for (let index = 0; index < 16; index += 1) {
      session.transcript.appendMessage("user", `Review historical release detail ${index}.`);
      session.transcript.appendMessage(
        "assistant",
        `OLD_VERBOSE_BODY_${index}: ` +
          "The prior release implementation was reviewed. ".repeat(70),
      );
    }
  }
  return { sessionId: session.state.sessionId, originalEventId: original.id };
}

function call(toolName: string, args: Record<string, unknown>, id: string): Partial<LLMResponse> {
  return { text: "", toolCalls: [{ id, toolName, args }], stopReason: "tool_use" };
}

function assertPairedTools(messages: Message[], required: string[] = []) {
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (block.type === "tool_use") calls.set(block.id, index);
      if (block.type === "tool_result") results.set(block.tool_use_id, index);
    }
  });
  for (const id of required) expect(calls.has(id)).toBe(true);
  expect([...results.keys()].sort()).toEqual([...calls.keys()].sort());
  for (const [id, resultIndex] of results) expect(calls.get(id)!).toBeLessThan(resultIndex);
}

function successfulTools(events: StreamEvent[]) {
  return events.flatMap((event) => (event.type === "tool_result" ? [event.result] : []));
}

describe("Engine notes context strategy", () => {
  test("ordinary sessions default to summary and hide native notes controls", async () => {
    const { engine, dir, model, scenario } = makeEngine();
    const { sessionId } = seedSession(engine, dir, model);
    const result = await engine.run("Continue normally.", { sessionId });
    expect(result.reason).toBe("completed");
    expect(scenario.rounds).toHaveLength(1);
    expect(scenario.rounds[0]!.tools).toContain("Read");
    for (const tool of NOTE_TOOLS) expect(scenario.rounds[0]!.tools).not.toContain(tool);
  });

  test.each(["config", "settings"] as const)(
    "%s can enable notes for an ordinary session",
    async (source) => {
      const { engine, dir, model, scenario } = makeEngine(
        source === "config" ? { contextStrategy: "notes" } : { settingsStrategy: "notes" },
      );
      const { sessionId } = seedSession(engine, dir, model);
      const result = await engine.run("Continue with working notes.", { sessionId });
      expect(result.reason).toBe("completed");
      expect(scenario.rounds).toHaveLength(1);
      for (const tool of NOTE_TOOLS) expect(scenario.rounds[0]!.tools).toContain(tool);
      expect(engine.getSessionManager().readSessionKind(sessionId)).toBe("work");
    },
  );

  test("config can explicitly override notes settings with the summary strategy", async () => {
    const { engine, dir, model, scenario } = makeEngine({
      contextStrategy: "summary",
      settingsStrategy: "notes",
    });
    const { sessionId } = seedSession(engine, dir, model);
    await engine.run("Continue normally.", { sessionId });
    for (const tool of NOTE_TOOLS) expect(scenario.rounds[0]!.tools).not.toContain(tool);
  });

  test("SaveContextNote then NewContext shrinks the same session and survives an engine restart", async () => {
    const { engine, dir, model, scenario, config } = makeEngine({
      contextStrategy: "notes",
      respond: (round) => {
        if (round === 1) return call("SaveContextNote", { note: NOTE }, "save-note");
        if (round === 2) return call("NewContext", {}, "new-context");
        return { text: "The same task is continuing from the note." };
      },
    });
    const { sessionId, originalEventId } = seedSession(engine, dir, model, true);
    const events: StreamEvent[] = [];
    const result = await engine.run(
      "Prepare documentation only; do not publish. Continue the same task.",
      {
        sessionId,
        onStream: (event) => {
          events.push(event);
        },
      },
    );
    expect(result.reason).toBe("completed");
    expect(result.sessionId).toBe(sessionId);
    expect(scenario.rounds).toHaveLength(3);
    const before = JSON.stringify(scenario.rounds[0]!.messages);
    const after = JSON.stringify(scenario.rounds[2]!.messages);
    expect(before).toContain(EXACT_OLD_FACT);
    expect(after.length).toBeLessThan(before.length / 2);
    expect(after).toContain(NOTE);
    expect(after).toContain("Prepare documentation only; do not publish. Continue the same task.");
    expect(after).not.toContain("OLD_VERBOSE_BODY_");
    expect(after).not.toContain(EXACT_OLD_FACT);
    assertPairedTools(scenario.rounds[2]!.messages, ["save-note", "new-context"]);
    expect(
      successfulTools(events).map((entry) => [entry.toolName, entry.isError ?? false]),
    ).toEqual([
      ["SaveContextNote", false],
      ["NewContext", false],
    ]);
    // UI tool labels are independent background calls and may settle before
    // this assertion in a larger suite. A context-summary call must never run.
    expect(
      scenario.auxiliary.every((request) => request.systemPrompt.includes("what these tools did")),
    ).toBe(true);
    const transcript = engine.getSessionManager().resume(sessionId).transcript;
    expect(transcript.getEvents("context_checkpoint")).toHaveLength(1);
    expect(readFileSync(transcript.getFilePath(), "utf8")).toContain(EXACT_OLD_FACT);

    await engine.dispose();
    scenario.rounds.length = 0;
    scenario.respond = (round) => {
      if (round === 1)
        return call(
          "SearchHistory",
          { action: "search", query: "zebrafish-4821" },
          "find-old-fact",
        );
      if (round === 2)
        return call(
          "SearchHistory",
          { action: "read", event_id: originalEventId },
          "read-old-fact",
        );
      return { text: "Verified the exact checksum from the original history." };
    };
    const restarted = restartEngine(config);
    const restartedEvents: StreamEvent[] = [];
    const resumed = await restarted.run("Verify the original checksum from history.", {
      sessionId,
      onStream: (event) => {
        restartedEvents.push(event);
      },
    });
    expect(resumed.reason).toBe("completed");
    expect(resumed.sessionId).toBe(sessionId);
    expect(scenario.rounds).toHaveLength(3);
    const resumedFirst = JSON.stringify(scenario.rounds[0]!.messages);
    expect(resumedFirst).toContain(NOTE);
    expect(resumedFirst).not.toContain("OLD_VERBOSE_BODY_");
    expect(resumedFirst).not.toContain(EXACT_OLD_FACT);
    const searchResults = successfulTools(restartedEvents);
    expect(searchResults).toHaveLength(2);
    expect(searchResults.every((entry) => !entry.isError)).toBe(true);
    expect(searchResults[0]!.result).toContain(originalEventId);
    expect(searchResults[1]!.result).toContain(EXACT_OLD_FACT);
    assertPairedTools(scenario.rounds[2]!.messages, ["find-old-fact", "read-old-fact"]);
    expect(
      restarted.getSessionManager().resume(sessionId).transcript.getEvents("context_checkpoint"),
    ).toHaveLength(1);
  });

  test("manual forceCompact uses a saved note without a separate summary call", async () => {
    const { engine, dir, model, scenario } = makeEngine({
      contextStrategy: "notes",
      respond: (round) =>
        round === 1
          ? call("SaveContextNote", { note: NOTE }, "save-before-manual")
          : { text: "Working note saved." },
    });
    const { sessionId } = seedSession(engine, dir, model, true);
    const run = await engine.run("Save the current working state before continuing.", {
      sessionId,
    });
    expect(run.reason).toBe("completed");
    expect(
      engine.getSessionManager().resume(sessionId).transcript.getEvents("context_note"),
    ).toHaveLength(1);
    const callsBeforeCompact = scenario.rounds.length + scenario.auxiliary.length;
    const compacted = await engine.forceCompact(sessionId);
    expect(compacted.strategy).toBe("notes");
    expect(compacted.after).toBeLessThan(compacted.before);
    expect(scenario.rounds.length + scenario.auxiliary.length).toBe(callsBeforeCompact);
    expect(
      engine.getSessionManager().resume(sessionId).transcript.getEvents("context_checkpoint"),
    ).toHaveLength(1);
  });

  test("manual forceCompact retains the summary fallback when no note has been saved", async () => {
    const { engine, dir, model, scenario } = makeEngine({ contextStrategy: "notes" });
    const { sessionId } = seedSession(engine, dir, model, true);
    const compacted = await engine.forceCompact(sessionId);
    expect(compacted.strategy).toBe("summary");
    expect(compacted.after).toBeLessThan(compacted.before);
    expect(scenario.auxiliary).toHaveLength(1);
    expect(
      engine.getSessionManager().resume(sessionId).transcript.getEvents("context_checkpoint"),
    ).toHaveLength(0);
  });
});

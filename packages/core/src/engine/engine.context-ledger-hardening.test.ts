import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, Message, TranscriptEvent } from "../types.js";
import type { AgentModule } from "../composition/types.js";
import { LEDGER_UPDATE_PREAMBLE } from "../context/context-ledger.js";

const provider = "fake-engine-context-ledger-hardening";
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

type Scenario = {
  requests: Message[][];
  stablePrefix: (number | undefined)[];
  responses: LLMResponse[];
  /** Messages of every summarizer call. */
  summaryInputs: string[];
};
const scenarios = new Map<string, Scenario>();

class FakeHardeningClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing fake scenario: ${this.model}`);
    if (!options.systemPrompt.includes("Working directory:")) {
      scenario.summaryInputs.push(JSON.stringify(options.messages));
      const response = stop(`SUMMARY: earlier work. ${"condensed ".repeat(12)}`);
      this.recordUsage(response.usage!, options);
      return response;
    }
    scenario.requests.push(JSON.parse(JSON.stringify(options.messages)) as Message[]);
    scenario.stablePrefix.push(options.promptCache?.stablePrefixMessageCount);
    const response =
      scenario.responses[Math.min(scenario.requests.length - 1, scenario.responses.length - 1)]!;
    this.recordUsage(response.usage!, options);
    return response;
  }
}

registerProvider(provider, FakeHardeningClient);

function stop(text: string, promptTokens = 1000): LLMResponse {
  return {
    text,
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens, completionTokens: 1, totalTokens: promptTokens + 1 },
  };
}

function toolStep(id: string, text = "working", promptTokens = 1000): LLMResponse {
  return {
    text,
    toolCalls: [{ id, toolName: "MissingTool", args: { id } }],
    stopReason: "tool_use",
    usage: { promptTokens, completionTokens: 1, totalTokens: promptTokens + 1 },
  };
}

/** Whole-text capability context read from marker files in the workspace. */
const markerContext: AgentModule = {
  id: "context-ledger-hardening-context",
  engine: {
    dynamicContextProviders: [
      ({ cwd }) =>
        readdirSync(cwd)
          .filter((name) => name.endsWith(".marker"))
          .sort()
          .join("\n"),
    ],
  },
};

const textOf = (message: Message): string =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

/** A finished text reply is a string live but one text block when replayed. */
function wire(messages: Message[]): Message[] {
  return messages.map((message) =>
    message.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.every((block) => block.type === "text")
      ? { role: "assistant", content: message.content.map((block) => block.text).join("\n") }
      : message,
  );
}

/** Every later request must begin with the full earlier request. */
function expectAppendOnly(requests: Message[][]): void {
  expect(requests.length).toBeGreaterThan(1);
  for (let index = 1; index < requests.length; index += 1) {
    const earlier = requests[index - 1]!;
    expect(requests[index]!.slice(0, earlier.length)).toEqual(earlier);
    expect(requests[index]!.length).toBeGreaterThan(earlier.length);
  }
}

describe("Engine context ledger hardening", () => {
  let repo: string;
  let sessions: string;
  let home: string;
  let prevHome: string | undefined;
  let prevCodeShellHome: string | undefined;
  let model: string;

  const scenario = (responses: LLMResponse[]): Scenario => {
    const value: Scenario = { requests: [], stablePrefix: [], responses, summaryInputs: [] };
    scenarios.set(model, value);
    return value;
  };
  const newEngine = (extra: Record<string, unknown> = {}): Engine => {
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd: repo,
      sessionStorageDir: sessions,
      enabledBuiltinTools: [],
      preset: "general",
      modules: [markerContext],
      headless: true,
      ...extra,
    });
    (engine as any).hooks.clear();
    return engine;
  };
  const events = (sessionId: string): TranscriptEvent[] =>
    readFileSync(join(sessions, sessionId, "transcript.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TranscriptEvent);

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cs-ledger-hardening-repo-"));
    sessions = mkdtempSync(join(tmpdir(), "cs-ledger-hardening-sessions-"));
    home = mkdtempSync(join(tmpdir(), "cs-ledger-hardening-home-"));
    prevHome = process.env.HOME;
    prevCodeShellHome = process.env.CODE_SHELL_HOME;
    process.env.HOME = home;
    process.env.CODE_SHELL_HOME = home;
    model = `${provider}-${Date.now()}-${Math.random()}`;
    execFileSync("git", ["init", "-q"], { cwd: repo, env, stdio: "ignore" });
    writeFileSync(join(repo, "CODESHELL.md"), "project instructions\n");
    writeFileSync(join(repo, "one.marker"), "");
  });

  afterEach(() => {
    scenarios.delete(model);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = prevCodeShellHome;
    for (const dir of [repo, sessions, home]) rmSync(dir, { recursive: true, force: true });
  });

  describe("notes rollover", () => {
    const call = (id: string, toolName: string, args: Record<string, unknown>): LLMResponse => ({
      text: "",
      toolCalls: [{ id, toolName, args }],
      stopReason: "tool_use",
      usage: { promptTokens: 1000, completionTokens: 1, totalTokens: 1001 },
    });
    const containing = (request: Message[], needle: string): Message[] =>
      request.filter((message) => textOf(message).includes(needle));

    it("carries each reminder once and resends one fresh snapshot, marked as context", async () => {
      const sessionId = "s-hardening-rollover";
      const { requests } = scenario([
        call("n1", "SaveContextNote", { note: "Continue the task; nothing is finished yet." }),
        stop("first done"),
        call("n2", "NewContext", {}),
        stop("second done"),
        stop("third done"),
      ]);
      let rules = "RULES v1";
      const hooked = (): Engine => {
        const engine = newEngine({
          enabledBuiltinTools: ["SaveContextNote", "NewContext"],
          contextStrategy: "notes",
        });
        (engine as any).hooks.register("on_session_start", async () => ({ messages: [rules] }));
        return engine;
      };
      const engine = hooked();
      await engine.run(`first task ${"long history ".repeat(600)}`, { sessionId, cwd: repo });
      expect(requests).toHaveLength(2);

      // Run 2 changes both the hook output and the context, so its reminder
      // and its ledger update are written after the note's boundary.
      rules = "RULES v2";
      writeFileSync(join(repo, "two.marker"), "");
      await engine.run("second task", { sessionId, cwd: repo });
      expect(requests).toHaveLength(4);
      expect(containing(requests[2]!, "RULES v2")).toHaveLength(1);
      expect(containing(requests[2]!, LEDGER_UPDATE_PREAMBLE)).toHaveLength(1);

      // The request after the rollover.
      const after = requests[3]!;
      expect(containing(after, "<context-note>")).toHaveLength(1);
      expect(containing(after, "long history")).toHaveLength(0);
      expect(containing(after, "RULES v2")).toHaveLength(1);
      expect(containing(after, "RULES v1")).toHaveLength(0);
      // No orphaned update; the context is told once, in full.
      expect(containing(after, LEDGER_UPDATE_PREAMBLE)).toHaveLength(0);
      expect(containing(after, "two.marker")).toHaveLength(1);
      expect(textOf(containing(after, "two.marker")[0]!)).toContain("one.marker");

      // Nothing engine-authored is left looking like something a person said.
      const conversation = engine
        .getSessionManager()
        .resume(sessionId)
        .transcript.toConversationMessages()
        .map(textOf)
        .join("\n");
      expect(conversation).toContain("second task");
      expect(conversation).not.toContain("RULES");
      expect(conversation).not.toContain(".marker");

      // A new process replays the same history.
      const restarted = hooked();
      await restarted.run("third task", { sessionId, cwd: repo });
      expect(requests).toHaveLength(5);
      expectAppendOnly([wire(requests[3]!), wire(requests[4]!)]);
      expect(containing(requests[4]!, "RULES v2")).toHaveLength(1);
      expect(containing(requests[4]!, "two.marker")).toHaveLength(1);
    });
  });

  describe("hook reminder position, live versus replayed", () => {
    const call = (id: string, toolName: string, args: Record<string, unknown>): LLMResponse => ({
      text: "",
      toolCalls: [{ id, toolName, args }],
      stopReason: "tool_use",
      usage: { promptTokens: 1000, completionTokens: 1, totalTokens: 1001 },
    });
    const indexOfText = (request: Message[], needle: string): number =>
      request.findIndex((message) => textOf(message).includes(needle));

    it("agrees after a notes rollover written before the run's hooks", async () => {
      const sessionId = "s-hardening-prerun-rollover";
      const { requests } = scenario([
        call("n1", "SaveContextNote", { note: "Continue the task; nothing is finished yet." }),
        stop("first done"),
        stop("second done"),
        stop("third done"),
      ]);
      const hooked = (): Engine => {
        const engine = newEngine({
          enabledBuiltinTools: ["SaveContextNote", "NewContext"],
          contextStrategy: "notes",
        });
        (engine as any).hooks.register("on_session_start", async () => ({ messages: ["RULES"] }));
        return engine;
      };
      const engine = hooked();
      await engine.run(`first task ${"long history ".repeat(600)}`, { sessionId, cwd: repo });
      await engine.run("second task", {
        sessionId,
        cwd: repo,
        clientMessageId: "client-2",
        archiveBeforeCurrentTurn: {},
      } as never);
      expect(requests).toHaveLength(3);
      const live = requests[2]!;
      expect(indexOfText(live, "<context-note>")).toBeGreaterThanOrEqual(0);
      expect(indexOfText(live, "long history")).toBe(-1);
      // The reminder sits just before the task it was issued for.
      expect(live[indexOfText(live, "RULES") + 1]).toEqual({ role: "user", content: "second task" });

      const restarted = hooked();
      await restarted.run("third task", { sessionId, cwd: repo });
      expect(requests).toHaveLength(4);
      expectAppendOnly([wire(live), wire(requests[3]!)]);
    });

    it("agrees after an anchored archive that ends at a message with a reminder", async () => {
      const sessionId = "s-hardening-anchored-archive";
      scenario([stop("first done"), stop("second done")]);
      const engine = newEngine();
      let rules = "RULES v1";
      (engine as any).hooks.register("on_session_start", async () => ({ messages: [rules] }));
      await engine.run("first task", { sessionId, cwd: repo, clientMessageId: "client-1" });
      rules = "RULES v2";
      await engine.run("second task", { sessionId, cwd: repo, clientMessageId: "client-2" });

      const stats = await engine.archiveTurnRange(
        sessionId,
        { start: 0, end: 0 },
        { fromClientMessageId: "client-1", toClientMessageId: "client-2" },
      );
      expect(stats.after).not.toBe(stats.before);
      const live = (engine as any).compactedMessagesBySession.get(sessionId) as Message[];
      const replayed = engine.getSessionManager().resume(sessionId).transcript.toMessages();
      expect(wire(live)).toEqual(wire(replayed));
      // The boundary message keeps its reminder; the archived span lost its own.
      const texts = live.map(textOf);
      expect(texts.filter((text) => text.includes("RULES v2"))).toHaveLength(1);
      expect(texts[texts.findIndex((text) => text.includes("RULES v2")) + 1]).toBe("second task");
      expect(texts.some((text) => text.includes("first task"))).toBe(false);
    });
  });

  describe("reminders added inside a run", () => {
    it("are replayed from disk where the previous process sent them", async () => {
      const sessionId = "s-hardening-turn-reminders";
      const { requests } = scenario([toolStep("t1"), stop("first done"), stop("second done")]);
      const hooked = (): Engine => {
        const engine = newEngine();
        let turn = 0;
        (engine as any).hooks.register("on_turn_start", async () => ({
          messages: [`TURN NOTE ${(turn += 1)}`],
        }));
        return engine;
      };
      await hooked().run("first task", { sessionId, cwd: repo });
      expect(requests).toHaveLength(2);
      expect(textOf(requests[1]!.at(-1)!)).toContain("TURN NOTE 2");

      await hooked().run("second task", { sessionId, cwd: repo });
      expect(requests).toHaveLength(3);
      expectAppendOnly(requests.map(wire));
      const notes = requests[2]!.map(textOf).filter((text) => text.includes("TURN NOTE"));
      expect(notes.map((text) => text.split("\n")[1])).toEqual([
        "TURN NOTE 1",
        "TURN NOTE 2",
        "TURN NOTE 1",
      ]);

      // Stored as engine context, never as something the user said.
      const stored = events(sessionId).filter((event) =>
        JSON.stringify(event.data.content ?? "").includes("TURN NOTE"),
      );
      expect(stored).toHaveLength(3);
      for (const event of stored) {
        expect(event.data.injected).toBe(true);
        expect(event.data.hookReminder).toEqual({});
      }
      const conversation = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: repo,
        sessionStorageDir: sessions,
        headless: true,
      })
        .getSessionManager()
        .resume(sessionId)
        .transcript.toConversationMessages();
      expect(JSON.stringify(conversation)).not.toContain("TURN NOTE");
    });
  });

  describe("non-durable runtime context (dynamic placement)", () => {
    const worldProfile = {
      id: "world-test",
      runtimeContextTag: "test-world",
      runtimeContextPlacement: "dynamic" as const,
    };
    const isWorld = (message: Message | undefined): boolean =>
      message !== undefined && textOf(message).includes("<test-world>");
    const runTwo = async (llmExtra: Record<string, unknown>): Promise<Scenario> => {
      const sessionId = "s-hardening-world";
      const state = scenario([
        toolStep("t1"),
        toolStep("t2"),
        stop("first done"),
        stop("second done"),
      ]);
      const engine = newEngine({
        llm: { provider, model, apiKey: "test", ...llmExtra } as never,
        behaviorProfiles: [worldProfile],
      });
      const run = (task: string, world: string) =>
        engine.run(task, {
          sessionId,
          cwd: repo,
          behaviorMode: worldProfile.id,
          profileParams: { runtimeContext: world },
        } as never);
      await run("first task", "WORLD-ONE");
      await run("second task", "WORLD-TWO");
      expect(state.requests).toHaveLength(4);
      // Non-durable: never stored, and an earlier status is not visible later.
      expect(JSON.stringify(events(sessionId))).not.toContain("WORLD-");
      expect(JSON.stringify(state.requests[3])).not.toContain("WORLD-ONE");
      return state;
    };

    it("rides the true tail of every request on an explicit-breakpoint route", async () => {
      const { requests, stablePrefix } = await runTwo({ promptCaching: "anthropic-explicit" });
      for (const [index, request] of requests.entries()) {
        expect(request.filter(isWorld)).toHaveLength(1);
        expect(isWorld(request.at(-1))).toBe(true);
        // The stable breakpoint sits on the message just before it.
        expect(stablePrefix[index]).toBe(request.length - 1);
      }
      expect(textOf(requests[3]!.at(-1)!)).toContain("WORLD-TWO");
      // History itself — everything but the trailing status — only grows.
      expectAppendOnly(requests.map((request) => request.slice(0, -1)));
    });

    it("stays in place on a route without explicit breakpoints", async () => {
      const { requests } = await runTwo({});
      // Within a run each request extends the previous one in full, so the
      // implicit previous-request save point keeps working.
      expectAppendOnly(requests.slice(0, 3));
      expect(isWorld(requests[0]!.at(-1))).toBe(true);
      expect(isWorld(requests[2]!.at(-1))).toBe(false);
      expect(requests[2]!.filter(isWorld)).toHaveLength(1);
    });
  });
});

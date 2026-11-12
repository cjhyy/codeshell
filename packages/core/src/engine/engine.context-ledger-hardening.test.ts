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

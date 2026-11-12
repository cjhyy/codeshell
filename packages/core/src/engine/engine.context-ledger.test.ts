import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, Message, TranscriptEvent } from "../types.js";
import type { AgentModule } from "../composition/types.js";
import { LEDGER_UPDATE_PREAMBLE } from "../context/context-ledger.js";
import { MemoryManager } from "../session/memory.js";
import { invalidateSkillCache } from "../skills/scanner.js";

const provider = "fake-engine-context-ledger";
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

type Scenario = {
  requests: Message[][];
  /** promptCache.stablePrefixMessageCount of each request. */
  stablePrefix: (number | undefined)[];
  responses: LLMResponse[];
  summaries: number;
};
const scenarios = new Map<string, Scenario>();

class FakeLedgerClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing fake scenario: ${this.model}`);
    if (!options.systemPrompt.includes("Working directory:")) {
      if (options.systemPrompt.includes("conversation summarizer")) scenario.summaries += 1;
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

registerProvider(provider, FakeLedgerClient);

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
  id: "context-ledger-test-context",
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

/**
 * A finished text reply is a string in the live message list but is stored
 * (and replayed) as a single text block; providers serialize both the same.
 * Comparing a live request with a replayed one has to look past that.
 */
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

describe("Engine context ledger", () => {
  let repo: string;
  let sessions: string;
  let home: string;
  let prevHome: string | undefined;
  let prevCodeShellHome: string | undefined;
  let model: string;

  const scenario = (responses: LLMResponse[]): Scenario => {
    const value: Scenario = { requests: [], stablePrefix: [], responses, summaries: 0 };
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
  const remember = (name: string, description: string): void => {
    new MemoryManager({ projectDir: repo }).save({ name, description, type: "user", content: "x" });
  };
  const addSkill = (name: string, description: string): void => {
    const dir = join(repo, ".code-shell", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\nbody`,
    );
    invalidateSkillCache();
  };
  const events = (sessionId: string): TranscriptEvent[] =>
    readFileSync(join(sessions, sessionId, "transcript.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TranscriptEvent);
  const ledgerKinds = (sessionId: string): string[] =>
    events(sessionId)
      .filter((event) => event.data.contextLedger !== undefined)
      .map((event) => (event.data.contextLedger as { kind: string }).kind);
  /** Messages the later request added on top of the earlier one. */
  const added = (requests: Message[][], index: number): Message[] =>
    requests[index]!.slice(requests[index - 1]!.length);

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cs-context-ledger-repo-"));
    sessions = mkdtempSync(join(tmpdir(), "cs-context-ledger-sessions-"));
    home = mkdtempSync(join(tmpdir(), "cs-context-ledger-home-"));
    prevHome = process.env.HOME;
    prevCodeShellHome = process.env.CODE_SHELL_HOME;
    process.env.HOME = home;
    process.env.CODE_SHELL_HOME = home;
    model = `${provider}-${Date.now()}-${Math.random()}`;
    execFileSync("git", ["init", "-q"], { cwd: repo, env, stdio: "ignore" });
    writeFileSync(join(repo, "CODESHELL.md"), "project instructions\n");
    writeFileSync(join(repo, "one.marker"), "");
    remember("m1", "first fact");
    remember("m2", "second fact");
    remember("m3", "third fact");
    invalidateSkillCache();
  });

  afterEach(() => {
    scenarios.delete(model);
    invalidateSkillCache();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = prevCodeShellHome;
    for (const dir of [repo, sessions, home]) rmSync(dir, { recursive: true, force: true });
  });

  it("ends the stable cache prefix where each run started", async () => {
    const sessionId = "s-ledger-stable-prefix";
    const { requests, stablePrefix } = scenario([
      toolStep("t1"),
      stop("first done"),
      stop("second done"),
    ]);
    const engine = newEngine();

    await engine.run("first task", { sessionId, cwd: repo });
    await engine.run("second task", { sessionId, cwd: repo });

    expect(requests).toHaveLength(3);
    const taskIndex = (request: Message[], task: string): number =>
      request.findIndex((message) => message.content === task);
    // The breakpoint lands on the message before the run's user task, on
    // every request of that run — not on the growing tail.
    expect(taskIndex(requests[0]!, "first task")).toBe(1);
    expect(stablePrefix.slice(0, 2)).toEqual([1, 1]);
    expect(stablePrefix[2]).toBe(taskIndex(requests[2]!, "second task"));
    expect(stablePrefix[2]).toBeGreaterThan(requests[1]!.length - 1);
    // The run's context manager is told the route's cache retention (the fake
    // provider is provider-managed: 5 minutes, not the 30-minute default).
    expect((engine as any).lastContextManager.config.promptCacheTtlMs).toBe(5 * 60_000);
  });

  it("keeps every request a prefix of the next across runs and only appends what changed", async () => {
    const sessionId = "s-ledger-prefix";
    const { requests } = scenario([
      toolStep("t1"),
      stop("first done"),
      stop("second done"),
      stop("third done"),
    ]);
    const engine = newEngine();

    await engine.run("first task", { sessionId, cwd: repo });
    expect(requests).toHaveLength(2);
    const snapshot = requests[0]!.at(-1)!;
    expect(requests[0]!.at(-2)).toEqual({ role: "user", content: "first task" });
    expect(textOf(snapshot)).toContain("one.marker");
    expect(textOf(snapshot)).toContain("m1: first fact");
    expect(textOf(snapshot)).not.toContain(LEDGER_UPDATE_PREAMBLE);

    remember("m4", "learned after the first run");
    await engine.run("second task", { sessionId, cwd: repo });
    await engine.run("third task", { sessionId, cwd: repo });

    expect(requests).toHaveLength(4);
    expectAppendOnly(requests);

    // Run 2: the previous reply, the new task, and one update with only m4.
    const run2 = added(requests, 2);
    expect(run2.map((message) => message.role)).toEqual(["assistant", "user", "user"]);
    expect(run2[1]).toEqual({ role: "user", content: "second task" });
    const update = textOf(run2[2]!);
    expect(update).toContain(LEDGER_UPDATE_PREAMBLE);
    expect(update).toContain('<context-update section="memory">\n+ ');
    expect(update).toContain("m4: learned after the first run");
    for (const stale of ["m1:", "m2:", "m3:", "one.marker"]) expect(update).not.toContain(stale);

    // Run 3: nothing changed, so nothing but the conversation is added.
    expect(added(requests, 3)).toEqual([
      { role: "assistant", content: "second done" },
      { role: "user", content: "third task" },
    ]);
    expect(ledgerKinds(sessionId)).toEqual(["snapshot", "update"]);
  });

  it("does not resend skills when only their ranking changed, and sends just an installed one", async () => {
    const sessionId = "s-ledger-skills";
    for (let i = 0; i < 40; i++) addSkill(`filler-${i}`, `filler capability ${i} `.repeat(30));
    const { requests } = scenario([stop("one"), stop("two"), stop("three")]);
    const engine = newEngine({
      enabledBuiltinTools: ["Skill"],
      llm: { provider, model, apiKey: "test", maxContextTokens: 64_000 } as never,
    });

    await engine.run("please use filler-3 for this", { sessionId, cwd: repo });
    expect(textOf(requests[0]!.at(-1)!)).toContain("# Available Skills");
    await engine.run("now a job for filler-27 and filler-31", { sessionId, cwd: repo });
    expect(added(requests, 1)).toEqual([
      { role: "assistant", content: "one" },
      { role: "user", content: "now a job for filler-27 and filler-31" },
    ]);

    addSkill("fresh-skill", "installed between runs");
    await engine.run("anything else", { sessionId, cwd: repo });
    const run3 = added(requests, 2);
    expect(run3).toHaveLength(3);
    const update = textOf(run3[2]!);
    expect(update).toContain('<context-update section="skills">\n+ ');
    expect(update).toContain("fresh-skill");
    expect(update).not.toContain("filler-");
    expectAppendOnly(requests);
  });

  it("injects an unchanged hook reminder once and appends a changed one", async () => {
    const sessionId = "s-ledger-hooks";
    const { requests } = scenario([stop("one"), stop("two"), stop("three"), stop("four")]);
    const engine = newEngine();
    let startText = "SESSION RULES v1";
    (engine as any).hooks.register("on_session_start", async () => ({ messages: [startText] }));
    (engine as any).hooks.register("user_prompt_submit", async () => ({
      messages: ["check skills first"],
    }));
    const reminders = (request: Message[]): string[] =>
      request
        .map(textOf)
        .filter((text) => text.includes("SESSION RULES") || text.includes("check skills"));

    for (const task of ["first", "second", "third"])
      await engine.run(task, { sessionId, cwd: repo });
    expect(reminders(requests[2]!)).toEqual([
      "<system-reminder>\nSESSION RULES v1\n\ncheck skills first\n</system-reminder>",
    ]);
    // Just before the first run's user task.
    const index = requests[2]!.findIndex((message) => textOf(message).includes("SESSION RULES"));
    expect(requests[2]![index + 1]).toEqual({ role: "user", content: "first" });

    startText = "SESSION RULES v2";
    await engine.run("fourth", { sessionId, cwd: repo });
    expect(reminders(requests[3]!)).toEqual([
      "<system-reminder>\nSESSION RULES v1\n\ncheck skills first\n</system-reminder>",
      "<system-reminder>\nSESSION RULES v2\n</system-reminder>",
    ]);
    expect(requests[3]!.at(-1)).toEqual({ role: "user", content: "fourth" });
    expect(textOf(requests[3]!.at(-2)!)).toContain("SESSION RULES v2");
    expectAppendOnly(requests);

    const stored = events(sessionId).filter((event) => event.data.hookReminder !== undefined);
    expect(stored.map((event) => event.data.injected)).toEqual([true, true]);
    expect(stored[1]!.data.hookReminder).toEqual({
      beforeEventId: expect.any(String),
      sessionStart: ["SESSION RULES v2"],
    });
  });

  it("a new process resumes from disk with the same prefix and no second snapshot", async () => {
    const sessionId = "s-ledger-resume";
    const { requests } = scenario([stop("first done"), stop("second done"), stop("third done")]);
    const hooked = (): Engine => {
      const engine = newEngine();
      (engine as any).hooks.register("on_session_start", async () => ({ messages: ["RULES"] }));
      return engine;
    };
    const first = hooked();
    await first.run("first task", { sessionId, cwd: repo });
    remember("m4", "learned after the first run");
    await first.run("second task", { sessionId, cwd: repo });
    expect(requests).toHaveLength(2);
    expect(ledgerKinds(sessionId)).toEqual(["snapshot", "update"]);

    const second = hooked();
    expect((second as any).compactedMessagesBySession.has(sessionId)).toBe(false);
    await second.run("third task", { sessionId, cwd: repo });

    expect(requests).toHaveLength(3);
    expectAppendOnly(requests.map(wire));
    expect(wire(added(requests, 2))).toEqual([
      { role: "assistant", content: "second done" },
      { role: "user", content: "third task" },
    ]);
    // Everything that is not an assistant reply is replayed byte for byte.
    const nonAssistant = (request: Message[]): Message[] =>
      request.filter((message) => message.role !== "assistant");
    expect(nonAssistant(requests[2]!).slice(0, nonAssistant(requests[1]!).length)).toEqual(
      nonAssistant(requests[1]!),
    );
    expect(ledgerKinds(sessionId)).toEqual(["snapshot", "update"]);
    expect(events(sessionId).filter((event) => event.data.hookReminder !== undefined)).toHaveLength(
      1,
    );
    // The reminder is the second message: after the user context, before the first task.
    expect(textOf(requests[2]![1]!)).toBe("<system-reminder>\nRULES\n</system-reminder>");
    expect(requests[2]![2]).toEqual({ role: "user", content: "first task" });
  });

  it("resends a snapshot after compaction dropped the context, then stays quiet", async () => {
    const sessionId = "s-ledger-compaction";
    mkdirSync(join(repo, ".code-shell"), { recursive: true });
    writeFileSync(
      join(repo, ".code-shell", "settings.json"),
      JSON.stringify({
        context: { compactAtRatio: 0.28, summarizeAtRatio: 0.99, microcompactFloorRatio: 0.28 },
      }),
    );
    const early = "assistant payload ".repeat(200);
    const steps = Array.from({ length: 10 }, (_, i) =>
      toolStep(`t${i}`, `${i < 5 ? early : "recent payload ".repeat(10)}${i}`, i < 9 ? 2000 : 5000),
    );
    const state = scenario([...steps, stop("done after compaction"), stop("next run done")]);
    const engine = newEngine({ maxContextTokens: 10_000 });

    await engine.run("force summary compaction", { sessionId, cwd: repo });
    expect(state.summaries).toBeGreaterThan(0);
    const { requests } = state;
    const extendsPrevious = (index: number): boolean => {
      const earlier = requests[index - 1]!;
      return JSON.stringify(requests[index]!.slice(0, earlier.length)) === JSON.stringify(earlier);
    };
    const rewrites = requests.map((_, index) => index).filter((i) => i > 0 && !extendsPrevious(i));
    expect(rewrites.length).toBeGreaterThan(0);
    const withContext = (request: Message[]): Message[] =>
      request.filter(
        (message) => message.role === "user" && textOf(message).includes("one.marker"),
      );
    for (const index of rewrites) {
      // The rewrite dropped the context; the very next request carries it
      // again, once, as a full snapshot at the tail.
      const request = requests[index]!;
      expect(withContext(request)).toHaveLength(1);
      expect(withContext(request)[0]).toBe(request.at(-1)!);
      expect(textOf(request.at(-1)!)).not.toContain(LEDGER_UPDATE_PREAMBLE);
    }
    // Every request has the context exactly once; none ran without it.
    for (const request of requests) expect(withContext(request)).toHaveLength(1);
    const kinds = ledgerKinds(sessionId);
    expect(kinds).toEqual(Array.from({ length: 1 + rewrites.length }, () => "snapshot"));
    const settled = requests.slice(rewrites.at(-1)!);

    const before = requests.length;
    await engine.run("unchanged follow-up", { sessionId, cwd: repo });
    expect(requests).toHaveLength(before + 1);
    expect(ledgerKinds(sessionId)).toEqual(kinds);
    expectAppendOnly([...settled, requests.at(-1)!]);
    expect(requests.at(-1)!.at(-1)).toEqual({ role: "user", content: "unchanged follow-up" });
  });

  it("holds the prefix property for a non-persistent session", async () => {
    const sessionId = "s-ledger-ephemeral";
    const { requests } = scenario([toolStep("t1"), stop("first done"), stop("second done")]);
    const engine = newEngine();

    await engine.run("first task", { sessionId, cwd: repo, ephemeral: true });
    remember("m4", "learned after the first run");
    await engine.run("second task", { sessionId, cwd: repo, ephemeral: true });

    expect(requests).toHaveLength(3);
    expectAppendOnly(requests);
    const run2 = added(requests, 2);
    expect(run2).toHaveLength(3);
    expect(textOf(run2[2]!)).toContain("m4: learned after the first run");
    expect(textOf(run2[2]!)).not.toContain("m1:");
    expect(() => events(sessionId)).toThrow();
  });

  it("a session with only whole-text context snapshots it once", async () => {
    const sessionId = "s-ledger-bare";
    const bare = mkdtempSync(join(tmpdir(), "cs-context-ledger-bare-"));
    try {
      const { requests } = scenario([stop("one"), stop("two")]);
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: bare,
        sessionStorageDir: sessions,
        enabledBuiltinTools: [],
        preset: "general",
        modules: [],
        headless: true,
      });
      (engine as any).hooks.clear();
      await engine.run("first", { sessionId, cwd: bare });
      await engine.run("second", { sessionId, cwd: bare });
      expect(requests[0]!.at(-2)).toEqual({ role: "user", content: "first" });
      expect(textOf(requests[0]!.at(-1)!)).not.toContain("Persistent Memory");
      expect(requests[1]!.at(-1)).toEqual({ role: "user", content: "second" });
      expectAppendOnly(requests);
      expect(ledgerKinds(sessionId)).toEqual(["snapshot"]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

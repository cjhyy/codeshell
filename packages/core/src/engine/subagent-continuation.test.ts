import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubAgentContinuation } from "../types.js";
import { SessionManager } from "../session/session-manager.js";
import { runWithSid } from "../logging/logger.js";
import { openRunSession, type OpenRunSessionArgs } from "./run-session-open.js";
import { createSubAgentSpawner, resolveChildToolScope } from "./subagent-spawner.js";
import type { EngineConfig } from "./types.js";
import type { EngineRunOptions } from "./run-types.js";

const dirs: string[] = [];

function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagent-continuation-"));
  dirs.push(dir);
  return dir;
}

function snapshot(): SubAgentContinuation {
  return {
    version: 1,
    parentSessionId: "parent",
    agentType: "reviewer",
    name: "Review",
    description: "inspect the change",
    maxTurns: 8,
    model: "small",
    toolAllowlist: ["Read", "Grep"],
    skillAllowlist: [],
    sandboxMode: "bwrap",
    mcpAllowlist: [],
    appendSystemPrompt: "Review without writing.",
    readOnlySession: true,
  };
}

function openArgs(manager: SessionManager, metadata?: SubAgentContinuation): OpenRunSessionArgs {
  return {
    sessionManager: manager,
    options: { sessionId: "child", subAgentContinuation: metadata },
    parsedTask: { text: "work", images: [], hasImages: false },
    taskText: "work",
    userMessageContent: "work",
    cwd: "/repo",
    sessionKind: "work",
    sessionWorkspaceProfile: undefined,
    llmModel: "test",
    llmProvider: "test",
    isSubAgent: true,
    origin: undefined,
    costStore: undefined,
    cachedCompactedMessages: undefined,
    onAgentDirectionsDelivered: undefined,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("durable sub-agent continuation scope", () => {
  it("saves the original role and every scope before the first child run, across managers", () => {
    const dir = temporaryDir();
    const manager = new SessionManager(dir);
    const metadata = snapshot();
    const result = runWithSid("parent", () => openRunSession(openArgs(manager, metadata)));
    expect(result).toMatchObject({ ok: true });
    metadata.toolAllowlist!.push("Write");

    const restarted = new SessionManager(dir);
    expect(restarted.readParentSessionId("child")).toBe("parent");
    expect(restarted.readSubAgentContinuation("child")).toEqual(snapshot());
    const copy = restarted.readSubAgentContinuation("child")!;
    copy.skillAllowlist!.push("untrusted");
    expect(restarted.readSubAgentContinuation("child")).toEqual(snapshot());
  });

  it("records an explicit ephemeral role without replacing it with a later default", () => {
    const dir = temporaryDir();
    const manager = new SessionManager(dir);
    const metadata = { ...snapshot(), agentType: null, toolAllowlist: undefined };
    runWithSid("parent", () => openRunSession(openArgs(manager, metadata)));
    expect(new SessionManager(dir).readSubAgentContinuation("child")).toMatchObject({
      agentType: null,
    });
    expect(
      new SessionManager(dir).readSubAgentContinuation("child")!.toolAllowlist,
    ).toBeUndefined();
  });

  it("rejects changed ownership or scope before appending a resumed prompt", () => {
    const dir = temporaryDir();
    const manager = new SessionManager(dir);
    runWithSid("parent", () => openRunSession(openArgs(manager, snapshot())));
    const before = manager.resume("child").transcript.eventCount;
    const resume = (metadata: SubAgentContinuation, caller = "parent") =>
      runWithSid(caller, () => openRunSession(openArgs(manager, metadata)));
    expect(() => resume({ ...snapshot(), parentSessionId: "other" }, "other")).toThrow(
      /parent|frozen scope/i,
    );
    expect(() => resume({ ...snapshot(), toolAllowlist: ["Read", "Write"] })).toThrow(
      /frozen scope/i,
    );
    expect(() => resume({ ...snapshot(), sandboxMode: "off" })).toThrow(/frozen scope/i);
    expect(manager.resume("child").transcript.eventCount).toBe(before);
    expect(manager.readParentSessionId("child")).toBe("parent");
    expect(manager.readSubAgentContinuation("child")).toEqual(snapshot());
    expect(resume({ ...snapshot(), name: "Review", model: "small" })).toMatchObject({ ok: true });
  });

  it("does not invent durable authority for legacy sessions and rejects malformed metadata", () => {
    const dir = temporaryDir();
    const manager = new SessionManager(dir);
    manager.create("/repo", "test", "test", "child", "parent");
    expect(manager.readSubAgentContinuation("child")).toBeUndefined();
    runWithSid("parent", () => openRunSession(openArgs(manager, snapshot())));
    expect(manager.readSubAgentContinuation("child")).toBeUndefined();

    const file = join(dir, "child", "state.json");
    const state = JSON.parse(readFileSync(file, "utf-8"));
    for (const invalid of [
      { ...snapshot(), parentSessionId: "other" },
      { ...snapshot(), toolAllowlist: null },
      { ...snapshot(), skillAllowlist: [2] },
      { ...snapshot(), agentType: undefined },
      { ...snapshot(), sandboxMode: "invalid" },
    ]) {
      writeFileSync(file, JSON.stringify({ ...state, subAgentContinuation: invalid }));
      expect(new SessionManager(dir).readSubAgentContinuation("child")).toBeUndefined();
    }
  });

  it("fails creation when the frozen metadata cannot be saved or belongs to another parent", () => {
    const dir = temporaryDir();
    const manager = new SessionManager(dir);
    expect(() =>
      manager.create(
        "/repo",
        "test",
        "test",
        "child",
        "other",
        undefined,
        "work",
        false,
        snapshot(),
      ),
    ).toThrow(/parent ownership/i);
    expect(manager.exists("child")).toBe(false);
    (manager as any).writeStateAtomically = () => {
      throw new Error("disk write failed");
    };
    expect(() => runWithSid("parent", () => openRunSession(openArgs(manager, snapshot())))).toThrow(
      /disk write failed/i,
    );
    expect(manager.readSubAgentContinuation("child")).toBeUndefined();
  });

  it("forwards trusted metadata through both legacy and live child runners", async () => {
    for (const live of [false, true]) {
      const runs: EngineRunOptions[] = [];
      const metadata = snapshot();
      const run = async (_task: string, options?: EngineRunOptions) => {
        runs.push(options!);
        return {
          text: "done",
          reason: "completed" as const,
          sessionId: options!.sessionId!,
          turnCount: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      };
      const spawner = createSubAgentSpawner({
        parentConfig: {
          llm: { model: "test", provider: "openai" },
          disabledBuiltinTools: ["Grep"],
          enabledBuiltinTools: [],
        } as EngineConfig,
        parentSessionId: "parent",
        parentSandbox: { mode: "off" },
        presetName: "general",
        cwd: "/repo",
        permissionMode: "acceptEdits",
        appendParentSubagent: () => {},
        sessionExists: () => false,
        getSessionContinuation: () => metadata,
        childRunner: {
          ...(live ? { createChild: () => ({ run, setAgentControlStateListener: () => {} }) } : {}),
          runChild: (_config, task, options) => run(task, options),
        },
      });
      await spawner.spawn({
        agentId: "child",
        prompt: "inspect",
        description: metadata.description,
        maxTurns: metadata.maxTurns,
        toolAllowlist: metadata.toolAllowlist,
        continuation: metadata,
        runtimeGeneration: 1,
        signal: new AbortController().signal,
      });
      expect(runs).toHaveLength(1);
      expect(runs[0]!.subAgentContinuation).toEqual(metadata);
      expect(runs[0]!.toolAllowlist).toEqual(["Read"]);
      expect(spawner.getSessionContinuation?.("child")).toEqual(metadata);
      await spawner.spawn({
        agentId: "empty-child",
        prompt: "inspect",
        description: metadata.description,
        maxTurns: metadata.maxTurns,
        toolAllowlist: [],
        runtimeGeneration: 1,
        signal: new AbortController().signal,
      });
      expect(runs[1]!.toolAllowlist).toEqual([]);
      await spawner.spawn({
        agentId: "inherited-child",
        prompt: "inspect",
        description: metadata.description,
        maxTurns: metadata.maxTurns,
        runtimeGeneration: 1,
        signal: new AbortController().signal,
      });
      expect(runs[2]!.toolAllowlist).toBeUndefined();
    }
  });

  it("keeps role tools while respecting parent disabled tools and force-enabled overlays", () => {
    const role = ["Read", "Write", "Grep", "Agent", "AgentSendInput"];
    const scope = resolveChildToolScope(role, ["Write"], ["Read", "Write"]);
    expect(scope.enabled).toEqual(["Read", "Grep"]);
    expect(scope.disabled).toEqual([
      "Write",
      "Agent",
      "AgentStatus",
      "AgentCancel",
      "AgentSendInput",
    ]);
    expect(resolveChildToolScope(role, ["Write"], undefined).enabled).toEqual(["Read", "Grep"]);
    expect(resolveChildToolScope(role, undefined, []).enabled).toEqual(["Read", "Write", "Grep"]);
    expect(resolveChildToolScope([], undefined, undefined).enabled).toEqual([]);
  });
});

import { describe, expect, it } from "bun:test";
import type { EngineConfig } from "./types.js";
import {
  createSubAgentSpawner,
  resolveChildToolScope,
  wrapChildStream,
} from "./subagent-spawner.js";

function parentConfig(): EngineConfig {
  return {
    llm: { provider: "openai", model: "parent", apiKey: "test" },
    clientDefaults: { temperature: 0.4, retryMaxAttempts: 8 },
    cwd: "/repo",
    permissionMode: "acceptEdits",
    preset: "terminal-coding",
    enabledBuiltinTools: ["Read", "Agent", "AgentSendInput"],
    disabledBuiltinTools: ["Write"],
    customSystemPrompt: "custom",
    appendSystemPrompt: "parent append",
    responseLanguage: "zh-CN",
    userProfile: "profile",
    maxContextTokens: 123_000,
    sessionStorageDir: "/sessions",
    headless: true,
    sandbox: { mode: "off", network: "deny" },
  } as EngineConfig;
}

describe("subagent spawner", () => {
  it("builds a child config through the injected runner and anchors cold spawns", async () => {
    const anchors: unknown[][] = [];
    const runs: Array<{ config: EngineConfig; task: string; sessionId?: string }> = [];
    const spawner = createSubAgentSpawner({
      parentConfig: parentConfig(),
      presetName: "terminal-coding",
      cwd: "/repo",
      permissionMode: "acceptEdits",
      appendParentSubagent: (agentId, description) =>
        anchors.push([agentId, undefined, description]),
      sessionExists: (sid) => sid === "existing",
      childRunner: {
        async runChild(config, task, options) {
          runs.push({ config, task, sessionId: options.sessionId });
          return {
            text: "child result",
            sessionId: options.sessionId!,
            usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
          };
        },
      },
    });

    const result = await spawner.spawn({
      agentId: "child-1",
      description: "research",
      prompt: "inspect",
      maxTurns: 9,
      signal: new AbortController().signal,
      toolAllowlist: ["Read", "Agent", "AgentSendInput"],
      skillAllowlist: ["docs"],
      appendSystemPrompt: "role body",
      readOnlySession: true,
    });

    expect(anchors).toEqual([["child-1", undefined, "research"]]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ task: "inspect", sessionId: "child-1" });
    expect(runs[0]!.config).toMatchObject({
      llm: { model: "parent" },
      clientDefaults: { temperature: 0.4, retryMaxAttempts: 2 },
      enabledBuiltinTools: ["Read"],
      disabledBuiltinTools: ["Agent", "AgentStatus", "AgentCancel", "AgentSendInput"],
      appendSystemPrompt: "parent append\n\nrole body",
      maxTurns: 9,
      skillAllowlist: ["docs"],
      readOnlySession: true,
      isSubAgent: true,
    });
    expect(result).toMatchObject({ text: "child result", sessionId: "child-1" });
    expect(spawner.sessionExists?.("existing")).toBe(true);
  });

  it("resumes the requested sid without writing a duplicate parent anchor", async () => {
    let anchors = 0;
    let childSid = "";
    const spawner = createSubAgentSpawner({
      parentConfig: parentConfig(),
      presetName: "terminal-coding",
      cwd: "/repo",
      permissionMode: "acceptEdits",
      appendParentSubagent: () => anchors++,
      sessionExists: () => true,
      childRunner: {
        async runChild(_config, _task, options) {
          childSid = options.sessionId!;
          return { text: "continued", sessionId: childSid };
        },
      },
    });

    await spawner.spawn({
      agentId: "child-1",
      description: "continue",
      prompt: "next",
      maxTurns: 3,
      signal: new AbortController().signal,
      resumeSessionId: "existing",
    });
    expect(anchors).toBe(0);
    expect(childSid).toBe("existing");
  });

  it("filters child context events and tags forwarded events with agentId", () => {
    const seen: any[] = [];
    const stream = wrapChildStream((event) => seen.push(event), "child-1")!;
    stream({ type: "session_started", sessionId: "child-1" });
    stream({ type: "usage_update", promptTokens: 10 });
    stream({ type: "context_compact", strategy: "summary", before: 10, after: 2 });
    stream({ type: "text_delta", text: "hello" });
    expect(seen).toEqual([{ type: "text_delta", text: "hello", agentId: "child-1" }]);
  });

  it("always strips nested-agent tools from inherited and explicit scopes", () => {
    expect(resolveChildToolScope(["Read", "Agent"], undefined, undefined)).toEqual({
      enabled: ["Read"],
      disabled: ["Agent", "AgentStatus", "AgentCancel", "AgentSendInput"],
    });
  });
});

import { describe, expect, it } from "bun:test";
import type { EngineConfig } from "./types.js";
import {
  createSubAgentSpawner,
  resolveChildSandbox,
  resolveChildToolScope,
  wrapChildStream,
} from "./subagent-spawner.js";
import { RunEnvironmentResolver } from "./run-environment.js";
import { defaultSandboxConfig } from "../tool-system/sandbox/index.js";
import { notificationQueue } from "../tool-system/builtin/agent-notifications.js";

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
  it("interrupts then serially redrives the same child runtime and session", async () => {
    notificationQueue.reset();
    let runtimeCreations = 0;
    let activeRuns = 0;
    let maxActiveRuns = 0;
    const tasks: string[] = [];
    let resolveFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let liveControl:
      | import("../tool-system/builtin/agent-registry.js").LiveChildControl
      | undefined;
    const runtime = {
      stateListener: undefined as
        | ((state: import("../tool-system/builtin/agent-registry.js").LiveChildState) => void)
        | undefined,
      setAgentControlStateListener(
        listener:
          | ((state: import("../tool-system/builtin/agent-registry.js").LiveChildState) => void)
          | undefined,
      ) {
        this.stateListener = listener;
      },
      async run(task: string, options: { sessionId?: string; signal?: AbortSignal }) {
        activeRuns++;
        maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
        tasks.push(task);
        this.stateListener?.("model");
        if (tasks.length === 1) {
          firstStarted();
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        activeRuns--;
        return {
          text: tasks.length === 1 ? "aborted" : "redirected",
          reason: "completed" as const,
          sessionId: options.sessionId!,
          turnCount: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };
    const spawner = createSubAgentSpawner({
      parentConfig: parentConfig(),
      parentSandbox: parentConfig().sandbox!,
      presetName: "terminal-coding",
      cwd: "/repo",
      permissionMode: "acceptEdits",
      appendParentSubagent: () => {},
      sessionExists: () => false,
      childRunner: {
        createChild() {
          runtimeCreations++;
          return runtime;
        },
        async runChild() {
          throw new Error("legacy runner must not be used");
        },
      },
    });

    try {
      const run = spawner.spawn({
        agentId: "child-live",
        description: "live",
        prompt: "original",
        maxTurns: 3,
        signal: new AbortController().signal,
        runtimeGeneration: 4,
        bindLiveControl: (control) => {
          liveControl = control;
          return true;
        },
      });
      await firstStartedPromise;
      const ack = liveControl!.routeDirection({
        kind: "direction",
        from: { sessionId: "parent", authority: "agent" },
        to: { sessionId: "child-live", agentId: "child-live", authority: "agent" },
        delivery: "interrupt-and-redrive",
        runtimeGeneration: 4,
        payload: { prompt: "new direction", origin: "agent_send_input" },
      });
      expect((await ack).status).toBe("interrupted");
      const result = await run;

      expect(result.text).toBe("redirected");
      expect(runtimeCreations).toBe(1);
      expect(maxActiveRuns).toBe(1);
      expect(tasks).toHaveLength(2);
      expect(tasks[1]).toContain("new direction");
      expect(result.sessionId).toBe("child-live");
    } finally {
      resolveFirst?.();
      notificationQueue.reset();
    }
  });

  it("closes intake only after consuming a direction that won the completion race", async () => {
    notificationQueue.reset();
    const tasks: string[] = [];
    let liveControl:
      | import("../tool-system/builtin/agent-registry.js").LiveChildControl
      | undefined;
    let tailAck: Promise<unknown> | undefined;
    let intakeClosed = false;
    const runtime = {
      stateListener: undefined as
        | ((state: import("../tool-system/builtin/agent-registry.js").LiveChildState) => void)
        | undefined,
      setAgentControlStateListener(
        listener:
          | ((state: import("../tool-system/builtin/agent-registry.js").LiveChildState) => void)
          | undefined,
      ) {
        this.stateListener = listener;
      },
      async run(task: string, options: { sessionId?: string }) {
        tasks.push(task);
        this.stateListener?.("model");
        if (tasks.length === 1) {
          queueMicrotask(() => {
            tailAck = Promise.resolve(
              liveControl!.routeDirection({
                kind: "direction",
                from: { sessionId: "parent", authority: "agent" },
                to: { sessionId: "tail-child", agentId: "tail-child", authority: "agent" },
                delivery: "next-safe-point",
                runtimeGeneration: 3,
                payload: { prompt: "tail correction", origin: "agent_send_input" },
              }),
            );
          });
        }
        return {
          text: tasks.length === 1 ? "first final" : "corrected final",
          reason: "completed" as const,
          sessionId: options.sessionId!,
          turnCount: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };
    const spawner = createSubAgentSpawner({
      parentConfig: parentConfig(),
      parentSandbox: parentConfig().sandbox!,
      presetName: "terminal-coding",
      cwd: "/repo",
      permissionMode: "acceptEdits",
      appendParentSubagent: () => {},
      sessionExists: () => false,
      childRunner: {
        createChild: () => runtime,
        async runChild() {
          throw new Error("legacy runner must not be used");
        },
      },
    });

    const result = await spawner.spawn({
      agentId: "tail-child",
      description: "tail race",
      prompt: "original",
      maxTurns: 3,
      signal: new AbortController().signal,
      runtimeGeneration: 3,
      bindLiveControl: (control) => {
        liveControl = control;
        return true;
      },
      closeLiveControl: () => {
        intakeClosed = true;
        return true;
      },
    });

    await tailAck;
    expect(intakeClosed).toBe(true);
    expect(result.text).toBe("corrected final");
    expect(tasks).toHaveLength(2);
    expect(tasks[1]).toContain("tail correction");
    expect(notificationQueue.getSnapshot("tail-child")).toHaveLength(0);
  });

  it.each([
    ["seatbelt", "off"],
    ["seatbelt", "auto"],
    ["bwrap", "off"],
    ["bwrap", "auto"],
  ] as const)("does not widen parent %s sandbox with child %s", (parentMode, childMode) => {
    const parent = { ...defaultSandboxConfig(parentMode), network: "deny" as const };
    expect(resolveChildSandbox(childMode, parent)).toEqual(parent);
  });

  it("builds a child config through the injected runner and anchors cold spawns", async () => {
    const anchors: unknown[][] = [];
    const runs: Array<{ config: EngineConfig; task: string; sessionId?: string }> = [];
    const spawner = createSubAgentSpawner({
      parentConfig: parentConfig(),
      parentSandbox: parentConfig().sandbox!,
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
      parentSandbox: parentConfig().sandbox!,
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

  it("inherits parent sandbox and MCP config when the role leaves both undefined", async () => {
    let childConfig: EngineConfig | undefined;
    const parent = parentConfig();
    parent.mcpServers = {
      github: { name: "github", command: "github-mcp" },
      docs: { name: "docs", command: "docs-mcp" },
    };
    const spawner = createSubAgentSpawner({
      parentConfig: parent,
      parentSandbox: parent.sandbox!,
      presetName: "terminal-coding",
      cwd: "/repo",
      permissionMode: "acceptEdits",
      appendParentSubagent: () => {},
      sessionExists: () => false,
      childRunner: {
        async runChild(config, _task, options) {
          childConfig = config;
          return { text: "done", sessionId: options.sessionId! };
        },
      },
    });

    await spawner.spawn({
      agentId: "child-inherit",
      description: "inherit",
      prompt: "inspect",
      maxTurns: 2,
      signal: new AbortController().signal,
    });

    expect(childConfig?.sandbox).toBe(parent.sandbox);
    expect(childConfig?.mcpServers).toBe(parent.mcpServers);
  });

  it("inherits the effective project-settings sandbox when EngineConfig.sandbox is absent", async () => {
    const parent = parentConfig();
    delete parent.sandbox;
    const resolver = new RunEnvironmentResolver({
      config: () => parent,
      settings: () => ({
        get: () => ({}),
        getForScope: (scope: string) =>
          scope === "project" ? { sandbox: { mode: "seatbelt", network: "deny" } } : {},
      }),
      credentialAccess: { envExposures: () => ({}) },
    });
    const effectiveSandbox = resolver.resolveSandboxConfig("/repo");
    let childConfig: EngineConfig | undefined;
    const spawner = createSubAgentSpawner({
      parentConfig: parent,
      parentSandbox: effectiveSandbox,
      presetName: "terminal-coding",
      cwd: "/repo",
      permissionMode: "acceptEdits",
      appendParentSubagent: () => {},
      sessionExists: () => false,
      childRunner: {
        async runChild(config, _task, options) {
          childConfig = config;
          return { text: "done", sessionId: options.sessionId! };
        },
      },
    });

    await spawner.spawn({
      agentId: "child-project-sandbox",
      description: "inherit project sandbox",
      prompt: "inspect",
      maxTurns: 2,
      signal: new AbortController().signal,
    });

    expect(effectiveSandbox.mode).toBe("seatbelt");
    expect(effectiveSandbox.network).toBe("deny");
    expect(childConfig?.sandbox).toEqual(effectiveSandbox);
  });

  it("preserves an empty MCP allowlist as no child servers", async () => {
    let childConfig: EngineConfig | undefined;
    const parent = parentConfig();
    parent.mcpServers = { github: { name: "github", command: "github-mcp" } };
    const spawner = createSubAgentSpawner({
      parentConfig: parent,
      parentSandbox: parent.sandbox!,
      presetName: "terminal-coding",
      cwd: "/repo",
      permissionMode: "acceptEdits",
      appendParentSubagent: () => {},
      sessionExists: () => false,
      childRunner: {
        async runChild(config, _task, options) {
          childConfig = config;
          return { text: "done", sessionId: options.sessionId! };
        },
      },
    });

    await spawner.spawn({
      agentId: "child-empty",
      description: "empty",
      prompt: "inspect",
      maxTurns: 2,
      signal: new AbortController().signal,
      mcpAllowlist: [],
    });

    expect(childConfig?.mcpServers).toEqual({});
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

  it("feeds raw child events to progress reduction before UI filtering", async () => {
    const progressEvents: string[] = [];
    const uiEvents: string[] = [];
    const spawner = createSubAgentSpawner({
      parentConfig: parentConfig(),
      parentSandbox: parentConfig().sandbox!,
      presetName: "terminal-coding",
      cwd: "/repo",
      permissionMode: "acceptEdits",
      appendParentSubagent: () => {},
      sessionExists: () => false,
      parentStream: (event) => {
        uiEvents.push(event.type);
      },
      childRunner: {
        async runChild(_config, _task, options) {
          options.onStream?.({ type: "stream_request_start", turnNumber: 1 });
          options.onStream?.({ type: "usage_update", promptTokens: 42 });
          return {
            text: "done",
            sessionId: options.sessionId!,
            usage: { promptTokens: 42, completionTokens: 1, totalTokens: 43 },
          };
        },
      },
    });
    await spawner.spawn({
      agentId: "progress-child",
      description: "progress",
      prompt: "work",
      maxTurns: 2,
      signal: new AbortController().signal,
      onProgressEvent: (event) => {
        progressEvents.push(event.type);
      },
    });
    expect(progressEvents).toEqual(["stream_request_start", "usage_update"]);
    expect(uiEvents).toEqual(["stream_request_start"]);
  });

  it("always strips nested-agent tools from inherited and explicit scopes", () => {
    expect(resolveChildToolScope(["Read", "Agent"], undefined, undefined)).toEqual({
      enabled: ["Read"],
      disabled: ["Agent", "AgentStatus", "AgentCancel", "AgentSendInput"],
    });
  });
});

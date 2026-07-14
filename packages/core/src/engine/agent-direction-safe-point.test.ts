import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { notificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, Message } from "../types.js";
import { Engine } from "./engine.js";
import { createSubAgentSpawner } from "./subagent-spawner.js";
import type { LiveChildControl } from "../tool-system/builtin/agent-registry.js";
import { defaultSandboxConfig } from "../tool-system/sandbox/index.js";

const provider = "fake-agent-direction-safe-point";

let releaseFirst!: () => void;
let firstEntered!: () => void;
let firstEnteredPromise: Promise<void>;
let calls: Message[][];

class DirectionClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    calls.push(structuredClone(options.messages));
    if (calls.length === 1) {
      firstEntered();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return {
        text: "initial final",
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    }
    return {
      text: "redirected final",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}

registerProvider(provider, DirectionClient);

const interruptProvider = "fake-agent-direction-production-phase";
let interruptScenario: "model" | "tool";
let interruptCalls: Message[][];
let activeSignal: AbortSignal | undefined;
let enteredActivePhase!: () => void;
let enteredActivePhasePromise: Promise<void>;
let forceSettle!: () => void;

class InterruptPhaseClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    interruptCalls.push(structuredClone(options.messages));
    if (interruptCalls.length === 1 && interruptScenario === "model") {
      activeSignal = options.signal;
      enteredActivePhase();
      await new Promise<void>((resolve, reject) => {
        forceSettle = resolve;
        options.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("model aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
      return { text: "late", toolCalls: [], stopReason: "stop" };
    }
    if (interruptCalls.length === 1 && interruptScenario === "tool") {
      return {
        text: "use tool",
        toolCalls: [{ id: "blocking-1", toolName: "BlockingTool", args: {} }],
        stopReason: "tool_use",
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      };
    }
    return {
      text: "redirected final",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
    };
  }
}

registerProvider(interruptProvider, InterruptPhaseClient);

const progressProvider = "fake-agent-progress-production";
let approvalRequested!: () => void;
let approvalRequestedPromise: Promise<void>;
let resolveApproval!: (value: { approved: false; reason: string }) => void;
let progressModelCalls = 0;

class ProgressClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(): Promise<LLMResponse> {
    progressModelCalls++;
    if (progressModelCalls === 1) {
      return {
        text: "request approval",
        toolCalls: [{ id: "approval-1", toolName: "ApprovalTool", args: {} }],
        stopReason: "tool_use",
        usage: { promptTokens: 11, completionTokens: 4, totalTokens: 15 },
      };
    }
    return {
      text: "finished after denial",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 13, completionTokens: 6, totalTokens: 19 },
    };
  }
}

registerProvider(progressProvider, ProgressClient);

const deliveredProvider = "fake-agent-direction-delivered-ack";
let deliveredCalls = 0;
let releaseDeliveredModel!: () => void;
let deliveredModelEntered!: () => void;
let deliveredModelEnteredPromise: Promise<void>;

class DeliveredAckClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(): Promise<LLMResponse> {
    deliveredCalls++;
    if (deliveredCalls === 1) {
      deliveredModelEntered();
      await new Promise<void>((resolve) => {
        releaseDeliveredModel = resolve;
      });
    }
    return {
      text: `response ${deliveredCalls}`,
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
    };
  }
}

registerProvider(deliveredProvider, DeliveredAckClient);

describe("child Engine direction safe point", () => {
  afterEach(() => notificationQueue.reset());

  it("injects after the completed response, redrives the next model call, and persists agent provenance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-direction-"));
    const sessionId = "child-safe-point";
    calls = [];
    firstEnteredPromise = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    try {
      const engine = new Engine({
        llm: { provider, model: `${Date.now()}`, apiKey: "test" },
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        enabledBuiltinTools: [],
        maxTurns: 3,
        headless: true,
        permissionMode: "acceptEdits",
        settingsScope: "isolated",
        isSubAgent: true,
      });
      (engine as any).hooks.clear();

      const run = engine.run("original task", { sessionId, cwd: dir, runtimeGeneration: 1 });
      await firstEnteredPromise;
      const envelope = notificationQueue.enqueue({
        kind: "direction",
        from: { sessionId: "parent", authority: "agent" },
        to: { sessionId, agentId: "worker", authority: "agent" },
        delivery: "next-safe-point",
        runtimeGeneration: 1,
        payload: { prompt: "inspect the regression instead", origin: "agent_send_input" },
      })!;
      releaseFirst();

      const result = await run;
      expect(result.text).toBe("redirected final");
      expect(calls).toHaveLength(2);
      const second = JSON.stringify(calls[1]);
      expect(second).toContain("initial final");
      expect(second).toContain("inspect the regression instead");
      expect(notificationQueue.getSnapshot(sessionId)).toHaveLength(0);

      const transcript = readFileSync(join(dir, "sessions", sessionId, "transcript.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(transcript).toContainEqual(
        expect.objectContaining({
          type: "message",
          data: expect.objectContaining({
            role: "user",
            injected: true,
            authority: "agent",
            source: "agent-direction",
            envelopeIds: [envelope.id],
          }),
        }),
      );
    } finally {
      releaseFirst?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const phase of ["model", "tool"] as const) {
    it(`reports the real TurnLoop ${phase} phase and aborts interrupt-and-redrive`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `agent-direction-${phase}-`));
      interruptScenario = phase;
      interruptCalls = [];
      activeSignal = undefined;
      enteredActivePhasePromise = new Promise<void>((resolve) => {
        enteredActivePhase = resolve;
      });
      let control: LiveChildControl | undefined;
      let runtimeCreations = 0;
      const parent = {
        llm: { provider: interruptProvider, model: `${phase}-${Date.now()}`, apiKey: "test" },
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        enabledBuiltinTools: [],
        maxTurns: 3,
        headless: true,
        permissionMode: "bypassPermissions" as const,
        settingsScope: "isolated" as const,
        isSubAgent: false,
      };
      const spawner = createSubAgentSpawner({
        parentConfig: parent,
        parentSandbox: defaultSandboxConfig("off"),
        presetName: "general",
        cwd: dir,
        permissionMode: "bypassPermissions",
        appendParentSubagent: () => {},
        sessionExists: () => false,
        childRunner: {
          createChild(config) {
            runtimeCreations++;
            const engine = new Engine(config);
            (engine as any).hooks.clear();
            if (phase === "tool") {
              engine.registerCustomTool(
                {
                  name: "BlockingTool",
                  description: "blocks until aborted",
                  inputSchema: { type: "object", properties: {} },
                  source: "builtin",
                  permissionDefault: "allow",
                },
                async (args) => {
                  const signal = args.__signal as AbortSignal;
                  activeSignal = signal;
                  enteredActivePhase();
                  await new Promise<void>((resolve) => {
                    forceSettle = resolve;
                    signal.addEventListener("abort", () => resolve(), { once: true });
                  });
                  return "settled";
                },
              );
            }
            return engine;
          },
          async runChild() {
            throw new Error("legacy child runner used");
          },
        },
      });

      try {
        const run = spawner.spawn({
          agentId: `production-${phase}`,
          description: `${phase} interrupt`,
          prompt: "original",
          maxTurns: 3,
          signal: new AbortController().signal,
          runtimeGeneration: 9,
          bindLiveControl: (value) => {
            control = value;
            return true;
          },
        });
        await enteredActivePhasePromise;
        const fallback = setTimeout(() => forceSettle(), 100);
        const ack = await control!.routeDirection({
          kind: "direction",
          from: { sessionId: "parent", authority: "agent" },
          to: {
            sessionId: `production-${phase}`,
            agentId: `production-${phase}`,
            authority: "agent",
          },
          delivery: "interrupt-and-redrive",
          runtimeGeneration: 9,
          payload: { prompt: `redirect ${phase}`, origin: "agent_send_input" },
        });
        const result = await run;
        clearTimeout(fallback);

        expect(ack.status).toBe("interrupted");
        expect((activeSignal as AbortSignal | undefined)?.aborted).toBe(true);
        expect(result.text).toBe("redirected final");
        expect(runtimeCreations).toBe(1);
        expect(interruptCalls.length).toBeGreaterThanOrEqual(2);
        expect(JSON.stringify(interruptCalls.at(-1))).toContain(`redirect ${phase}`);
      } finally {
        forceSettle?.();
        notificationQueue.reset();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("reports real approval/finalizing phases and complete provider usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-progress-runtime-"));
    const events: import("./run-types.js").AgentRuntimeProgressEvent[] = [];
    progressModelCalls = 0;
    approvalRequestedPromise = new Promise<void>((resolve) => {
      approvalRequested = resolve;
    });
    try {
      const engine = new Engine({
        llm: { provider: progressProvider, model: `${Date.now()}`, apiKey: "test" },
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        enabledBuiltinTools: [],
        maxTurns: 3,
        headless: true,
        permissionMode: "default",
        approvalBackend: {
          requestApproval: () => {
            approvalRequested();
            return new Promise((resolve) => {
              resolveApproval = resolve;
            });
          },
        },
        settingsScope: "isolated",
        isSubAgent: true,
      });
      (engine as any).hooks.clear();
      engine.registerCustomTool(
        {
          name: "ApprovalTool",
          description: "requires real approval",
          inputSchema: { type: "object", properties: {} },
          source: "builtin",
          permissionDefault: "ask",
        },
        async () => "must not execute",
      );

      const run = engine.run("exercise progress", {
        sessionId: "progress-child",
        cwd: dir,
        runtimeGeneration: 1,
        onAgentProgress: (event) => events.push(event),
      });
      await approvalRequestedPromise;
      expect(events).toContainEqual({
        type: "phase",
        phase: "waiting-permission",
        toolName: "ApprovalTool",
      });
      resolveApproval({ approved: false, reason: "test denial" });
      await run;

      expect(events).toContainEqual({ type: "phase", phase: "finalizing" });
      const usage = events
        .filter(
          (event): event is Extract<(typeof events)[number], { type: "usage" }> =>
            event.type === "usage",
        )
        .reduce(
          (sum, event) => ({
            prompt: sum.prompt + (event.usage.promptTokens ?? 0),
            completion: sum.completion + (event.usage.completionTokens ?? 0),
          }),
          { prompt: 0, completion: 0 },
        );
      expect(usage).toEqual({ prompt: 24, completion: 10 });
    } finally {
      resolveApproval?.({ approved: false, reason: "cleanup" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns delivered only after the real TurnLoop merged and persisted that envelope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-direction-delivered-"));
    deliveredCalls = 0;
    deliveredModelEnteredPromise = new Promise<void>((resolve) => {
      deliveredModelEntered = resolve;
    });
    let control: LiveChildControl | undefined;
    let safePointEntered!: () => void;
    const safePointEnteredPromise = new Promise<void>((resolve) => {
      safePointEntered = resolve;
    });
    let releaseSafePoint!: () => void;
    const holdSafePoint = new Promise<void>((resolve) => {
      releaseSafePoint = resolve;
    });
    let hookCalls = 0;
    const parent = {
      llm: { provider: deliveredProvider, model: `${Date.now()}`, apiKey: "test" },
      cwd: dir,
      sessionStorageDir: join(dir, "sessions"),
      enabledBuiltinTools: [],
      maxTurns: 4,
      headless: true,
      permissionMode: "bypassPermissions" as const,
      settingsScope: "isolated" as const,
    };
    const spawner = createSubAgentSpawner({
      parentConfig: parent,
      parentSandbox: defaultSandboxConfig("off"),
      presetName: "general",
      cwd: dir,
      permissionMode: "bypassPermissions",
      appendParentSubagent: () => {},
      sessionExists: () => false,
      childRunner: {
        createChild(config) {
          const engine = new Engine(config);
          (engine as any).hooks.clear();
          (engine as any).hooks.register("agent_direction_submit", async () => {
            hookCalls++;
            if (hookCalls === 1) {
              safePointEntered();
              await holdSafePoint;
            }
            return {};
          });
          return engine;
        },
        async runChild() {
          throw new Error("legacy child runner used");
        },
      },
    });

    try {
      const run = spawner.spawn({
        agentId: "delivered-child",
        description: "delivery receipt",
        prompt: "original",
        maxTurns: 4,
        signal: new AbortController().signal,
        runtimeGeneration: 5,
        bindLiveControl: (value) => {
          control = value;
          return true;
        },
      });
      await deliveredModelEnteredPromise;
      const first = await control!.routeDirection({
        kind: "direction",
        from: { sessionId: "parent", authority: "agent" },
        to: { sessionId: "delivered-child", agentId: "delivered-child", authority: "agent" },
        delivery: "next-safe-point",
        runtimeGeneration: 5,
        payload: { prompt: "first correction", origin: "agent_send_input" },
      });
      expect(first.status).toBe("queued");
      releaseDeliveredModel();
      await safePointEnteredPromise;

      let receiptSettled = false;
      const secondReceipt = Promise.resolve(
        control!.routeDirection({
          kind: "direction",
          from: { sessionId: "parent", authority: "agent" },
          to: { sessionId: "delivered-child", agentId: "delivered-child", authority: "agent" },
          delivery: "next-safe-point",
          runtimeGeneration: 5,
          payload: { prompt: "second correction", origin: "agent_send_input" },
        }),
      ).then((ack) => {
        receiptSettled = true;
        return ack;
      });
      await Promise.resolve();
      expect(receiptSettled).toBe(false);

      releaseSafePoint();
      const second = await secondReceipt;
      expect(second.status).toBe("delivered");
      await run;

      const transcript = readFileSync(
        join(dir, "sessions", "delivered-child", "transcript.jsonl"),
        "utf8",
      );
      expect(transcript).toContain(second.status === "delivered" ? second.envelopeId : "missing");
      expect(transcript).toContain("second correction");
    } finally {
      releaseDeliveredModel?.();
      releaseSafePoint?.();
      notificationQueue.reset();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

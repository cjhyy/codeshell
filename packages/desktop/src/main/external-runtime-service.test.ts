/**
 * Desktop is the layer that resolves the security-relevant inputs, so these tests
 * are about the DECISIONS it makes, not about driving a real runtime.
 *
 * `startExternalRuntimeSession` is stubbed via module mocking, because the point
 * here is what Desktop passes down — not whether a Codex binary is installed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type StreamEvent, type ToolRegistry } from "@cjhyy/code-shell-core";
import { FIRST_PHASE_EXPOSURE } from "@cjhyy/code-shell-core/extension";
import { ExternalRuntimeApprovals } from "./external-runtime-approvals.js";
import { EXTERNAL_GOAL_TOOLS } from "./external-runtime-goals.js";
import type { ExternalRuntimeServiceDeps } from "./external-runtime-service.js";

type StartArgs = Record<string, unknown>;
const starts: StartArgs[] = [];
const closed: string[] = [];
/** When set, the next fake provider send rejects the way a dead process does. */
let failNextSend = false;
let providerSend:
  | ((args: StartArgs, input: { text: string; injected?: boolean }) => Promise<void>)
  | undefined;
let providerInterrupt: (() => Promise<void>) | undefined;
const providerInputs: Array<{ text: string; injected?: boolean }> = [];
const streamEvents: StreamEvent[] = [];
let previousHome: string | undefined;
let testHome: string;

/** A session stub that records what it was asked to do. */
function fakeSession(args: StartArgs) {
  return {
    kind: args.kind,
    businessSessionId: args.businessSessionId,
    runtimeSessionId: "runtime-1",
    listTools: () => {
      const exposure = args.exposure as { toolNames?: Set<string> } | undefined;
      // Mirror the real host: only allowlisted names are exposed.
      const names = exposure ? [...(exposure.toolNames ?? [])] : ["Panel"];
      return names.map((name) => ({ name, description: "", inputSchema: {} }));
    },
    send: async (input: { text: string; injected?: boolean }) => {
      providerInputs.push(input);
      if (failNextSend) {
        failNextSend = false;
        throw new Error("provider process exited");
      }
      await providerSend?.(args, input);
      return { done: Promise.resolve() };
    },
    interrupt: async () => {
      await providerInterrupt?.();
    },
    close: async () => {
      closed.push(String(args.businessSessionId));
    },
  };
}

// Keep unrelated exports intact for other desktop suites loaded in this process.
// Snapshot the namespace before mocking, because module export bindings are live.
const runtimeExports = {
  ...(await import("@cjhyy/code-shell-capability-coding/external-runtimes")),
};
mock.module("@cjhyy/code-shell-capability-coding/external-runtimes", () => ({
  ...runtimeExports,
  startExternalRuntimeSession: async (args: StartArgs) => {
    starts.push(args);
    return fakeSession(args);
  },
  textWithAttachmentReferences: (input: { text: string; attachments?: Array<{ path: string }> }) =>
    [input.text, ...(input.attachments ?? []).map((attachment) => attachment.path)].join("\n"),
}));
afterAll(() => {
  mock.module("@cjhyy/code-shell-capability-coding/external-runtimes", () => runtimeExports);
});

let trust: "trusted" | "untrusted" = "trusted";

const { ExternalRuntimeService } = await import("./external-runtime-service.js");

const claims: Array<{ sessionId: string; webContentsId?: number }> = [];
const released: string[] = [];
const emitted: Array<{ sessionId: string; type: string; eventSessionId?: string }> = [];
const stateChanges: Array<{
  sessionId: string;
  active: boolean;
  ownerWebContentsId?: number;
}> = [];

function service(
  flags: Record<string, boolean>,
  requestApproval?: ExternalRuntimeServiceDeps["requestApproval"],
  overrides: Record<string, unknown> = {},
) {
  return new ExternalRuntimeService({
    featureFlags: () => flags as never,
    registerSession: (sessionId, _cwd, webContentsId) => claims.push({ sessionId, webContentsId }),
    releaseSession: (sessionId) => released.push(sessionId),
    resolveProjectBinding: () => undefined,
    emit: (sessionId, event) => {
      emitted.push({
        sessionId,
        type: event.type,
        ...(event.type === "session_started" ? { eventSessionId: event.sessionId } : {}),
      });
      streamEvents.push(event);
    },
    sessionStateChanged: (sessionId, active, ownerWebContentsId) =>
      stateChanges.push({ sessionId, active, ownerWebContentsId }),
    projectTrust: () => trust,
    prepareCodexLaunch: async () => ({ command: "/test/bin/codex", env: { PATH: "/test/bin" } }),
    ...(requestApproval ? { requestApproval } : {}),
    ...overrides,
  });
}

const request = {
  kind: "codex" as const,
  sessionId: "sess-1",
  cwd: "/tmp/project",
  ownerWindow: { webContents: { id: 77 } } as never,
};

beforeEach(() => {
  previousHome = process.env.CODE_SHELL_HOME;
  testHome = mkdtempSync(join(tmpdir(), "codeshell-external-service-"));
  process.env.CODE_SHELL_HOME = testHome;
  starts.length = 0;
  closed.length = 0;
  claims.length = 0;
  released.length = 0;
  emitted.length = 0;
  stateChanges.length = 0;
  failNextSend = false;
  providerSend = undefined;
  providerInterrupt = undefined;
  providerInputs.length = 0;
  streamEvents.length = 0;
  trust = "trusted";
});
afterEach(() => {
  starts.length = 0;
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
});

describe("ExternalRuntimeService", () => {
  test("persists and continues a Goal on the same provider until an explicit host completion", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    providerSend = async (args) => {
      if (providerInputs.length !== 2) return;
      const goal = svc.getGoal(request.sessionId, 77);
      const result = await (args.registry as ToolRegistry).executeTool("complete_goal", {
        goalId: goal.goalId,
        revision: goal.revision,
        summary: "独立测试完成",
      });
      expect(JSON.parse(result.result!)).toMatchObject({ ok: true, status: "completed" });
    };
    await svc.send(request.sessionId, { text: "执行测试", goal: "完成目标" }, 77);
    expect(providerInputs).toHaveLength(2);
    expect(providerInputs[0]!.text).toContain("Goal: 完成目标");
    expect(providerInputs[1]!.injected).toBe(true);
    expect(starts).toHaveLength(1);
    expect(streamEvents.filter((event) => event.type === "turn_complete")).toHaveLength(1);
    expect(
      streamEvents.some((event) => event.type === "goal_progress" && event.status === "met"),
    ).toBe(true);
    expect(svc.getGoal(request.sessionId).goal).toBeNull();
    expect(new SessionManager().readSessionState(request.sessionId)?.goalLifecycle).toMatchObject({
      phase: "terminal",
      terminal: { reason: "completed" },
    });
    expect(() => svc.getGoal(request.sessionId, 99)).toThrow(/owned by another/);
  });

  test("turn bounds pause a recoverable Goal and disableGoal makes a single ordinary turn", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    await svc.send(request.sessionId, {
      text: "执行测试",
      goal: { objective: "未完成", maxTurns: 2 },
    });
    expect(providerInputs).toHaveLength(2);
    expect(svc.getGoal(request.sessionId)).toMatchObject({ goal: "未完成", paused: true });
    const identity = svc.getGoal(request.sessionId);
    await svc.send(request.sessionId, { text: "独立问题", disableGoal: true });
    expect(providerInputs).toHaveLength(3);
    expect(providerInputs[2]!.text).toBe("独立问题");
    expect(svc.getGoal(request.sessionId)).toEqual(identity);
    await svc.stop(request.sessionId);
    expect(svc.getGoal(request.sessionId)).toEqual(identity);
    expect(
      svc.deleteGoal(request.sessionId, {
        expectedGoalId: identity.goalId,
        expectedRevision: identity.revision,
      }).cleared,
    ).toBe(true);
  });

  test("editing a live Goal cancels its prompt and resumes the same runtime with a new revision", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    let completed!: () => void;
    const first = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const completion = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const cancelled: string[] = [];
    const svc = service({ external_agent_runtime: true, external_host_tools: true }, undefined, {
      cancelApprovals: (sessionId: string) => {
        cancelled.push(sessionId);
      },
    });
    await svc.start(request);
    let oldGoal: ReturnType<typeof svc.getGoal>;
    providerInterrupt = async () => {
      releaseFirst();
    };
    providerSend = async (args, input) => {
      if (providerInputs.length === 1) {
        oldGoal = svc.getGoal(request.sessionId);
        firstStarted();
        await blocked;
        return;
      }
      expect(input.text).toContain("修订目标");
      const registry = args.registry as ToolRegistry;
      const stale = await registry.executeTool("complete_goal", {
        goalId: oldGoal.goalId,
        revision: oldGoal.revision,
      });
      expect(JSON.parse(stale.result!).ok).toBe(false);
      const current = svc.getGoal(request.sessionId);
      const success = await registry.executeTool("complete_goal", {
        goalId: current.goalId,
        revision: current.revision,
      });
      expect(JSON.parse(success.result!).ok).toBe(true);
      completed();
    };
    const running = svc.send(request.sessionId, { text: "执行", goal: "原目标" });
    await first;
    const previous = svc.getGoal(request.sessionId);
    const updated = await svc.updateGoal(
      request.sessionId,
      {
        objective: "修订目标",
        expectedGoalId: previous.goalId!,
        expectedRevision: previous.revision!,
      },
      77,
    );
    expect(updated).toMatchObject({ updated: true, revision: 2, goal: "修订目标" });
    await completion;
    await running;
    expect(cancelled).toContain(request.sessionId);
    expect(starts).toHaveLength(1);
    expect(providerInputs).toHaveLength(2);
    await svc.stop(request.sessionId);
  });

  test("pause clears pending questions, stops continuation and keeps the Goal visible", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancelled: string[] = [];
    const svc = service({ external_agent_runtime: true, external_host_tools: true }, undefined, {
      cancelApprovals: (sessionId: string) => {
        cancelled.push(sessionId);
        release();
      },
    });
    await svc.start(request);
    providerSend = async () => {
      started();
      await blocked;
    };
    const running = svc.send(request.sessionId, { text: "执行", goal: "等待中的目标" });
    await entered;
    const goal = svc.getGoal(request.sessionId);
    await svc.updateGoal(request.sessionId, {
      paused: true,
      expectedGoalId: goal.goalId!,
      expectedRevision: goal.revision!,
    });
    await running;
    expect(cancelled).toEqual([request.sessionId]);
    expect(providerInputs).toHaveLength(1);
    expect(svc.getGoal(request.sessionId)).toMatchObject({ goal: "等待中的目标", paused: true });
    expect(
      streamEvents.some((event) => event.type === "goal_progress" && event.status === "met"),
    ).toBe(false);
  });

  test("interrupt failure pauses the edited revision and requires rebuilding the provider", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    providerSend = async () => {
      started();
      await blocked;
    };
    providerInterrupt = async () => {
      throw new Error("provider unreachable");
    };
    const running = svc.send(request.sessionId, { text: "执行", goal: "原目标" });
    await entered;
    const goal = svc.getGoal(request.sessionId);
    await expect(
      svc.updateGoal(request.sessionId, {
        objective: "新目标",
        expectedGoalId: goal.goalId!,
        expectedRevision: goal.revision!,
      }),
    ).rejects.toThrow(/remains paused/);
    expect(svc.getGoal(request.sessionId)).toMatchObject({
      goal: "新目标",
      paused: true,
      revision: 3,
    });
    expect(svc.canResumeGoal(request.sessionId)).toBe(false);
    release();
    await running;
    expect(providerInputs).toHaveLength(1);
  });

  test("a failed provider preserves its Goal and a host-tool flag change rebuilds the runtime", async () => {
    const flags = { external_agent_runtime: true, external_host_tools: false };
    const svc = service(flags);
    await svc.start(request);
    expect(svc.canResumeGoal(request.sessionId)).toBe(false);
    flags.external_host_tools = true;
    await svc.ensure(request);
    expect(starts).toHaveLength(2);
    expect(svc.canResumeGoal(request.sessionId, 77)).toBe(true);
    failNextSend = true;
    await svc.send(request.sessionId, { text: "执行", goal: "保留失败目标" });
    expect(svc.getGoal(request.sessionId).goal).toBe("保留失败目标");
    expect(svc.canResumeGoal(request.sessionId)).toBe(false);
    expect(
      streamEvents.some((event) => event.type === "goal_progress" && event.status === "met"),
    ).toBe(false);
  });

  test("the wall-clock budget interrupts a waiting provider and pauses without declaring success", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const svc = service({ external_agent_runtime: true, external_host_tools: true }, undefined, {
      cancelApprovals: () => {
        order.push("cancel approvals");
        release();
      },
    });
    await svc.start(request);
    providerSend = async () => {
      await blocked;
    };
    providerInterrupt = async () => {
      order.push("interrupt provider");
    };
    await svc.send(request.sessionId, {
      text: "执行",
      goal: { objective: "时间预算测试", timeBudgetMs: 5 },
    });
    expect(providerInputs).toHaveLength(1);
    expect(svc.getGoal(request.sessionId)).toMatchObject({ goal: "时间预算测试", paused: true });
    expect(order).toEqual(["cancel approvals", "interrupt provider"]);
  });

  test("provider token updates cancel pending approvals before interrupting an exhausted Goal", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const svc = service({ external_agent_runtime: true, external_host_tools: true }, undefined, {
      cancelApprovals: () => {
        order.push("cancel approvals");
        release();
      },
    });
    await svc.start(request);
    providerInterrupt = async () => {
      order.push("interrupt provider");
    };
    providerSend = async (args) => {
      const hooks = args.hooks as { onEvent: (event: StreamEvent) => void };
      hooks.onEvent({ type: "usage_update", promptTokens: 8, completionTokens: 2 });
      await blocked;
    };
    await svc.send(request.sessionId, {
      text: "执行",
      goal: { objective: "额度测试", tokenBudget: 10 },
    });
    expect(order).toEqual(["cancel approvals", "interrupt provider"]);
    expect(svc.getGoal(request.sessionId)).toMatchObject({ goal: "额度测试", paused: true });
    expect(providerInputs).toHaveLength(1);
  });

  test.each([false, true])(
    "consumes background results within the Goal run, with Stop=%s",
    async (stop) => {
      let listener: ((sessionId: string, event: StreamEvent) => void) | undefined;
      let pending: string | undefined;
      let release!: () => void;
      let entered!: () => void;
      let completed!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const firstStarted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const finished = new Promise<void>((resolve) => {
        completed = resolve;
      });
      const svc = service({ external_agent_runtime: true, external_host_tools: true }, undefined, {
        backgroundWork: {
          subscribe: (next: typeof listener) => {
            listener = next;
            return () => {
              listener = undefined;
            };
          },
          drainMessage: () => {
            const result = pending;
            pending = undefined;
            return result;
          },
          hasPending: () => pending !== undefined,
          dropSession: () => {
            pending = undefined;
          },
        },
      });
      await svc.start(request);
      const publish = () => {
        pending = "后台检查已完成：全部通过。";
        listener?.(request.sessionId, {
          type: "background_agent_completed",
          agentId: "test-child",
          description: "后台检查",
          status: "completed",
          enqueuedAt: Date.now(),
        });
      };
      providerInterrupt = async () => {
        release();
      };
      providerSend = async (args, input) => {
        if (providerInputs.length === 1) {
          entered();
          if (stop) await blocked;
          else publish();
          return;
        }
        expect(input.text).toContain("后台检查已完成：全部通过。");
        const goal = svc.getGoal(request.sessionId);
        await (args.registry as ToolRegistry).executeTool("complete_goal", {
          goalId: goal.goalId,
          revision: goal.revision,
        });
        completed();
      };
      const running = svc.send(request.sessionId, { text: "执行", goal: "收集后台检查结果" });
      await firstStarted;
      if (stop) {
        await svc.interrupt(request.sessionId, 77);
        await running;
        publish();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(providerInputs).toHaveLength(1);
        expect(pending).toBeDefined();
        const goal = svc.getGoal(request.sessionId);
        expect(goal.paused).toBe(true);
        await svc.updateGoal(
          request.sessionId,
          {
            paused: false,
            expectedGoalId: goal.goalId!,
            expectedRevision: goal.revision!,
          },
          77,
        );
      }
      await finished;
      await running;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(providerInputs).toHaveLength(2);
      expect(pending).toBeUndefined();
      expect(starts).toHaveLength(1);
      expect(svc.getGoal(request.sessionId).goal).toBeNull();
      await svc.stopAll();
    },
  );

  test("passes the preflight executable and environment to the actual runtime", async () => {
    const launch = { command: "/custom/version/bin/codex", env: { PATH: "/custom/version/bin" } };
    const cwdChecks: string[] = [];
    const svc = service({ external_agent_runtime: true }, undefined, {
      prepareCodexLaunch: async (cwd: string) => {
        cwdChecks.push(cwd);
        return launch;
      },
    });
    await svc.ensure(request);
    await svc.ensure(request);
    expect(cwdChecks).toEqual([request.cwd]);
    expect(starts).toHaveLength(1);
    expect(starts[0]!.codexClient).toEqual(launch);
  });

  test("failed preflight never reserves a host session or starts a runtime", async () => {
    const svc = service({ external_agent_runtime: true }, undefined, {
      prepareCodexLaunch: async () => {
        throw new Error("Codex CLI was not found");
      },
    });
    await expect(svc.start(request)).rejects.toThrow(/Codex CLI was not found/);
    expect(claims).toEqual([]);
    expect(starts).toEqual([]);
    expect(released).toEqual([]);
  });

  test("failed replacement preflight preserves the existing live runtime", async () => {
    let fail = false;
    const svc = service({ external_agent_runtime: true }, undefined, {
      prepareCodexLaunch: async () => {
        if (fail) throw new Error("Codex CLI was not found");
        return { command: "/test/bin/codex", env: {} };
      },
    });
    const original = await svc.start(request);
    fail = true;
    await expect(svc.start({ ...request, model: "replacement" })).rejects.toThrow(/not found/);
    expect(svc.get(request.sessionId)).toBe(original);
    expect(closed).toEqual([]);
    expect(released).toEqual([]);
    expect(starts).toHaveLength(1);
  });

  test.each(["owner closes", "feature is disabled"])(
    "does not replace a runtime when its %s during preflight",
    async (change) => {
      const flags = { external_agent_runtime: true };
      let ownerClosed = false;
      const ownerWindow = {
        webContents: { id: 77 },
        isDestroyed: () => ownerClosed,
      } as never;
      let blockPreflight = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const preflightEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const svc = service(flags, undefined, {
        prepareCodexLaunch: async () => {
          if (blockPreflight) {
            entered();
            await gate;
          }
          return { command: "/test/bin/codex", env: {} };
        },
      });
      const original = await svc.start({ ...request, ownerWindow });
      blockPreflight = true;
      const replacement = svc.start({ ...request, ownerWindow, model: "replacement" });
      await preflightEntered;
      if (change === "owner closes") ownerClosed = true;
      else flags.external_agent_runtime = false;
      release();

      await expect(replacement).rejects.toThrow(
        change === "owner closes" ? /owner window closed/ : /disabled/,
      );
      expect(svc.get(request.sessionId)).toBe(original);
      expect(closed).toEqual([]);
      expect(released).toEqual([]);
      expect(starts).toHaveLength(1);
      expect(claims).toHaveLength(1);
    },
  );

  test("refuses to start when the runtime flag is off", async () => {
    // Falling back to the native engine silently would leave a caller debugging
    // the wrong backend.
    const svc = service({ external_agent_runtime: false });
    expect(svc.isEnabled()).toBe(false);
    await expect(svc.start(request)).rejects.toThrow(/disabled|feature flag/i);
    expect(starts).toEqual([]);
  });

  test("exposes NO tools when only the runtime flag is on", async () => {
    // §20 wants the runtime trialable with no tool surface at all: the tool bridge
    // is the part that carries the security burden, so it gets its own flag.
    const svc = service({ external_agent_runtime: true, external_host_tools: false });
    const session = await svc.start(request);
    expect(svc.areHostToolsEnabled()).toBe(false);
    const exposure = starts[0]!.exposure as { toolNames: Set<string> };
    expect([...exposure.toolNames]).toEqual([]);
    expect(session.listTools()).toEqual([]);
  });

  test("uses the reviewed allowlist when host tools are enabled", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const exposure = starts[0]!.exposure as { toolNames: Set<string>; argsPatterns: unknown };
    expect([...exposure.toolNames]).toEqual([
      ...FIRST_PHASE_EXPOSURE.toolNames,
      ...EXTERNAL_GOAL_TOOLS,
    ]);
    expect(exposure.argsPatterns).toBe(FIRST_PHASE_EXPOSURE.argsPatterns);
    const registry = starts[0]!.registry as {
      getToolDefinitions(): Array<{ name: string }>;
    };
    expect(registry.getToolDefinitions().map((tool) => tool.name)).toContain("DriveAgent");
    expect(registry.getToolDefinitions().map((tool) => tool.name)).toContain("DriveAgentJobs");
    expect(starts[0]!.developerInstructions).toContain('DriveAgent with cli="codex"');
    expect(starts[0]!.developerInstructions).toContain('permissionMode="acceptEdits"');
  });

  test("dontAsk disables approval prompts but preserves user questions", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true }, async () => ({
      approved: true,
      answer: "answer",
    }));
    await svc.start({ ...request, permissionMode: "dontAsk" });
    expect(starts[0]!.approvalPolicy).toBe("never");
    expect(starts[0]!.approvalBackend).toBeUndefined();
    const hooks = starts[0]!.hooks as Record<string, unknown>;
    expect(hooks.onNativeApproval).toBeUndefined();
    expect(hooks.onUserInput).toBeFunction();
  });

  test.each(["host free text", "host choices", "Codex input"])(
    "delivers %s through the approval bridge with renderer-readable question fields",
    async (source) => {
      const sent: Array<{
        channel: string;
        payload: {
          sessionId: string;
          requestId: string;
          request: Record<string, unknown>;
        };
      }> = [];
      const approvals = new ExternalRuntimeApprovals({
        windows: () =>
          [
            {
              isDestroyed: () => false,
              webContents: {
                id: 77,
                send: (channel: string, payload: (typeof sent)[number]["payload"]) =>
                  sent.push({ channel, payload }),
              },
            },
          ] as never,
        ownerWebContentsId: () => 77,
      });
      const svc = service(
        { external_agent_runtime: true, external_host_tools: true },
        (sessionId, questionRequest) => approvals.request(sessionId, questionRequest),
      );
      await svc.start(request);
      const question = "如果你已持有 501058，发我成本净值或目前亏损比例即可。";
      const choices = [
        { label: "按成本测算", description: "提供持仓成本" },
        { label: "按最新净值测算", description: "使用公开净值" },
      ];
      const options =
        source === "host free text"
          ? undefined
          : {
              header: "测算依据",
              options: choices,
              ...(source === "host choices" ? { multiSelect: true, optionsOnly: true } : {}),
            };
      let pending: Promise<unknown>;
      if (source === "Codex input") {
        const hooks = starts[0]!.hooks as {
          onUserInput: (input: { method: string; params: unknown }) => Promise<unknown>;
        };
        pending = hooks.onUserInput({
          method: "item/tool/requestUserInput",
          params: { questions: [{ id: "cost_basis", question, ...options }] },
        });
      } else {
        const context = starts[0]!.contextOverrides as {
          askUser: (question: string, options?: Record<string, unknown>) => Promise<string>;
        };
        pending = context.askUser(question, options);
      }

      expect(sent).toHaveLength(1);
      expect(sent[0]!.channel).toBe("externalRuntime:approvalRequest");
      expect(sent[0]!.payload.sessionId).toBe(request.sessionId);
      expect(sent[0]!.payload.request).toEqual({
        toolName: "__ask_user__",
        args: { ...options, question },
        description: question,
        riskLevel: "low",
      });
      expect(
        approvals.settle(sent[0]!.payload.requestId, { approved: true, answer: "1.25" }, 77),
      ).toBe(true);
      await expect(pending).resolves.toEqual(
        source === "Codex input" ? { answers: { cost_basis: { answers: ["1.25"] } } } : "1.25",
      );
      expect(approvals.pendingCount).toBe(0);
    },
  );

  test("resolves projectTrusted from the trust store, not a default", async () => {
    // `permissions` is the first DANGEROUS_PROJECT_FIELD: an untrusted project's
    // rules must be stripped, and only Desktop knows the answer.
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    expect(starts[0]!.projectTrusted).toBe(true);

    trust = "untrusted";
    await svc.start({ ...request, sessionId: "sess-2" });
    expect(starts[1]!.projectTrusted).toBe(false);
  });

  test("persists the stable project binding resolved by Desktop main", async () => {
    const sessionId = "external-service-project-binding";
    const project = { projectId: "project-1", mainRootId: "root-1" };
    const svc = service({ external_agent_runtime: true, external_host_tools: true }, undefined, {
      resolveProjectBinding: () => project,
    });

    await svc.start({ ...request, sessionId });

    expect(new SessionManager().readSessionState(sessionId)?.project).toEqual(project);
  });

  test("claims the panel owner BEFORE starting the runtime", async () => {
    // A Panel tool call on the very first turn would otherwise find no owning
    // window and fail closed (§9.3.2).
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    expect(claims).toEqual([{ sessionId: "sess-1", webContentsId: 77 }]);
  });

  test("fallible preparation happens before the host session is registered", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true }, undefined, {
      toolContextOverrides: () => {
        throw new Error("context setup failed");
      },
    });

    await expect(svc.start(request)).rejects.toThrow(/context setup failed/);
    expect(claims).toEqual([]);
    expect(starts).toEqual([]);
  });

  test("binding sidecar failures do not orphan or fail a live runtime", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true }, undefined, {
      writeBinding: () => {
        throw new Error("sidecar disk full");
      },
    });

    await expect(svc.start(request)).resolves.toBeDefined();
    await expect(svc.send("sess-1", "still runs")).resolves.toMatchObject({ ok: true });
    expect(svc.get("sess-1")).toBeDefined();
    await svc.stop("sess-1");
  });

  test("closes a runtime whose owner window disappeared during startup", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    const ownerWindow = {
      webContents: { id: 77 },
      isDestroyed: () => starts.length > 0,
    } as never;

    await expect(svc.start({ ...request, ownerWindow })).rejects.toThrow(/owner window closed/i);
    expect(closed).toEqual(["sess-1"]);
    expect(released).toEqual(["sess-1"]);
    expect(svc.get("sess-1")).toBeUndefined();
  });

  test("starts without an owner window, leaving invoke to fail closed", async () => {
    // Headless/mobile sessions have no renderer. That must not block the runtime —
    // only Panel.invoke is unavailable, which the bridge reports on its own.
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start({ ...request, ownerWindow: undefined });
    // Still registered (the session and its bucket must exist), just with no
    // owner — that is what makes Panel.invoke fail closed rather than broadcast.
    expect(claims).toEqual([{ sessionId: "sess-1", webContentsId: undefined }]);
    expect(starts).toHaveLength(1);
  });

  test("restarting the same session closes the previous one first", async () => {
    // Two runtimes writing one business session would interleave turns.
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    await svc.start(request);
    expect(closed).toEqual(["sess-1"]);
    expect(starts).toHaveLength(2);
  });

  test("ensure reuses a matching runtime instead of restarting it", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    expect(svc.isCompatible(request)).toBe(false);
    const first = await svc.ensure(request);
    expect(svc.isCompatible(request)).toBe(true);
    expect(svc.isCompatible({ ...request, planMode: true })).toBe(false);
    expect(svc.isCompatible({ ...request, developerInstructions: "new renderer context" })).toBe(
      true,
    );
    const second = await svc.ensure(request);

    expect(second).toBe(first);
    expect(starts).toHaveLength(1);
    expect(closed).toEqual([]);
  });

  test("ensure replaces a runtime whose last turn failed on the provider", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.ensure(request);
    failNextSend = true;
    await expect(svc.send("sess-1", "first")).resolves.toMatchObject({
      ok: false,
      reason: "model_error",
    });

    // The renderer drops its binding on that failure and starts again. Handing
    // back the dead provider would fail every later turn the same way.
    expect(svc.isCompatible(request)).toBe(false);
    await svc.ensure(request);
    expect(starts).toHaveLength(2);
    expect(closed).toEqual(["sess-1"]);
    await expect(svc.send("sess-1", "second")).resolves.toMatchObject({ ok: true });
  });

  test("a main-originated turn announces its user message to the renderer", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.ensure(request);
    await svc.send("sess-1", {
      text: "full task",
      displayText: "【App】 short",
      clientMessageId: "c1",
    });
    // The chat renderer appends its own bubble before sending: no echo for it.
    await svc.send("sess-1", { text: "renderer turn", clientMessageId: "c2" });

    expect(emitted.filter((event) => event.type === "session_user_message")).toHaveLength(1);
  });

  test("serializes concurrent ensure calls into one runtime start", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    const [first, second] = await Promise.all([svc.ensure(request), svc.ensure(request)]);

    expect(second).toBe(first);
    expect(starts).toHaveLength(1);
    expect(closed).toEqual([]);
  });

  test("ensure replaces a runtime when an execution setting changes", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.ensure(request);
    await svc.ensure({ ...request, permissionMode: "acceptEdits" });

    expect(starts).toHaveLength(2);
    expect(closed).toEqual(["sess-1"]);
  });

  test("notifies the owning renderer when a main-started runtime starts and stops", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.ensure(request);
    await svc.stop("sess-1");

    expect(stateChanges).toEqual([
      { sessionId: "sess-1", active: true, ownerWebContentsId: 77 },
      { sessionId: "sess-1", active: false, ownerWebContentsId: 77 },
    ]);
  });

  test("serializes concurrent starts for the same business session", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await Promise.all([svc.start(request), svc.start(request)]);

    expect(starts).toHaveLength(2);
    expect(closed).toEqual(["sess-1"]);
    expect(released).toEqual(["sess-1"]);
  });

  test("another renderer window cannot replace or control an owned session", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const otherWindow = { webContents: { id: 88 } } as never;

    await expect(svc.start({ ...request, ownerWindow: otherWindow })).rejects.toThrow(
      /owned by another window/i,
    );
    await expect(svc.send("sess-1", "hijack", 88)).rejects.toThrow(/owned by another window/i);
    await expect(svc.interrupt("sess-1", 88)).rejects.toThrow(/owned by another window/i);
    await expect(svc.stop("sess-1", 88)).rejects.toThrow(/owned by another window/i);
    expect(svc.get("sess-1")).toBeDefined();
    expect(closed).toEqual([]);
  });

  test("rechecks stop ownership after an in-flight start becomes visible", async () => {
    let queuedStop: Promise<void> | undefined;
    let svc!: ExternalRuntimeService;
    svc = service({ external_agent_runtime: true, external_host_tools: true }, undefined, {
      registerSession: () => {
        // Registration happens before the awaited provider start and before the
        // live entry is published. This is the exact gap where the old call-time
        // check saw no owner and allowed another window's stop into the queue.
        queuedStop = svc.stop("sess-1", 88);
      },
    });

    await svc.start(request);
    expect(queuedStop).toBeDefined();
    await expect(queuedStop!).rejects.toThrow(/owned by another window/i);
    expect(svc.get("sess-1")).toBeDefined();
    expect(closed).toEqual([]);
  });

  test("the owning renderer and trusted main-process callers keep control", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);

    await expect(svc.send("sess-1", "owner", 77)).resolves.toMatchObject({ ok: true });
    await expect(svc.interrupt("sess-1", 77)).resolves.toBeUndefined();
    await expect(svc.stop("sess-1")).resolves.toBeUndefined();
  });

  test("a renderer cannot claim an existing ownerless main-process session", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start({ ...request, ownerWindow: undefined });

    await expect(svc.send("sess-1", "hijack", 77)).rejects.toThrow(/owned by another window/i);
    await expect(svc.stop("sess-1", 77)).rejects.toThrow(/owned by another window/i);
    expect(svc.get("sess-1")).toBeDefined();
  });

  test("forwards translated events tagged with the session id", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const hooks = starts[0]!.hooks as { onEvent: (event: { type: string }) => void };
    hooks.onEvent({ type: "text_delta" });
    expect(emitted).toEqual([{ sessionId: "sess-1", type: "text_delta" }]);
  });

  test("normalizes a provider session_started id to the CodeShell business id", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const hooks = starts[0]!.hooks as {
      onEvent: (event: {
        type: "session_started";
        sessionId: string;
        promptTokens: number;
      }) => void;
    };
    hooks.onEvent({ type: "session_started", sessionId: "provider-thread-id", promptTokens: 0 });
    expect(emitted).toEqual([
      { sessionId: "sess-1", type: "session_started", eventSessionId: "sess-1" },
    ]);
  });

  test("drops late events from a runtime after the business session is restarted", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const oldHooks = starts[0]!.hooks as { onEvent: (event: { type: string }) => void };

    await svc.start(request);
    const currentHooks = starts[1]!.hooks as { onEvent: (event: { type: string }) => void };
    emitted.length = 0;
    oldHooks.onEvent({ type: "text_delta" });
    currentHooks.onEvent({ type: "text_delta" });

    expect(emitted).toEqual([{ sessionId: "sess-1", type: "text_delta" }]);
  });

  test("drops provider events emitted while a stopped runtime is closing", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const hooks = starts[0]!.hooks as { onEvent: (event: { type: string }) => void };
    const runtime = svc.get("sess-1") as unknown as { close: () => Promise<void> };
    runtime.close = async () => hooks.onEvent({ type: "text_delta" });

    emitted.length = 0;
    await svc.stop("sess-1");

    expect(emitted).toEqual([]);
  });

  test("records an aborted terminal event when an active turn is stopped", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const runtime = svc.get("sess-1") as unknown as {
      send: () => Promise<{ done: Promise<void> }>;
    };
    let finishTurn!: () => void;
    const done = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    runtime.send = async () => ({ done });

    const sending = svc.send("sess-1", "running");
    await Promise.resolve();
    await svc.stop("sess-1");
    finishTurn();

    await expect(sending).resolves.toMatchObject({
      ok: false,
      reason: "aborted_streaming",
      streamed: true,
    });
    expect(emitted).toEqual([{ sessionId: "sess-1", type: "turn_complete" }]);
  });

  test("serializes overlapping sends before resetting the shared turn recorder", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const runtime = svc.get("sess-1") as unknown as {
      send: (input: { text: string }) => Promise<{ done: Promise<void> }>;
    };
    const sent: string[] = [];
    let finishFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    runtime.send = async (input) => {
      sent.push(input.text);
      return { done: input.text === "first" ? firstDone : Promise.resolve() };
    };

    const first = svc.send("sess-1", "first");
    await Promise.resolve();
    const second = svc.send("sess-1", "second");
    await Promise.resolve();
    expect(sent).toEqual(["first"]);

    finishFirst();
    await Promise.all([first, second]);
    expect(sent).toEqual(["first", "second"]);
  });

  test("waits for the launching turn before injecting a background completion", async () => {
    let listener:
      | ((
          sessionId: string,
          event: {
            type: "background_agent_completed";
            agentId: string;
            description: string;
            status: "completed";
            enqueuedAt: number;
          },
        ) => void)
      | undefined;
    const pending = new Map<string, string>();
    const dropped: string[] = [];
    const svc = service({ external_agent_runtime: true, external_host_tools: true }, undefined, {
      backgroundWork: {
        subscribe: (next: typeof listener) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        drainMessage: (sessionId: string) => {
          const message = pending.get(sessionId);
          pending.delete(sessionId);
          return message;
        },
        hasPending: (sessionId: string) => pending.has(sessionId),
        dropSession: (sessionId: string) => {
          dropped.push(sessionId);
          pending.delete(sessionId);
        },
      },
    });
    await svc.start(request);
    expect(
      (starts[0]!.contextOverrides as { externalRuntimeBackgroundDelivery?: boolean })
        .externalRuntimeBackgroundDelivery,
    ).toBe(true);

    const runtime = svc.get("sess-1") as unknown as {
      send: (input: { text: string; injected?: boolean }) => Promise<{ done: Promise<void> }>;
    };
    const sent: Array<{ text: string; injected?: boolean }> = [];
    let finishFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    runtime.send = async (input) => {
      sent.push(input);
      return { done: input.text === "launch background review" ? firstDone : Promise.resolve() };
    };

    const launching = svc.send("sess-1", "launch background review");
    await Promise.resolve();
    pending.set("sess-1", '<agent-result job-id="cc-1">review complete</agent-result>');
    listener?.("sess-1", {
      type: "background_agent_completed",
      agentId: "cc-1",
      description: "review complete",
      status: "completed",
      enqueuedAt: Date.now(),
    });
    await Promise.resolve();

    expect(sent).toEqual([{ text: "launch background review" }]);
    expect(emitted).toContainEqual({
      sessionId: "sess-1",
      type: "background_agent_completed",
    });

    finishFirst();
    await launching;
    for (let index = 0; index < 10 && sent.length < 2; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      injected: true,
    });
    expect(sent[1]!.text).toContain("<system-reminder>");
    expect(sent[1]!.text).toContain("review complete");

    await svc.stopAll();
    expect(dropped).toContain("sess-1");
    expect(listener).toBeUndefined();
  });

  test("a provider turn with no terminal callback is completed only once", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);

    emitted.length = 0;
    const outcome = await svc.send("sess-1", "completed without callback");
    expect(emitted).toEqual([{ sessionId: "sess-1", type: "turn_complete" }]);
    emitted.length = 0;
    await svc.stop("sess-1");

    expect(outcome).toMatchObject({ ok: true, reason: "completed", streamed: true });
    expect(emitted).toEqual([]);
  });

  test("send() on an unknown session is an error, not a silent no-op", async () => {
    const svc = service({ external_agent_runtime: true });
    await expect(svc.send("nope", "hi")).rejects.toThrow(/no external runtime session/i);
  });

  test("stopAll closes every session", async () => {
    // Each session holds a child process and a listening port; neither dies with
    // the parent on Windows.
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    await svc.start({ ...request, sessionId: "sess-b" });
    await svc.stopAll();
    expect(closed.sort()).toEqual(["sess-b", "sess-1"].sort());
    expect(svc.get("sess-1")).toBeUndefined();
  });

  test("closing one owner window reaps only that window's runtimes", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    await svc.start({
      ...request,
      sessionId: "sess-b",
      ownerWindow: { webContents: { id: 88 } } as never,
    });

    await svc.stopOwnedBy(77);

    expect(svc.get("sess-1")).toBeUndefined();
    expect(svc.get("sess-b")).toBeDefined();
    expect(closed).toEqual(["sess-1"]);
  });

  test("stop() on an unknown session is a no-op", async () => {
    const svc = service({ external_agent_runtime: true });
    await expect(svc.stop("ghost")).resolves.toBeUndefined();
  });

  test("stopping releases the host registries", async () => {
    // registerSession touches several registries that different modules own.
    // If release is ever dropped, the browser bucket and the reserved session
    // survive for the life of the process, and a later session reusing the id
    // silently inherits them.
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    await svc.stop("sess-1");
    expect(released).toEqual(["sess-1"]);
  });

  test("a close() that throws still releases", async () => {
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    const session = svc.get("sess-1") as unknown as { close: () => Promise<void> };
    session.close = () => Promise.reject(new Error("runtime died badly"));
    await expect(svc.stop("sess-1")).rejects.toThrow(/died badly/);
    // The throw propagates (callers should see it), but the leak does not.
    expect(released).toEqual(["sess-1"]);
    expect(svc.get("sess-1")).toBeUndefined();
  });

  test("a release failure still cancels approvals and removes the live session", async () => {
    let cancelled = 0;
    const svc = service({ external_agent_runtime: true, external_host_tools: true }, undefined, {
      releaseSession: () => {
        throw new Error("release failed");
      },
      cancelApprovals: () => {
        cancelled += 1;
      },
    });
    await svc.start(request);

    await expect(svc.stop("sess-1")).rejects.toThrow(/release failed/);
    expect(cancelled).toBe(1);
    expect(closed).toEqual(["sess-1"]);
    expect(svc.get("sess-1")).toBeUndefined();
  });

  test("restarting the same session releases before re-registering", async () => {
    // start() closes any previous session for the id; that path must release
    // too, or a restart leaves a stale owner claim pointing at an old window.
    const svc = service({ external_agent_runtime: true, external_host_tools: true });
    await svc.start(request);
    await svc.start(request);
    expect(released).toEqual(["sess-1"]);
    expect(claims).toHaveLength(2);
  });
});

import { describe, expect, test } from "bun:test";
import type { PetLongTask, PetFollowUpWake } from "@cjhyy/code-shell-pet";
import {
  PetDispatchService,
  type PetDispatchOptions,
  type PetDispatchCommand,
} from "./pet-dispatch-service";

type RunResponse = Awaited<ReturnType<PetDispatchOptions["worker"]["requestWorker"]>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const source = {
  kind: "im-gateway" as const,
  channel: "wechat",
  target: "owner-chat",
  senderId: "owner",
  capabilities: {
    inbound: { text: true as const, attachments: [] },
    outbound: { text: true as const, button: "link" as const, attachments: [] },
  },
};

const attachment = {
  id: "photo-one",
  kind: "image" as const,
  path: "photo.png",
  absPath: "/safe/pet/photo.png",
  sessionId: "pet-external",
  mime: "image/png",
  originalName: "photo.png",
  origin: "im-gateway" as const,
  size: 4,
  sha256: "hash",
  createdAt: 1,
};

function resumeFollowUp(occurrence = 1): PetFollowUpWake {
  return {
    id: "wake-one",
    revision: 1,
    occurrence,
    title: "处理后续",
    text: "工作已完成",
    intent: "resume",
    sourceSessionId: "work-one",
  };
}

function makeHarness(overrides: Partial<PetDispatchOptions> = {}) {
  const nativeCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const externalCalls: Record<string, unknown>[] = [];
  const service = new PetDispatchService({
    metadata: { ensure: async () => ({ petSessionId: "pet-external" }) },
    aggregator: {
      getSnapshot: () => ({
        version: 1,
        generation: 1,
        workerState: "active",
        observedAt: 1,
        sessions: [],
        pending: [],
      }),
      resolveNavigation: async () => ({ status: "not-found" }),
    },
    worker: {
      requestWorker: async (method, params) => {
        nativeCalls.push({ method, params });
        return { ok: true, result: { text: "native reply", reason: "completed" } };
      },
    },
    externalRuntime: {
      run: async (params) => {
        externalCalls.push(params);
        return { ok: true, result: { text: "external reply", reason: "completed" } };
      },
      stop: async () => {},
      resetContext: async () => {},
    },
    hostCwd: "/safe/pet",
    managerModel: async () => "codex/gpt-6.1-sol",
    ...overrides,
  });
  return { service, nativeCalls, externalCalls };
}

describe("Mimi external manager execution", () => {
  test("passes the native Pet context unchanged and consumes the external host-action envelope", async () => {
    const externalCalls: Record<string, unknown>[] = [];
    const actions: Record<string, unknown>[] = [];
    const reply = {
      text: "已记下这张图片。",
      reason: "completed",
      extensions: {
        pet: {
          hostActions: [{ kind: "memory", payload: { action: "remember", text: "图片信息" } }],
        },
      },
    };
    const contextOptions: Partial<PetDispatchOptions> = {
      listWorkspaces: async () => [{ path: "/work/repo", name: "Repo" }],
      personalization: () => ({ responseLanguage: "简体中文", communicationStyle: "简洁" }),
      worldContext: () => ({ memories: [{ text: "保留上下文" }] }),
      hostActions: {
        memory: async (payload) => {
          actions.push(payload);
          return { id: "memory-one" };
        },
      },
    };
    const external = makeHarness({
      ...contextOptions,
      externalRuntime: {
        run: async (params) => {
          externalCalls.push(params);
          return { ok: true, result: reply };
        },
        stop: async () => {},
      },
    });
    const native = makeHarness({ ...contextOptions, managerModel: async () => "native-model" });
    const command: PetDispatchCommand = {
      type: "chat",
      message: "记住这张图",
      clientMessageId: "wechat-photo",
      source,
      attachments: [attachment],
    };
    const result = await external.service.dispatch(command);
    await native.service.dispatch(command);
    expect(result).toMatchObject({
      ok: true,
      type: "chat",
      result: reply,
      hostActions: [{ kind: "memory", ok: true, result: { id: "memory-one" } }],
    });
    expect(actions).toEqual([{ action: "remember", text: "图片信息" }]);
    expect(external.nativeCalls).toEqual([]);
    expect(native.externalCalls).toEqual([]);
    expect(externalCalls).toHaveLength(1);
    expect(externalCalls[0]).toEqual({
      ...native.nativeCalls[0]!.params,
      model: "codex/gpt-6.1-sol",
    });
    expect(externalCalls[0]).toMatchObject({
      behaviorMode: "pet",
      kind: "pet",
      sessionId: "pet-external",
      attachments: [attachment],
      profileParams: { hostActions: ["memory"] },
    });
  });

  test("an unavailable or failed external provider never calls the native worker", async () => {
    const unavailable = makeHarness({ externalRuntime: undefined });
    expect(
      await unavailable.service.dispatch({ type: "chat", message: "你好", clientMessageId: "one" }),
    ).toMatchObject({
      ok: false,
      code: "worker-error",
      message: expect.stringContaining("codex/"),
    });
    await expect(
      unavailable.service.reportSessionMessage({
        reportId: "a".repeat(32),
        sourceSessionId: "work-one",
        message: "已完成",
      }),
    ).rejects.toThrow("外部 provider");
    expect(unavailable.nativeCalls).toEqual([]);

    const failure = makeHarness({
      externalRuntime: {
        run: async () => ({ ok: false, message: "Codex 登录已失效" }),
        stop: async () => {},
      },
    });
    expect(await failure.service.dispatch({ type: "chat", message: "你好" })).toEqual({
      ok: false,
      code: "worker-error",
      message: "Codex 登录已失效",
    });
    expect(failure.nativeCalls).toEqual([]);

    let attempts = 0;
    const throwing = makeHarness({
      externalRuntime: {
        run: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("Codex 启动失败");
          return { ok: true, result: { text: "已恢复", reason: "completed" } };
        },
        stop: async () => {},
      },
    });
    expect(await throwing.service.dispatch({ type: "chat", message: "你好" })).toEqual({
      ok: false,
      code: "worker-error",
      message: "Codex 启动失败",
    });
    expect(await throwing.service.dispatch({ type: "chat", message: "重试" })).toMatchObject({
      ok: true,
      result: { text: "已恢复" },
    });
    expect(throwing.nativeCalls).toEqual([]);
  });

  test.each([
    { configured: "codex/gpt-6.1-sol", override: undefined, expected: "codex/gpt-6.1-sol" },
    {
      configured: "openrouter/auto",
      override: "claude-code/sonnet",
      expected: "claude-code/sonnet",
    },
  ])("follow-up discovery receives the pinned external model ($expected)", async (selection) => {
    const discoveredWith: Array<string | null | undefined> = [];
    const { service, nativeCalls, externalCalls } = makeHarness({
      managerModel: async () => selection.configured,
      listFollowUps: async (model) => {
        discoveredWith.push(model);
        return [];
      },
    });
    expect(
      await service.dispatch({
        type: "chat",
        message: "现在有哪些后续事项？",
        ...(selection.override ? { model: selection.override } : {}),
      }),
    ).toMatchObject({ ok: true, result: { text: "external reply" } });
    expect(discoveredWith).toEqual([selection.expected]);
    expect(externalCalls).toMatchObject([{ model: selection.expected }]);
    expect(nativeCalls).toEqual([]);
  });

  test("queues same-route input with source-scoped dedup and attachments instead of native steering", async () => {
    const firstStarted = deferred<void>();
    const first = deferred<RunResponse>();
    const calls: Record<string, unknown>[] = [];
    const { service, nativeCalls } = makeHarness({
      externalRuntime: {
        run: async (params) => {
          calls.push(params);
          if (params.clientMessageId === "first") {
            firstStarted.resolve();
            return first.promise;
          }
          return { ok: true, result: { text: "下一条回复", reason: "completed" } };
        },
        stop: async () => {},
      },
    });
    const running = service.dispatch({
      type: "chat",
      message: "等一等",
      clientMessageId: "first",
      source,
    });
    await firstStarted.promise;
    const secondCommand: PetDispatchCommand = {
      type: "chat",
      message: "还有这个",
      clientMessageId: "second",
      attachments: [attachment],
      source,
    };
    const second = service.dispatch(secondCommand);
    const duplicate = service.dispatch(secondCommand);
    const anotherSource = service.dispatch({
      ...secondCommand,
      source: { ...source, target: "other-chat" },
    });
    expect(await service.dispatch({ type: "get_global_status" })).toMatchObject({
      chatInputs: [
        { clientMessageId: "first", pending: false },
        { clientMessageId: "second", pending: true },
        { clientMessageId: "second", pending: true },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(nativeCalls).toEqual([]);
    first.resolve({ ok: true, result: { text: "第一条回复", reason: "completed" } });
    await running;
    expect(await second).toEqual(await duplicate);
    await anotherSource;
    expect(calls.map((params) => params.clientMessageId)).toEqual(["first", "second", "second"]);
    expect(calls.slice(1).map((params) => params.attachments)).toEqual([
      [attachment],
      [attachment],
    ]);
    expect(nativeCalls).toEqual([]);
    expect(await service.dispatch({ type: "get_global_status" })).toMatchObject({ chatInputs: [] });
  });

  test("stops the external run and admits the next input without cancelling the worker", async () => {
    const started = deferred<void>();
    const pending = deferred<RunResponse>();
    const stopped: string[] = [];
    let runs = 0;
    const { service, nativeCalls } = makeHarness({
      externalRuntime: {
        run: async () => {
          runs += 1;
          if (runs > 1) return { ok: true, result: { text: "继续", reason: "completed" } };
          started.resolve();
          return pending.promise;
        },
        stop: async (sessionId) => {
          stopped.push(sessionId);
          pending.resolve({ ok: true, result: { text: "", reason: "aborted_streaming" } });
        },
      },
    });
    const running = service.dispatch({ type: "chat", message: "等待", clientMessageId: "first" });
    await started.promise;
    expect(await service.dispatch({ type: "stop_chat", clientMessageId: "other" })).toMatchObject({
      stopped: false,
    });
    expect(await service.dispatch({ type: "stop_chat", clientMessageId: "first" })).toEqual({
      ok: true,
      type: "chat_stopped",
      stopped: true,
    });
    expect(await running).toMatchObject({ ok: true, result: { reason: "aborted_streaming" } });
    expect(await service.dispatch({ type: "chat", message: "继续" })).toMatchObject({
      ok: true,
      result: { text: "继续" },
    });
    expect(stopped).toEqual(["pet-external"]);
    expect(nativeCalls).toEqual([]);
  });

  test("queues an external override behind an active native turn without steering that worker", async () => {
    const started = deferred<void>();
    const pending = deferred<RunResponse>();
    const methods: string[] = [];
    const { service, externalCalls } = makeHarness({
      worker: {
        requestWorker: async (method) => {
          methods.push(method);
          started.resolve();
          if (method !== "agent/run") throw new Error("External input must not steer native");
          return pending.promise;
        },
      },
    });
    const native = service.dispatch({
      type: "chat",
      message: "原任务",
      model: "native-model",
      source,
    });
    await started.promise;
    const external = service.dispatch({ type: "chat", message: "使用默认 Codex", source });
    expect(await service.dispatch({ type: "get_global_status" })).toMatchObject({
      chatInputs: [{ pending: false }, { pending: true }],
    });
    expect(externalCalls).toEqual([]);
    pending.resolve({ ok: true, result: { text: "完成", reason: "completed" } });
    await native;
    expect(await external).toMatchObject({ ok: true, result: { text: "external reply" } });
    expect(methods).toEqual(["agent/run"]);
    expect(externalCalls).toMatchObject([{ model: "codex/gpt-6.1-sol" }]);
  });

  test("resolves the configured model for internal reports, closures, and host wake turns", async () => {
    const { service, nativeCalls, externalCalls } = makeHarness();
    await service.reportSessionMessage({
      reportId: "b".repeat(32),
      sourceSessionId: "work-one",
      message: "工作已完成",
    });
    await service.reportLongTaskClosure({
      schemaVersion: 1,
      id: "task-one",
      originClientMessageId: "original",
      objective: "完成工作",
      workspacePath: null,
      sessionId: "work-one",
      verificationMode: "turn",
      status: "completed",
      phase: "finalizing",
      attempt: 1,
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      artifacts: [],
      events: [],
    } as PetLongTask);
    await service.wakeFollowUp(resumeFollowUp());
    expect(externalCalls).toHaveLength(3);
    expect(externalCalls.every((params) => params.model === "codex/gpt-6.1-sol")).toBe(true);
    expect(externalCalls.every((params) => params.behaviorMode === "pet")).toBe(true);
    expect(externalCalls.every((params) => params.injected === true)).toBe(true);
    expect(nativeCalls).toEqual([]);
  });

  test("direct follow-up wakes retain internal admission and never steer or cancel a native worker", async () => {
    const started = deferred<void>();
    const pending = deferred<RunResponse>();
    const calls: Record<string, unknown>[] = [];
    const { service, nativeCalls } = makeHarness({
      externalRuntime: {
        run: async (params) => {
          calls.push(params);
          if (params.clientMessageId === "pet-followup-wake-one-1-1") {
            started.resolve();
            return pending.promise;
          }
          return { ok: true, result: { text: "用户回复", reason: "completed" } };
        },
        stop: async () => {
          throw new Error("Internal wake is not a user-cancellable chat turn");
        },
      },
    });
    const wake = service.wakeFollowUp(resumeFollowUp());
    await started.promise;
    const chat = service.dispatch({
      type: "chat",
      message: "接着说",
      clientMessageId: "after-wake",
    });
    expect(await service.dispatch({ type: "stop_chat" })).toEqual({
      ok: true,
      type: "chat_stopped",
      stopped: false,
    });
    expect(await service.dispatch({ type: "get_global_status" })).toMatchObject({
      chatInputs: [{ clientMessageId: "after-wake", pending: true }],
    });
    expect(calls).toHaveLength(1);
    pending.resolve({ ok: true, result: { text: "后续已核对", reason: "completed" } });
    expect(await wake).toEqual({ launched: false, text: "后续已核对" });
    expect(await chat).toMatchObject({ ok: true, result: { text: "用户回复" } });
    expect(calls.map((params) => params.model)).toEqual(["codex/gpt-6.1-sol", "codex/gpt-6.1-sol"]);
    expect(nativeCalls).toEqual([]);
  });

  test("direct follow-up wakes fail closed when the selected external manager is unavailable", async () => {
    const { service, nativeCalls } = makeHarness({ externalRuntime: undefined });
    await expect(service.wakeFollowUp(resumeFollowUp())).rejects.toThrow("外部 provider codex/");
    expect(await service.dispatch({ type: "get_global_status" })).toMatchObject({ chatInputs: [] });
    expect(nativeCalls).toEqual([]);
  });

  test("direct follow-up wakes retain the configured native manager model", async () => {
    const { service, nativeCalls, externalCalls } = makeHarness({
      managerModel: async () => "native-model",
    });
    expect(await service.wakeFollowUp(resumeFollowUp())).toEqual({
      launched: false,
      text: "native reply",
    });
    expect(nativeCalls).toMatchObject([
      { method: "agent/run", params: { model: "native-model", injected: true } },
    ]);
    expect(externalCalls).toEqual([]);
  });

  test.each(["codex/gpt-6.1-sol", "claude-code/sonnet"])(
    "repeating follow-up occurrences keep distinct external replay identities with %s",
    async (model) => {
      const calls: Record<string, unknown>[] = [];
      const replies = new Map<string, string>();
      const { service, nativeCalls } = makeHarness({
        managerModel: async () => model,
        externalRuntime: {
          run: async (params) => {
            calls.push(params);
            const id = String(params.clientMessageId);
            if (!replies.has(id)) replies.set(id, `Occurrence reply ${replies.size + 1}`);
            return { ok: true, result: { text: replies.get(id), reason: "completed" } };
          },
          stop: async () => {},
        },
      });
      expect(await service.wakeFollowUp(resumeFollowUp(100))).toEqual({
        launched: false,
        text: "Occurrence reply 1",
      });
      expect(await service.wakeFollowUp(resumeFollowUp(200))).toEqual({
        launched: false,
        text: "Occurrence reply 2",
      });
      expect(calls.map((params) => params.clientMessageId)).toEqual([
        "pet-followup-wake-one-1-100",
        "pet-followup-wake-one-1-200",
      ]);
      expect(calls.every((params) => params.model === model && params.injected === true)).toBe(
        true,
      );
      expect(nativeCalls).toEqual([]);
    },
  );

  test("pins an explicit model for the chat and its read-only launch receipt", async () => {
    const calls: Record<string, unknown>[] = [];
    const { service, nativeCalls } = makeHarness({
      listWorkspaces: async () => [{ path: "/work/repo", name: "Repo" }],
      startWorkSession: async () => {
        throw new Error("launch rejected");
      },
      externalRuntime: {
        run: async (params) => {
          calls.push(params);
          if (params.injected)
            return { ok: true, result: { text: "未能启动", reason: "completed" } };
          const workspace = (params.petWorkspaces as Array<{ id: string; name: string }>).find(
            (item) => item.name === "Repo",
          )!;
          return {
            ok: true,
            result: {
              text: "正在启动",
              reason: "completed",
              petWorkDelegation: { workspaceId: workspace.id, objective: "完成工作" },
            },
          };
        },
        stop: async () => {},
      },
    });
    expect(
      await service.dispatch({
        type: "chat",
        message: "完成工作",
        clientMessageId: "launch-one",
        model: "claude-code/sonnet",
      }),
    ).toMatchObject({
      ok: true,
      result: { text: "未能启动" },
      delegationError: expect.stringContaining("launch rejected"),
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((params) => params.model === "claude-code/sonnet")).toBe(true);
    expect(calls[1]).toMatchObject({ injected: true, toolAllowlist: [], skillAllowlist: [] });
    expect(nativeCalls).toEqual([]);
  });

  test("clears external context without executing a model, and fails closed if reset is unavailable", async () => {
    const resets: string[] = [];
    let segmentClears = 0;
    const segmentController = {
      beginTurn: async () => undefined,
      requestContextClear: async () => {
        segmentClears += 1;
      },
      completeSegmentClosure: async () => {},
      onDelegationClosed: async () => {},
    };
    const { service, nativeCalls, externalCalls } = makeHarness({
      segmentController,
      externalRuntime: {
        run: async () => {
          throw new Error("A context clear must not execute a model");
        },
        stop: async () => {},
        resetContext: async (sessionId) => {
          resets.push(sessionId);
        },
      },
    });
    expect(await service.dispatch({ type: "chat", message: "/clear" })).toMatchObject({
      ok: true,
      contextCleared: true,
    });
    expect(resets).toEqual(["pet-external"]);
    expect(segmentClears).toBe(1);
    expect(nativeCalls).toEqual([]);
    expect(externalCalls).toEqual([]);
    const unavailable = makeHarness({ externalRuntime: undefined, segmentController });
    expect(await unavailable.service.dispatch({ type: "chat", message: "/clear" })).toMatchObject({
      ok: false,
      code: "worker-error",
      message: expect.stringContaining("外部 provider"),
    });
    expect(segmentClears).toBe(1);
    expect(unavailable.nativeCalls).toEqual([]);
  });

  test("an explicit native model retains worker routing even with an external default", async () => {
    const { service, nativeCalls, externalCalls } = makeHarness();
    expect(
      await service.dispatch({ type: "chat", message: "你好", model: "openrouter/auto" }),
    ).toMatchObject({ ok: true, result: { text: "native reply" } });
    expect(nativeCalls).toMatchObject([
      { method: "agent/run", params: { model: "openrouter/auto" } },
    ]);
    expect(externalCalls).toEqual([]);
  });
});

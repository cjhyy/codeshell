import { describe, expect, test } from "bun:test";
import type { WorkerFrameMeta } from "@cjhyy/code-shell-server/worker";
import type { AgentBridge } from "../agent-bridge.js";
import { SessionSnapshotStore } from "../SessionSnapshotStore.js";
import { prepareAgentRunMetadata } from "../agent-run-metadata.js";
import type { SessionCwdIndexEntry } from "../session-cwd-index.js";
import { MobileExternalRuntimeCommands } from "./external-runtime-commands.js";
import { MobilePermissionModes } from "./permission-modes.js";
import {
  agentRunTimeoutMs,
  handleClientEvent,
  injectAndAwaitResult,
  type OrchestratorCtx,
} from "./handle-client-event.js";

type OutboundListener = (line: string) => void;

function createHarness(options: {
  requestedWorkspaceRoot: string;
  lookupSession: (refresh: boolean) => SessionCwdIndexEntry | undefined;
}) {
  const outbound = new Set<OutboundListener>();
  const replies: Array<Record<string, unknown>> = [];
  const preparedRuns: Array<Record<string, unknown>> = [];
  const metas: WorkerFrameMeta[] = [];

  const emit = (message: Record<string, unknown>): void => {
    const line = JSON.stringify(message);
    for (const listener of outbound) listener(line);
  };
  const bridge = {
    getLastRunContext: () => ({}),
    subscribeOutbound: (listener: OutboundListener) => {
      outbound.add(listener);
      return () => outbound.delete(listener);
    },
    injectWorkerMessage: (line: string, meta: WorkerFrameMeta) => {
      metas.push(meta);
      const request = JSON.parse(line) as { id: string };
      try {
        const prepared = prepareAgentRunMetadata(line, meta, {
          isProjectTrusted: () => true,
          lookupSession: (_sessionId, refresh) => options.lookupSession(refresh),
          isNoRepoCwd: () => false,
        });
        preparedRuns.push(JSON.parse(prepared.outLine).params as Record<string, unknown>);
        queueMicrotask(() =>
          emit({ method: "agent/runAccepted", params: { requestId: request.id } }),
        );
      } catch (error) {
        queueMicrotask(() =>
          emit({
            id: request.id,
            error: {
              code: -32602,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
      }
    },
  } as unknown as AgentBridge;

  const state = {
    selectedSessionId: "session-1",
    selectedCwd: "/primary",
  };
  const ctx = {
    remote: {
      sendToDevice: (_deviceId: string, event: Record<string, unknown>) => replies.push(event),
      broadcast: (event: Record<string, unknown>) => replies.push(event),
    },
    uploads: {
      claim: () => {
        throw new Error("unexpected upload claim");
      },
      release: async () => undefined,
      finalize: async () => undefined,
    },
    getBridge: () => bridge,
    mobileSessionCwds: new Map(),
    mobilePermissionModes: new Map(),
    deviceState: () => state,
    ensureMobileSessionId: () => "session-1",
    lookupDiskSessionCwd: async () => undefined,
    effectiveMobileRunCwd: () => "/primary",
    validateMobileSessionCwd: async () => true,
    resolveSessionWorkspaceRoot: async () => options.requestedWorkspaceRoot,
    sendMobilePermissionMode: () => undefined,
    sendSelectedMobilePermissionModes: () => undefined,
    replayPendingMobileApprovals: () => undefined,
    broadcastDesktopPermissionMode: () => undefined,
    broadcastMobileSession: () => undefined,
    broadcastApprovalResolved: () => undefined,
    settleMobileUploadClaims: async () => undefined,
  } as unknown as OrchestratorCtx;

  return { ctx, metas, preparedRuns, replies };
}

async function sendChat(ctx: OrchestratorCtx): Promise<void> {
  await handleClientEvent(ctx, {
    type: "chat.send",
    deviceId: "phone-1",
    sessionId: "session-1",
    text: "continue",
  });
}

test("mobile default intent survives a desktop snapshot during external preparation", async () => {
  const harness = createHarness({
    requestedWorkspaceRoot: "/worktree",
    lookupSession: () => undefined,
  });
  const observed: unknown[] = [];
  harness.ctx.mobilePermissionModes.set("session-1", "bypassPermissions");
  harness.ctx.broadcastMobileSession = (meta) => observed.push(meta);
  harness.ctx.externalCommands = {
    observe: () => undefined,
    isExternal: () => true,
    prepare: async (_viewer: string, _device: string, _session: string, input: unknown) => {
      observed.push(input);
      harness.ctx.mobilePermissionModes.set("session-1", "bypassPermissions");
      return {
        cwd: "/worktree",
        submit: async (request: unknown) => {
          observed.push(request);
          return { ok: true };
        },
      };
    },
  } as unknown as MobileExternalRuntimeCommands;
  (harness.ctx.remote as any).sendToViewer = (_viewer: string, event: Record<string, unknown>) =>
    harness.replies.push(event);
  await handleClientEvent(harness.ctx, {
    type: "chat.send",
    deviceId: "phone-1",
    viewerId: "tab",
    sessionId: "session-1",
    text: "fixture",
    modelKey: "codex/gpt-test",
    permissionMode: "default",
  } as Parameters<typeof handleClientEvent>[1]);
  expect(observed).toHaveLength(3);
  expect(observed[0]).toMatchObject({ permissionMode: "default" });
  expect(observed[1]).toMatchObject({ params: { permissionMode: "default" } });
  expect(observed[2]).toMatchObject({ permissionMode: "default" });
});

for (const previousSelection of [false, true]) {
  test(`creation pins explicit default across adoption snapshots (previous selection: ${previousSelection})`, async () => {
    const harness = createHarness({
      requestedWorkspaceRoot: "/worktree",
      lookupSession: () => undefined,
    });
    const modes = new MobilePermissionModes();
    harness.ctx.mobilePermissionModes = modes;
    const device = harness.ctx.deviceState("phone-1");
    if (previousSelection) {
      device.permissionMode = "bypassPermissions";
      await handleClientEvent(harness.ctx, {
        type: "permission.setMode",
        deviceId: "phone-1",
        sessionId: "session-1",
        mode: "default",
      });
    }
    await handleClientEvent(harness.ctx, {
      type: "session.create",
      deviceId: "phone-1",
      projectId: null,
      permissionMode: "default",
    });
    const createdId = device.sessionId!;
    expect(createdId).toStartWith("mobile-");
    expect(modes.get(createdId)).toBe("default");
    modes.replaceDesktopSnapshot([]);
    modes.replaceDesktopSnapshot([{ sessionId: createdId, mode: "bypassPermissions" }]);
    expect(modes.get(createdId)).toBe("default");
    modes.replaceDesktopSnapshot([{ sessionId: createdId, mode: "default" }]);
    modes.replaceDesktopSnapshot([{ sessionId: createdId, mode: "acceptEdits" }]);
    expect(modes.get(createdId)).toBe("acceptEdits");
  });
}

test("ambiguous Mobile admission emits chat.uncertain instead of a definite error", async () => {
  const harness = createHarness({
    requestedWorkspaceRoot: "/worktree",
    lookupSession: () => undefined,
  });
  harness.ctx.externalCommands = {
    observe: () => undefined,
    isExternal: () => true,
    prepare: async () => ({
      cwd: "/worktree",
      submit: async () => ({ ok: false, uncertain: true, message: "Admission not confirmed" }),
    }),
  } as unknown as MobileExternalRuntimeCommands;
  (harness.ctx.remote as any).sendToViewer = (_viewer: string, event: Record<string, unknown>) =>
    harness.replies.push(event);
  await handleClientEvent(harness.ctx, {
    type: "chat.send",
    deviceId: "phone-1",
    viewerId: "tab",
    sessionId: "session-1",
    text: "run once",
    clientMessageId: "stable-intent",
  });
  expect(harness.replies).toEqual([
    {
      type: "chat.uncertain",
      sessionId: "session-1",
      clientMessageId: "stable-intent",
      message: "Admission not confirmed",
    },
  ]);
  expect(harness.preparedRuns).toHaveLength(0);
});

test("actual Mobile dispatcher preserves the selected native producer and rejects an unselected explicit Session", async () => {
  const harness = createHarness({
    requestedWorkspaceRoot: "/worktree",
    lookupSession: () => ({
      sessionId: "session-1",
      cwd: "/primary",
      workspaceRoot: "/worktree",
      status: "confirmed",
    }),
  });
  harness.ctx.externalCommands = new MobileExternalRuntimeCommands({
    authenticated: (viewer, device) => viewer === "tab" && device === "phone-1",
    authority: async () => ({ stamp: "native-incarnation", cwd: "/worktree", assertCurrent() {} }),
    owner: () => undefined,
    service: () => null,
    isExternal: () => false,
    exists: () => true,
    attachmentPath: async (path) => path,
  });
  (harness.ctx.remote as any).sendToViewer = (_viewer: string, event: Record<string, unknown>) =>
    harness.replies.push(event);
  const event = {
    type: "chat.send" as const,
    viewerId: "tab",
    deviceId: "phone-1",
    sessionId: "session-1",
    text: "continue",
  };
  await handleClientEvent(harness.ctx, event);
  expect(harness.preparedRuns).toHaveLength(0);
  expect(harness.replies.some((item) => item.type === "error")).toBe(true);
  await handleClientEvent(harness.ctx, {
    type: "session.select",
    viewerId: "tab",
    deviceId: "phone-1",
    sessionId: "session-1",
  });
  await handleClientEvent(harness.ctx, event);
  expect(harness.preparedRuns).toHaveLength(1);
  expect(harness.preparedRuns[0]?.cwd).toBe("/worktree");
  expect(harness.replies.some((item) => item.type === "chat.accepted")).toBe(true);
});

describe("mobile existing-session workspace authorization", () => {
  test("continues a worktree Session using its resolved workspace root", async () => {
    const harness = createHarness({
      requestedWorkspaceRoot: "/worktree",
      lookupSession: () => ({
        sessionId: "session-1",
        cwd: "/primary",
        workspaceRoot: "/worktree",
        status: "confirmed",
      }),
    });

    await sendChat(harness.ctx);

    expect(harness.preparedRuns).toHaveLength(1);
    expect(harness.preparedRuns[0]?.cwd).toBe("/worktree");
    expect(harness.metas).toEqual([{ origin: "mobile", producer: "mobile-chat" }]);
    expect(harness.replies.some((event) => event.type === "chat.accepted")).toBe(true);
  });

  test("refreshes one stale index entry and accepts the new worktree root", async () => {
    let refreshes = 0;
    const harness = createHarness({
      requestedWorkspaceRoot: "/worktree-new",
      lookupSession: (refresh) => {
        if (refresh) refreshes += 1;
        return {
          sessionId: "session-1",
          cwd: "/primary",
          workspaceRoot: refresh ? "/worktree-new" : "/worktree-old",
          status: "confirmed",
        };
      },
    });

    await sendChat(harness.ctx);

    expect(refreshes).toBe(1);
    expect(harness.preparedRuns[0]?.cwd).toBe("/worktree-new");
    expect(harness.replies.some((event) => event.type === "chat.accepted")).toBe(true);
  });

  test("rejects when both cached and refreshed Session roots mismatch", async () => {
    let refreshes = 0;
    const harness = createHarness({
      requestedWorkspaceRoot: "/forged",
      lookupSession: (refresh) => {
        if (refresh) refreshes += 1;
        return {
          sessionId: "session-1",
          cwd: "/primary",
          workspaceRoot: refresh ? "/worktree-disk" : "/worktree-old",
          status: "confirmed",
        };
      },
    });

    await sendChat(harness.ctx);

    expect(refreshes).toBe(1);
    expect(harness.preparedRuns).toHaveLength(0);
    expect(harness.replies).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("does not match"),
      }),
    );
    expect(harness.replies.some((event) => event.type === "chat.accepted")).toBe(false);
  });
});

describe("injectAndAwaitResult timeouts", () => {
  /** A bridge whose worker never answers, so only the timeout can settle. */
  function silentBridge() {
    const injected: string[] = [];
    return {
      injected,
      bridge: {
        subscribeOutbound: () => () => undefined,
        injectWorkerMessage: (line: string) => {
          injected.push(line);
        },
      } as unknown as AgentBridge,
    };
  }

  const meta: WorkerFrameMeta = { origin: "host", producer: "test" };

  test("gives a full agent turn far longer than a control op before declaring no response", async () => {
    // agent/run drives a whole Mimi turn (delegate + describe + inference).
    // The old blanket 5s killed live turns and surfaced them to the user as
    // "worker did not respond", so it must get a turn-scale budget.
    expect(agentRunTimeoutMs("agent/run")).toBeGreaterThanOrEqual(120_000);
    // Control ops stay snappy: the phone should not spin for two minutes on a
    // bad model name.
    expect(agentRunTimeoutMs("agent/configure")).toBeLessThanOrEqual(15_000);
    expect(agentRunTimeoutMs("agent/goalExtend")).toBeLessThanOrEqual(15_000);
  });

  test("still reports a non-answering worker once its budget elapses", async () => {
    const { bridge, injected } = silentBridge();
    const result = await injectAndAwaitResult(bridge, "agent/configure", { model: "x" }, meta, 20);
    expect(result).toEqual({ ok: false, message: "worker did not respond" });
    expect(injected).toHaveLength(1);
  });

  test("a failed worker write reports a retryable error and releases its subscription", async () => {
    let listening = false;
    const bridge = {
      subscribeOutbound: () => {
        listening = true;
        return () => {
          listening = false;
        };
      },
      injectWorkerMessage: () => {
        throw new Error("Worker disconnected");
      },
    } as unknown as AgentBridge;
    const result = await injectAndAwaitResult(bridge, "agent/approve", {}, meta);
    expect(result).toEqual({ ok: false, message: "Worker disconnected" });
    expect(listening).toBe(false);
  });
});

describe("mobile question answer acknowledgment", () => {
  for (const success of [true, false]) {
    test(`only resolves an answer after worker acceptance (success: ${success})`, async () => {
      const harness = createHarness({
        requestedWorkspaceRoot: "/primary",
        lookupSession: () => undefined,
      });
      const outbound = new Set<OutboundListener>();
      const requests: Array<{ id: string; params: Record<string, unknown> }> = [];
      const resolved: Record<string, unknown>[] = [];
      harness.ctx.broadcastApprovalResolved = (value) => {
        resolved.push(value);
      };
      harness.ctx.getBridge = () =>
        ({
          getLastRunContext: () => ({}),
          subscribeOutbound: (listener: OutboundListener) => {
            outbound.add(listener);
            return () => {
              outbound.delete(listener);
            };
          },
          injectWorkerMessage: (line: string) => {
            requests.push(JSON.parse(line));
          },
        }) as unknown as AgentBridge;
      const submitted = handleClientEvent(harness.ctx, {
        type: "approval.respond",
        deviceId: "phone-1",
        sessionId: "session-1",
        approvalId: "async-question",
        decision: "approve",
        answer: "Read only",
      });
      expect(requests).toHaveLength(1);
      expect(resolved).toEqual([]);
      expect(requests[0]?.params).toEqual({
        sessionId: "session-1",
        requestId: "async-question",
        decision: { approved: true, answer: "Read only" },
      });
      const response = {
        id: requests[0]!.id,
        ...(success ? { result: {} } : { error: { code: -32602, message: "Question expired" } }),
      };
      for (const listener of outbound) listener(JSON.stringify(response));
      await submitted;
      expect(resolved).toEqual(
        success
          ? [
              {
                requestId: "async-question",
                sessionId: "session-1",
                approved: true,
                answer: "Read only",
              },
            ]
          : [],
      );
      expect(harness.replies).toEqual(
        success
          ? []
          : [
              {
                type: "error",
                approvalId: "async-question",
                message: "Question expired",
              },
            ],
      );
      expect(outbound.size).toBe(0);
    });
  }
});

test("session creation echoes optional browser correlation while legacy clients keep the original reply", async () => {
  const harness = createHarness({
    requestedWorkspaceRoot: "/primary",
    lookupSession: () => undefined,
  });
  await handleClientEvent(harness.ctx, {
    type: "session.create",
    deviceId: "phone-1",
    cwd: "/primary",
    clientRequestId: "browser-create-1",
  });
  expect(harness.replies.find((event) => event.type === "chat.accepted")).toMatchObject({
    clientRequestId: "browser-create-1",
    cwd: "/primary",
  });
  harness.replies.length = 0;
  await handleClientEvent(harness.ctx, {
    type: "session.create",
    deviceId: "phone-1",
    cwd: "/primary",
  });
  expect(harness.replies.find((event) => event.type === "chat.accepted")).not.toHaveProperty(
    "clientRequestId",
  );
});

test("session creation validation and authority failures retain correlation and the previous device selection", async () => {
  for (const failure of ["target", "authority", "created"] as const) {
    const harness = createHarness({
      requestedWorkspaceRoot: "/primary",
      lookupSession: () => undefined,
    });
    const previous = { ...harness.ctx.deviceState("phone-1") };
    if (failure === "target") harness.ctx.validateMobileSessionCwd = async () => false;
    else {
      harness.ctx.externalCommands = {
        observe: () => undefined,
        created: () => {
          if (failure === "created") throw new Error("creation revoked");
        },
      } as unknown as MobileExternalRuntimeCommands;
      harness.ctx.newSessionAuthority = () => {
        if (failure === "authority") throw new Error("project removed");
        return {
          cwd: "/primary",
          stamp: "valid",
          projectId: undefined,
          rootId: undefined,
          assertCurrent: () => {},
        };
      };
    }
    await handleClientEvent(harness.ctx, {
      type: "session.create",
      deviceId: "phone-1",
      viewerId: "viewer-1",
      cwd: "/primary",
      clientRequestId: `failed-${failure}`,
    });
    expect(harness.replies).toHaveLength(1);
    expect(harness.replies[0]).toMatchObject({
      type: "error",
      clientRequestId: `failed-${failure}`,
    });
    expect(harness.ctx.deviceState("phone-1")).toEqual(previous);
    expect(harness.ctx.mobileSessionCwds.size).toBe(0);
  }
});

describe("mobile snapshot epoch recovery", () => {
  function snapshotHarness(legacyServer = false) {
    const harness = createHarness({
      requestedWorkspaceRoot: "/primary",
      lookupSession: () => undefined,
    });
    const store = new SessionSnapshotStore();
    store.append("session-1", { type: "session_started" });
    store.append("session-1", { type: "text_delta", delta: "new answer" });
    store.append("session-1", { type: "turn_complete" });
    const cursors: number[] = [];
    const approvalReplays: Array<[string, string | undefined]> = [];
    harness.ctx.getBridge = () =>
      ({
        getLastRunContext: () => ({}),
        getSnapshot: (sessionId: string, sinceSeq: number) => {
          cursors.push(sinceSeq);
          const snapshot = store.get(sessionId, sinceSeq);
          if (!legacyServer) return snapshot;
          const { epoch: _epoch, ...legacy } = snapshot;
          return legacy;
        },
      }) as unknown as AgentBridge;
    harness.ctx.replayPendingMobileApprovals = (sessionId, deviceId) => {
      approvalReplays.push([sessionId, deviceId]);
    };
    return { ...harness, store, cursors, approvalReplays };
  }

  test("replays the new Main snapshot when a previous lifetime supplied a higher cursor", async () => {
    const harness = snapshotHarness();
    await handleClientEvent(harness.ctx, {
      type: "session.sync",
      deviceId: "phone-1",
      sessionId: "session-1",
      sinceSeq: 100,
      epoch: "previous-main-lifetime",
    });
    expect(harness.cursors).toEqual([100, 0]);
    expect(harness.replies).toEqual([
      {
        type: "session.snapshot",
        sessionId: "session-1",
        entries: harness.store.get("session-1").events,
        nextSeq: 4,
        epoch: harness.store.epoch,
      },
    ]);
    expect(harness.approvalReplays).toEqual([["session-1", "phone-1"]]);
  });

  test("keeps incremental filtering inside the same Main lifetime", async () => {
    const harness = snapshotHarness();
    await handleClientEvent(harness.ctx, {
      type: "session.sync",
      deviceId: "phone-1",
      sessionId: "session-1",
      sinceSeq: 1,
      epoch: harness.store.epoch,
    });
    expect(harness.cursors).toEqual([1]);
    expect(harness.replies[0]).toEqual({
      type: "session.snapshot",
      sessionId: "session-1",
      entries: harness.store.get("session-1", 1).events,
      nextSeq: 4,
      epoch: harness.store.epoch,
    });
  });

  test("accepts a legacy client cursor and advertises the current epoch", async () => {
    const harness = snapshotHarness();
    await handleClientEvent(harness.ctx, {
      type: "session.sync",
      deviceId: "phone-1",
      sessionId: "session-1",
      sinceSeq: 1,
    });
    expect(harness.cursors).toEqual([1]);
    expect(harness.replies[0]).toMatchObject({
      entries: harness.store.get("session-1", 1).events,
      epoch: harness.store.epoch,
    });
  });

  test("does not infer an epoch mismatch when a legacy snapshot has no epoch", async () => {
    const harness = snapshotHarness(true);
    await handleClientEvent(harness.ctx, {
      type: "session.sync",
      deviceId: "phone-1",
      sessionId: "session-1",
      sinceSeq: 1,
      epoch: "known-client-lifetime",
    });
    expect(harness.cursors).toEqual([1]);
    expect(harness.replies[0]).toEqual({
      type: "session.snapshot",
      sessionId: "session-1",
      entries: harness.store.get("session-1", 1).events,
      nextSeq: 4,
    });
  });

  test("returns the new epoch even when the restarted Main has no session events yet", async () => {
    const harness = snapshotHarness();
    await handleClientEvent(harness.ctx, {
      type: "session.sync",
      deviceId: "phone-1",
      sessionId: "empty-session",
      sinceSeq: 100,
      epoch: "previous-main-lifetime",
    });
    expect(harness.replies[0]).toEqual({
      type: "session.snapshot",
      sessionId: "empty-session",
      entries: [],
      nextSeq: 1,
      epoch: harness.store.epoch,
    });
  });
});

test("legacy base dispatch awaits the selected recovery host without entering worker command routing", async () => {
  const { ctx, metas } = createHarness({
    requestedWorkspaceRoot: "/fixture",
    lookupSession: () => undefined,
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: unknown[] = [];
  ctx.outputRecovery = {
    handle: async (event: unknown) => {
      seen.push(event);
      await pending;
      return false;
    },
  } as any;
  let finished = false;
  const work = handleClientEvent(ctx, {
    type: "session.legacyBase",
    sessionId: "s",
    recoveryId: "r",
    requestId: "p",
    throughEventId: "base",
    deviceId: "phone",
    viewerId: "tab",
  } as any).then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(seen).toHaveLength(1);
  release();
  await work;
  expect(metas).toEqual([]);
});

test("explicit external model routes through external submit and advertises recovery without native dispatch", async () => {
  const harness = createHarness({
    requestedWorkspaceRoot: "/worktree",
    lookupSession: () => undefined,
  });
  const prepared: unknown[] = [];
  harness.ctx.externalCommands = {
    observe: () => undefined,
    isExternal: () => false,
    prepare: async (...args: unknown[]) => {
      prepared.push(args);
      return { cwd: "/worktree", modelKey: "codex/test", submit: async () => ({ ok: true }) };
    },
  } as unknown as MobileExternalRuntimeCommands;
  (harness.ctx.remote as any).sendToViewer = (_viewer: string, event: Record<string, unknown>) =>
    harness.replies.push(event);
  await handleClientEvent(harness.ctx, {
    type: "chat.send",
    viewerId: "tab",
    deviceId: "phone-1",
    sessionId: "session-1",
    text: "continue",
    clientMessageId: "runtime-input",
    modelKey: "codex/test",
  });
  expect(prepared).toHaveLength(1);
  expect(harness.preparedRuns).toHaveLength(0);
  expect(harness.replies.find((event) => event.type === "chat.accepted")).toMatchObject({
    modelKey: "codex/test",
    clientMessageId: "runtime-input",
  });
});

test("external model cannot be configured as the native worker's global model", async () => {
  const harness = createHarness({
    requestedWorkspaceRoot: "/worktree",
    lookupSession: () => undefined,
  });
  await handleClientEvent(harness.ctx, {
    type: "model.set",
    deviceId: "phone-1",
    model: "claude-code/sonnet",
  });
  expect(harness.preparedRuns).toHaveLength(0);
  expect(harness.replies[0]?.type).toBe("error");
});

test("external model discovery answers failure with an empty bounded response", async () => {
  const harness = createHarness({
    requestedWorkspaceRoot: "/worktree",
    lookupSession: () => undefined,
  });
  (harness.ctx.remote as any).hasAuthenticatedViewer = () => true;
  (harness.ctx.remote as any).sendToViewer = (_viewer: string, event: Record<string, unknown>) =>
    harness.replies.push(event);
  harness.ctx.externalRuntimeModels = async () => {
    throw new Error("unavailable");
  };
  await handleClientEvent(harness.ctx, {
    type: "runtime.models",
    viewerId: "tab",
    deviceId: "phone-1",
  });
  expect(harness.replies).toHaveLength(1);
  expect(harness.replies[0]).toMatchObject({ type: "runtime.models.ok", models: [] });
});
